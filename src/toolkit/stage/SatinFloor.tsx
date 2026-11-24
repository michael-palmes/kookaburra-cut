import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  type Camera,
  Color,
  CustomBlending,
  DataTexture,
  DepthTexture,
  type DirectionalLight,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { createSeededRandom } from "../../engine/rng";
import { useSceneRelease } from "../../engine/sceneRelease";
import { createFrameShare, supersampleSeed } from "../../engine/supersample";
import { createRenderOnce } from "./renderOnce";
import { SHADOW_FAR, SHADOW_FRUSTUM_EXTENT, SHADOW_NEAR } from "./shadowRig";

/** A satin stage floor (the `satin` backdrop): a planar reflection blurred with the height of what it reflects, an albedo and sheen that fade with distance, blended over whatever is behind so it dissolves into the background, sparse glitter flakes, and floor-only pools standing in for caustics. Deterministic: fixed passes, no history. */

type V2 = [number, number];

/** Glossy flakes in the satin, from a mipmapped flake map the GPU filters, so distant or grazing flakes average into a metallic sheen instead of reshuffling from frame to frame. */
export interface FloorGlitter {
  /** Flakes per world unit; a phone is about four units tall, so 30 gives flakes of under a millimetre. */
  scale: number;
  /** Share of the surface that is flake. */
  density: number;
  roughness: number;
  /** How far each flake's normal tilts. */
  tilt: number;
  weight: number;
  /** How much the satin's sheen varies grain to grain, 0 to 1. */
  grain: number;
  seed: number;
}

/** A soft warm patch the floor alone receives, such as light thrown off a polished rail. */
export interface FloorPool {
  at: V2;
  radius: V2;
  angleDeg?: number;
  color: string;
  intensity: number;
}

export interface SatinFloorProps {
  y: number;
  color: string;
  roughness?: number;
  /** Dielectric reflectance, 0.5 being the usual 4%. */
  specular?: number;
  centre?: V2;
  /** The floor dissolves into what is behind it between these radii. */
  fade?: V2;
  reflection?: {
    strength?: number;
    /** Blur at full height, in pixels of a 1080p frame, so preview and export match. */
    blur?: number;
    /** Height above the floor over which a reflection goes from sharp to fully blurred. */
    heightBlur?: number;
    /** Share of the blur kept even at the contact: satin is never a true mirror. */
    contact?: number;
    /** Reflection resolution against the frame. */
    scale?: number;
    /** How much longer the blur runs down the frame than across it: a rough floor seen at a low angle smears its reflections towards the viewer. */
    stretch?: number;
    /** The surface's grain breaks the reflection up by this many pixels of a 1080p frame. */
    scatter?: number;
    /** Height above the floor at which a reflection has faded out. */
    reach?: number;
  };
  /** How the floor takes a directional light's shadow: an edge that widens and a tone that lightens with distance from what casts it, and a darkening where something meets the floor. */
  shadow?: FloorShadow;
  glitter?: Partial<FloorGlitter>;
  pools?: FloorPool[];
}

export interface FloorShadow {
  /** Edge width gained per unit of distance between caster and floor: the light's apparent size. */
  spread?: number;
  /** Share of the shadow lost by `reach`. */
  lighten?: number;
  reach?: number;
  /** Darkening where something meets the floor; it reads the mirror, so it needs the reflection on. */
  contact?: number;
  /** Share of the reflection lost where something meets the floor: the dark seam a standing object leaves. */
  occlusion?: number;
  /** Height of what is reflected over which that seam fades. */
  occlusionReach?: number;
}

const SHADOW_DEFAULTS: Required<FloorShadow> = {
  spread: 0.12,
  lighten: 0.5,
  reach: 5,
  contact: 0,
  occlusion: 0,
  occlusionReach: 0.12,
};
/** Soft shadow taps and reaches: export contract once shipped. */
const SHADOW_SEARCH_TAPS = 16;
const SHADOW_FILTER_TAPS = 40;
const SHADOW_SEARCH_GAP = 6;
const SHADOW_MIN_TEXELS = 1.5;
/** Shadow depth a caster must clear the floor by to count: above the half-float map's own steps. */
const SHADOW_SEARCH_EPS = "0.002";
const CONTACT_REACH = 0.3;
/** The scatter reads the grain this many times finer than the sheen does. */
const SCATTER_FINE = 4;
const REACH_TAPS = 8;
const REACH_SPREAD = 0.6;
/** The seam's softening, in pixels of a 1080p frame: export contract once shipped. */
const OCCLUSION_SPREAD = 8;
const MAX_POOLS = 4;
/** How far the plane reaches past the fade: its edge never shows. */
const PLANE_MARGIN = 1;
const BLUR_TAPS = 12;

const GLITTER_DEFAULTS: FloorGlitter = {
  scale: 30,
  density: 0,
  roughness: 0.15,
  tilt: 0.5,
  weight: 1,
  grain: 0,
  seed: 5,
};
/** Flake map size, texels: export contract once shipped. */
const FLAKE_SIZE = 512;

/** Flake (r), its tilt (g, b, 0.5 being flat) and the satin's grain (a), seeded. */
function flakeMap(density: number, seed: number): DataTexture {
  const rand = createSeededRandom(seed);
  const data = new Uint8Array(FLAKE_SIZE * FLAKE_SIZE * 4);
  for (let i = 0; i < FLAKE_SIZE * FLAKE_SIZE; i++) {
    const k = i * 4;
    const flake = rand() < density;
    data[k] = flake ? 255 : 0;
    data[k + 1] = flake ? Math.round(rand() * 255) : 128;
    data[k + 2] = flake ? Math.round(rand() * 255) : 128;
    data[k + 3] = Math.round(rand() * 255);
  }
  const tex = new DataTexture(data, FLAKE_SIZE, FLAKE_SIZE, RGBAFormat);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
const REFLECTION_SAMPLES = 4;

const VERTEX_PARS = /* glsl */ `
uniform mat4 kbReflMatrix;
varying vec3 vKbWorld;
varying vec4 vKbRefl;
`;

const VERTEX = /* glsl */ `
vKbWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vKbRefl = kbReflMatrix * vec4( vKbWorld, 1.0 );
`;

const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D kbReflSharp;
uniform sampler2D kbReflBlur;
uniform sampler2D kbReflDepth;
uniform float kbReflOn;
uniform float kbReflStrength;
uniform float kbHeightBlur;
uniform float kbContact;
uniform vec3 kbVirtualEye;
uniform vec3 kbVirtualForward;
uniform vec2 kbNearFar;
uniform vec2 kbCentre;
uniform vec2 kbFade;
uniform sampler2D kbFlakeMap;
uniform vec4 kbGlitter;
uniform float kbGrain;
uniform vec4 kbPoolA[ ${MAX_POOLS} ];
uniform vec4 kbPoolB[ ${MAX_POOLS} ];
uniform int kbPoolCount;
varying vec3 vKbWorld;
varying vec4 vKbRefl;
`;

const SOFT_FRAGMENT_PARS = /* glsl */ `
uniform vec4 kbShadowA;
uniform vec4 kbShadowB;
uniform vec3 kbReflX;
uniform vec2 kbReflSpread;
uniform vec2 kbShadowSlope;
uniform vec2 kbOcclusion;
uniform vec2 kbOcclusionSpread;
uniform float kbOblique;
uniform float kbSeed;
// The mirror clips at the floor, so its depth is the height above the floor over the distance along the view.
float kbHeightAt( float depth, vec3 ray, float toFloor ) {
	float left = abs( ray.y ) - depth * kbOblique * dot( ray, kbVirtualForward );
	if ( left <= 1e-5 ) return 1e6;
	return toFloor * abs( ray.y ) * ( abs( ray.y ) / left - 1.0 );
}
`;

// The key's shadow with a blocker search, so its edge widens with the gap between caster and floor. Three's VSM map holds the floor too, so every tap is tested against the floor's own depth there.
const SOFT_SHADOW = /* glsl */ `
#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_VSM )
vec2 kbDisc( int i, int n, float phi ) {
	float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
	float a = float( i ) * 2.399963229728653 + phi;
	return vec2( cos( a ), sin( a ) ) * r;
}
float kbFloorShadow( int index, sampler2D map, vec2 mapSize, float intensity, float bias, float radius, vec4 coord ) {
	if ( index > 0 ) return getShadow( map, mapSize, intensity, bias, radius, coord );
	vec3 c = coord.xyz / coord.w;
	c.z += bias;
	if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
	vec2 slope = kbShadowSlope;
	float noise = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	float phi = 6.283185307 * fract( noise + kbSeed * 0.61803398875 );
	float least = kbShadowB.y / mapSize.x;
	float most = max( least, kbShadowB.x );
	float blocker = 0.0;
	float found = 0.0;
	for ( int i = 0; i < ${SHADOW_SEARCH_TAPS}; i ++ ) {
		vec2 o = kbDisc( i, ${SHADOW_SEARCH_TAPS}, phi ) * most;
		float mean = texture2D( map, c.xy + o ).r;
		float gapI = c.z + dot( slope, o ) - mean;
		float hit = step( ${SHADOW_SEARCH_EPS}, gapI );
		blocker += gapI * hit;
		found += hit;
	}
	if ( found < 0.5 ) return getShadow( map, mapSize, intensity, bias, radius, coord );
	float gap = blocker / found * kbShadowB.z;
	float reach = clamp( kbShadowA.x * gap * kbShadowB.w, least, most );
	float lit = 0.0;
	for ( int i = 0; i < ${SHADOW_FILTER_TAPS}; i ++ ) {
		vec2 o = kbDisc( i, ${SHADOW_FILTER_TAPS}, phi ) * reach;
		vec2 m = texture2D( map, c.xy + o ).rg;
		float z = c.z + dot( slope, o );
		float d = z - m.x;
		float variance = max( m.y * m.y, 0.0000001 );
		float p = clamp( ( variance / ( variance + d * d ) - 0.3 ) / 0.65, 0.0, 1.0 );
		lit += max( step( z, m.x ), p );
	}
	lit /= ${SHADOW_FILTER_TAPS}.0;
	float keep = 1.0 - kbShadowA.y * smoothstep( 0.0, kbShadowA.z, gap );
	return mix( 1.0, lit, intensity * keep );
}
#elif defined( USE_SHADOWMAP )
#define kbFloorShadow( index, map, mapSize, intensity, bias, radius, coord ) getShadow( map, mapSize, intensity, bias, radius, coord )
#endif
`;

const COLOR = /* glsl */ `
float kbFadeK = 1.0 - smoothstep( kbFade.x, kbFade.y, length( vKbWorld.xz - kbCentre ) );
diffuseColor *= kbFadeK;
vec4 kbF = texture2D( kbFlakeMap, vKbWorld.xz * ( kbGlitter.x / ${FLAKE_SIZE}.0 ) );
float kbFlake = kbF.r * kbGlitter.y;
`;

const ROUGHNESS = /* glsl */ `
float kbSatinRough = roughnessFactor;
roughnessFactor = mix( roughnessFactor, kbGlitter.z, kbFlake );
`;

const NORMAL = /* glsl */ `
vec2 kbTilt = ( kbF.gb - 0.5 ) * 2.0 * kbGlitter.w * kbGlitter.y;
normal = normalize( normal + ( viewMatrix * vec4( kbTilt.x, 0.0, kbTilt.y, 0.0 ) ).xyz );
`;

const EMISSIVE = /* glsl */ `
for ( int i = 0; i < ${MAX_POOLS}; i ++ ) {
	if ( i >= kbPoolCount ) break;
	vec2 kbD = vKbWorld.xz - kbPoolA[ i ].xy;
	float kbC = cos( kbPoolB[ i ].w );
	float kbS = sin( kbPoolB[ i ].w );
	vec2 kbQ = vec2( kbC * kbD.x + kbS * kbD.y, - kbS * kbD.x + kbC * kbD.y ) / kbPoolA[ i ].zw;
	totalEmissiveRadiance += kbPoolB[ i ].rgb * exp( - 2.0 * dot( kbQ, kbQ ) );
}
`;

const SHEEN_FADE = /* glsl */ `
float kbSheen = kbFadeK * mix( 1.0, 2.0 * kbF.a, kbGrain );
material.specularColor *= kbSheen;
material.specularColorBlended *= kbSheen;
material.specularF90 *= kbFadeK;
`;

const REFLECTION = /* glsl */ `
if ( kbReflOn > 0.5 ) {
	vec2 kbUv = vKbRefl.xy / vKbRefl.w;
	vec3 kbSharp = texture2D( kbReflSharp, kbUv ).rgb;
	vec3 kbBlurred = texture2D( kbReflBlur, kbUv ).rgb;
	float kbDepth = texture2D( kbReflDepth, kbUv ).r;
	vec3 kbRay = vKbWorld - kbVirtualEye;
	float kbToFloor = length( kbRay );
	kbRay /= kbToFloor;
	float kbZ = kbDepth * 2.0 - 1.0;
	float kbViewZ = 2.0 * kbNearFar.x * kbNearFar.y / ( kbNearFar.y + kbNearFar.x - kbZ * ( kbNearFar.y - kbNearFar.x ) );
	float kbToHit = kbViewZ / max( dot( kbRay, kbVirtualForward ), 1e-4 );
	float kbHeight = max( kbToHit - kbToFloor, 0.0 ) * abs( kbRay.y );
	float kbK = kbDepth >= 1.0 ? 1.0 : max( kbContact, smoothstep( 0.0, kbHeightBlur, kbHeight ) );
	vec3 kbRefl = mix( kbSharp, kbBlurred, kbK );
	// The satin's own surface, never a flake's, so the glitter can't cut the reflection into dashes.
	reflectedLight.indirectSpecular += kbRefl * EnvironmentBRDF( nonPerturbedNormal, geometryViewDir, material.specularColorBlended, material.specularF90, max( kbSatinRough, 0.0525 ) ) * kbReflStrength;
}
`;

const SOFT_REFLECTION = /* glsl */ `
if ( kbReflOn > 0.5 ) {
	vec2 kbUv = vKbRefl.xy / vKbRefl.w;
	vec2 kbFine = vKbWorld.xz * ( kbGlitter.x * ${SCATTER_FINE}.0 / ${FLAKE_SIZE}.0 );
	vec2 kbGrainS = vec2( texture2D( kbFlakeMap, kbFine ).a, texture2D( kbFlakeMap, kbFine.yx + 0.37 ).a );
	vec2 kbUvS = kbUv + ( kbGrainS - 0.5 ) * kbReflX.xy;
	vec3 kbSharp = texture2D( kbReflSharp, kbUvS ).rgb;
	vec3 kbBlurred = texture2D( kbReflBlur, kbUvS ).rgb;
	float kbDepth = texture2D( kbReflDepth, kbUv ).r;
	vec3 kbRay = vKbWorld - kbVirtualEye;
	float kbToFloor = length( kbRay );
	kbRay /= kbToFloor;
	float kbHit = kbDepth >= 1.0 ? 0.0 : 1.0;
	float kbHeight = kbHeightAt( kbDepth, kbRay, kbToFloor );
	float kbK = kbHit < 0.5 ? 1.0 : max( kbContact, smoothstep( 0.0, kbHeightBlur, kbHeight ) );
	vec3 kbRefl = mix( kbSharp, kbBlurred, kbK );
	if ( kbReflX.z > 0.0 ) {
		// The fade is read over the blur's own footprint, so a blurred reflection keeps its soft edge past the caster's outline.
		float kbNoise = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
		float kbPhi = 6.283185307 * fract( kbNoise + kbSeed * 0.61803398875 );
		float kbFade = 0.0;
		for ( int i = 0; i < ${REACH_TAPS}; i ++ ) {
			float kbR = sqrt( ( float( i ) + 0.5 ) / ${REACH_TAPS}.0 );
			float kbA = float( i ) * 2.399963229728653 + kbPhi;
			float kbD = texture2D( kbReflDepth, kbUv + vec2( cos( kbA ), sin( kbA ) ) * kbR * kbReflSpread ).r;
			if ( kbD < 1.0 ) kbFade += 1.0 - smoothstep( 0.0, kbReflX.z, kbHeightAt( kbD, kbRay, kbToFloor ) );
		}
		kbRefl *= kbFade / ${REACH_TAPS}.0;
	}
	if ( kbOcclusion.x > 0.0 ) {
		float kbNoise = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
		float kbPhi = 6.283185307 * fract( kbNoise + kbSeed * 0.61803398875 );
		float kbSeam = 0.0;
		for ( int i = 0; i < ${REACH_TAPS}; i ++ ) {
			float kbR = sqrt( ( float( i ) + 0.5 ) / ${REACH_TAPS}.0 );
			float kbA = float( i ) * 2.399963229728653 + kbPhi;
			float kbD = texture2D( kbReflDepth, kbUv + vec2( cos( kbA ), sin( kbA ) ) * kbR * kbOcclusionSpread ).r;
			// The mirror clips at the floor, so its depth is the height above the floor over the distance along the view.
			float kbLeft = abs( kbRay.y ) - kbD * kbOblique * dot( kbRay, kbVirtualForward );
			if ( kbD < 1.0 && kbLeft > 1e-5 ) {
				float kbTapHeight = kbToFloor * abs( kbRay.y ) * ( abs( kbRay.y ) / kbLeft - 1.0 );
				float kbTapNear = 1.0 - smoothstep( 0.0, kbOcclusion.y, kbTapHeight );
				kbSeam += kbTapNear * kbTapNear;
			}
		}
		kbSeam = 1.0 - kbOcclusion.x * kbSeam / ${REACH_TAPS}.0;
		kbRefl *= kbSeam;
		reflectedLight.directDiffuse *= kbSeam;
		reflectedLight.indirectDiffuse *= kbSeam;
	}
	float kbNear = 1.0 - smoothstep( 0.0, ${CONTACT_REACH}, kbHeight );
	float kbAo = 1.0 - kbShadowA.w * kbHit * kbNear * kbNear;
	reflectedLight.directDiffuse *= kbAo;
	reflectedLight.indirectDiffuse *= kbAo;
	reflectedLight.indirectSpecular += kbRefl * EnvironmentBRDF( nonPerturbedNormal, geometryViewDir, material.specularColorBlended, material.specularF90, max( kbSatinRough, 0.0525 ) ) * kbReflStrength;
}
`;

const BLUR_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
// Karis-weighted: a highlight far brighter than white would otherwise repeat as a ghost at every tap.
float karis( vec3 c ) { return 1.0 / ( 1.0 + dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ); }
void main() {
  vec3 c0 = texture2D( tSrc, vUv ).rgb;
  float k0 = karis( c0 );
  vec3 sum = c0 * k0;
  float total = k0;
  for ( int i = 1; i <= ${BLUR_TAPS}; i ++ ) {
    float t = float( i ) / ${BLUR_TAPS}.0;
    float w = exp( - 4.0 * t * t );
    vec3 a = texture2D( tSrc, vUv + uStep * t ).rgb;
    vec3 b = texture2D( tSrc, vUv - uStep * t ).rgb;
    float ka = w * karis( a );
    float kb = w * karis( b );
    sum += a * ka + b * kb;
    total += ka + kb;
  }
  gl_FragColor = vec4( sum / total, 1.0 );
}
`;

function mustReplace(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`satin floor: shader anchor missing: ${anchor}`);
  return source.replace(anchor, replacement);
}

// Mirror cameras shared by every floor, one per nesting depth and set whole before each pass: three keeps a transmission target per camera for the renderer's life, so a camera per floor kept ~0.5 GB at 4K per stage scene.
const mirrorEyes: PerspectiveCamera[] = [];
let mirrorDepth = 0;

/** How the first shadow-casting directional light's depth changes across its map along a level floor, so a tap beside a point is tested against the floor there. */
function floorShadowSlope(scene: Scene, out: Vector2): void {
  let key: DirectionalLight | null = null;
  scene.traverseVisible((o) => {
    const light = o as DirectionalLight;
    if (!key && light.isDirectionalLight && light.castShadow) key = light;
  });
  const m = (key as DirectionalLight | null)?.shadow.matrix.elements;
  if (!m) {
    out.set(0, 0);
    return;
  }
  const det = m[0] * m[9] - m[8] * m[1];
  if (Math.abs(det) < 1e-12) out.set(0, 0);
  else out.set((m[2] * m[9] - m[10] * m[1]) / det, (m[10] * m[0] - m[2] * m[8]) / det);
}

function target(withDepth: boolean) {
  const t = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: withDepth ? REFLECTION_SAMPLES : 0,
    depthBuffer: withDepth,
    ...(withDepth ? { depthTexture: new DepthTexture(1, 1, FloatType) } : {}),
  });
  t.texture.generateMipmaps = false;
  return t;
}

export function SatinFloor({
  y,
  color,
  roughness = 0.32,
  specular = 0.5,
  centre = [0, 0],
  fade = [4, 14],
  reflection,
  shadow,
  glitter,
  pools = [],
}: SatinFloorProps) {
  const reflect = reflection
    ? { strength: 1, blur: 24, heightBlur: 1.5, contact: 0, scale: 1, ...reflection }
    : null;
  // The added terms compile only when asked for, so a floor without them keeps its program.
  const soft =
    shadow !== undefined || reflection?.scatter !== undefined || reflection?.reach !== undefined;
  const cast = shadow ? { ...SHADOW_DEFAULTS, ...shadow } : null;
  const meshRef = useRef<Mesh>(null);
  const flakes = { ...GLITTER_DEFAULTS, ...glitter };
  const gl = useThree((s) => s.gl);
  // Anisotropic filtering keeps grazing flakes sharp across the floor and averaged along the view.
  const flakeTexture = useMemo(() => {
    const tex = flakeMap(Math.min(1, Math.max(0, flakes.density)), flakes.seed);
    tex.anisotropy = gl.capabilities.getMaxAnisotropy();
    return tex;
  }, [gl, flakes.density, flakes.seed]);
  useLayoutEffect(() => () => flakeTexture.dispose(), [flakeTexture]);

  const passes = useMemo(() => {
    const blur = new ShaderMaterial({
      vertexShader: BLUR_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      uniforms: { tSrc: { value: null }, uStep: { value: new Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new Scene();
    quad.add(new Mesh(new PlaneGeometry(2, 2), blur));
    return {
      sharp: target(true),
      across: target(false),
      blurred: target(false),
      blur,
      quad,
      quadCamera: new OrthographicCamera(-1, 1, 1, -1, 0, 1),
    };
  }, []);
  useLayoutEffect(
    () => () => {
      passes.sharp.depthTexture?.dispose();
      passes.sharp.dispose();
      passes.across.dispose();
      passes.blurred.dispose();
      passes.blur.dispose();
      for (const child of passes.quad.children) (child as Mesh).geometry.dispose();
    },
    [passes],
  );
  // Exports let the mirror go once the film has passed the scene; the next draw re-allocates it, and every pass is cleared or fully overwritten before it is read.
  useSceneRelease(() => {
    passes.sharp.dispose();
    passes.across.dispose();
    passes.blurred.dispose();
  });

  const uniforms = useMemo(
    () => ({
      kbReflMatrix: { value: new Matrix4() },
      kbReflSharp: { value: passes.sharp.texture },
      kbReflBlur: { value: passes.blurred.texture },
      kbReflDepth: { value: passes.sharp.depthTexture },
      kbReflOn: { value: 0 },
      kbReflStrength: { value: 1 },
      kbHeightBlur: { value: 1 },
      kbContact: { value: 0 },
      kbVirtualEye: { value: new Vector3() },
      kbVirtualForward: { value: new Vector3(0, 0, -1) },
      kbNearFar: { value: new Vector2(0.1, 1000) },
      kbCentre: { value: new Vector2() },
      kbFade: { value: new Vector2(4, 14) },
      kbFlakeMap: { value: null as DataTexture | null },
      kbGlitter: { value: new Vector4() },
      kbGrain: { value: 0 },
      kbPoolA: { value: Array.from({ length: MAX_POOLS }, () => new Vector4()) },
      kbPoolB: { value: Array.from({ length: MAX_POOLS }, () => new Vector4()) },
      kbPoolCount: { value: 0 },
      kbShadowA: { value: new Vector4() },
      kbShadowB: { value: new Vector4() },
      kbReflX: { value: new Vector3() },
      kbReflSpread: { value: new Vector2() },
      kbShadowSlope: { value: new Vector2() },
      kbOcclusion: { value: new Vector2() },
      kbOcclusionSpread: { value: new Vector2() },
      kbOblique: { value: 1 },
      kbSeed: supersampleSeed,
    }),
    [passes],
  );

  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ metalness: 0, envMapIntensity: 0 });
    // Premultiplied over: the fade already scales the colour, so writing it as alpha lets the background through.
    m.blending = CustomBlending;
    m.blendSrc = OneFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = OneFactor;
    m.blendDstAlpha = OneMinusSrcAlphaFactor;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      let vs = mustReplace(
        shader.vertexShader,
        "#include <common>",
        `#include <common>${VERTEX_PARS}`,
      );
      vs = mustReplace(vs, "#include <project_vertex>", `#include <project_vertex>${VERTEX}`);
      shader.vertexShader = vs;
      let fs = mustReplace(
        shader.fragmentShader,
        "#include <common>",
        `#include <common>${FRAGMENT_PARS}${soft ? SOFT_FRAGMENT_PARS : ""}`,
      );
      if (soft) {
        fs = mustReplace(
          fs,
          "#include <shadowmap_pars_fragment>",
          `#include <shadowmap_pars_fragment>${SOFT_SHADOW}`,
        );
        fs = mustReplace(
          fs,
          "#include <lights_fragment_begin>",
          mustReplace(
            ShaderChunk.lights_fragment_begin,
            "getShadow( directionalShadowMap[ i ]",
            "kbFloorShadow( UNROLLED_LOOP_INDEX, directionalShadowMap[ i ]",
          ),
        );
      }
      fs = mustReplace(fs, "#include <color_fragment>", `#include <color_fragment>${COLOR}`);
      fs = mustReplace(
        fs,
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>${ROUGHNESS}`,
      );
      fs = mustReplace(
        fs,
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>${NORMAL}`,
      );
      fs = mustReplace(
        fs,
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>${EMISSIVE}`,
      );
      fs = mustReplace(
        fs,
        "#include <lights_physical_fragment>",
        `#include <lights_physical_fragment>${SHEEN_FADE}`,
      );
      // No environment: a material on the scene's environment takes the scene's strength, never its own, and the strips are for the product alone.
      fs = mustReplace(fs, "#include <lights_fragment_maps>", "");
      fs = mustReplace(
        fs,
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>${soft ? SOFT_REFLECTION : REFLECTION}`,
      );
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = () =>
      soft ? "kookaburra-satin-floor-v9-soft" : "kookaburra-satin-floor-v6";
    return m;
  }, [uniforms, soft]);
  useLayoutEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    material.color.set(color);
    material.roughness = roughness;
    (material as unknown as { specularIntensity?: number }).specularIntensity = specular / 0.5;
    uniforms.kbCentre.value.set(centre[0], centre[1]);
    uniforms.kbFade.value.set(fade[0], fade[1]);
    uniforms.kbReflOn.value = reflect ? 1 : 0;
    uniforms.kbReflStrength.value = reflect?.strength ?? 0;
    uniforms.kbHeightBlur.value = reflect?.heightBlur ?? 1;
    uniforms.kbContact.value = Math.min(1, Math.max(0, reflect?.contact ?? 0));
    uniforms.kbGlitter.value.set(flakes.scale, flakes.weight, flakes.roughness, flakes.tilt);
    uniforms.kbGrain.value = Math.min(1, Math.max(0, flakes.grain));
    uniforms.kbFlakeMap.value = flakeTexture;
    const perUnit = 1 / (2 * SHADOW_FRUSTUM_EXTENT);
    const spread = cast ? Math.max(0, cast.spread) : 0;
    uniforms.kbShadowA.value.set(
      spread,
      cast ? Math.min(1, Math.max(0, cast.lighten)) : 0,
      cast ? Math.max(1e-3, cast.reach) : 1,
      cast ? Math.min(1, Math.max(0, cast.contact)) : 0,
    );
    uniforms.kbShadowB.value.set(
      spread * SHADOW_SEARCH_GAP * perUnit,
      SHADOW_MIN_TEXELS,
      SHADOW_FAR - SHADOW_NEAR,
      perUnit,
    );
    uniforms.kbReflX.value.z = Math.max(0, reflect?.reach ?? 0);
    uniforms.kbOcclusion.value.set(
      cast ? Math.min(1, Math.max(0, cast.occlusion)) : 0,
      cast ? Math.max(1e-3, cast.occlusionReach) : 1,
    );
    const count = Math.min(MAX_POOLS, pools.length);
    uniforms.kbPoolCount.value = count;
    for (let i = 0; i < count; i++) {
      const p = pools[i];
      const c = new Color(p.color).multiplyScalar(p.intensity);
      uniforms.kbPoolA.value[i].set(
        p.at[0],
        p.at[1],
        Math.max(1e-3, p.radius[0]),
        Math.max(1e-3, p.radius[1]),
      );
      uniforms.kbPoolB.value[i].set(c.r, c.g, c.b, ((p.angleDeg ?? 0) * Math.PI) / 180);
    }
  });

  // The mirror pass, per draw (three's Reflector): the eye mirrored in the floor plane, an oblique near plane at the floor, then a separable blur.
  const onBeforeRender = useMemo(() => {
    let busy = false;
    const once = createFrameShare();
    const thisRender = createRenderOnce();
    const size = new Vector2();
    const eyePos = new Vector3();
    const look = new Vector3();
    const up = new Vector3();
    const plane = new Plane();
    const clip = new Vector4();
    const q = new Vector4();
    const bias = new Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    const mirror = (v: Vector3, floor: number) => v.setY(2 * floor - v.y);
    const clearColor = new Color();
    return (renderer: WebGLRenderer, scene: Scene, camera: Camera) => {
      if (soft && mirrorDepth === 0) floorShadowSlope(scene, uniforms.kbShadowSlope.value);
      const strength = uniforms.kbReflOn.value;
      if (busy || strength < 0.5 || scene.overrideMaterial) return;
      // A supersampled frame mirrors once: its draws differ by a fraction of a pixel, under the mirror's blur. A mirror made for another floor's reflection is never kept.
      if (mirrorDepth > 0) once.reset();
      else if (once.reuse()) return;
      const self = meshRef.current;
      const cam = camera as PerspectiveCamera;
      const outer = renderer.getRenderTarget();
      if (outer) size.set(outer.width, outer.height);
      else renderer.getDrawingBufferSize(size);
      const scale = Math.max(0.1, Math.min(1, reflect?.scale ?? 1));
      const w = Math.max(1, Math.round(size.x * scale));
      const h = Math.max(1, Math.round(size.y * scale));
      const sized = passes.sharp.width === w && passes.sharp.height === h;
      // One render asks twice, in its glass pass and its main pass: the second takes the first's mirror.
      if (mirrorDepth === 0 && sized && thisRender.fresh(renderer, camera)) return;
      if (!sized) passes.sharp.setSize(w, h);
      // The blur runs at half size: smoother for the same taps, and a quarter of the work.
      const bw = Math.max(1, Math.round(w / 2));
      const bh = Math.max(1, Math.round(h / 2));
      for (const t of [passes.across, passes.blurred]) {
        if (t.width !== bw || t.height !== bh) t.setSize(bw, bh);
      }
      mirrorEyes[mirrorDepth] ??= new PerspectiveCamera();
      const eye = mirrorEyes[mirrorDepth];
      cam.getWorldPosition(eyePos);
      cam.getWorldDirection(look);
      up.set(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(eye.quaternion));
      eye.position.copy(mirror(eyePos.clone(), y));
      eye.up.copy(up.setY(-up.y));
      eye.lookAt(mirror(eyePos.clone().add(look), y));
      eye.near = cam.near;
      eye.far = cam.far;
      eye.updateMatrixWorld();
      eye.projectionMatrix.copy(cam.projectionMatrix);
      eye.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
      uniforms.kbReflMatrix.value
        .copy(bias)
        .multiply(eye.projectionMatrix)
        .multiply(eye.matrixWorldInverse);
      plane.setFromNormalAndCoplanarPoint(new Vector3(0, 1, 0), new Vector3(0, y, 0));
      plane.applyMatrix4(eye.matrixWorldInverse);
      clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const pm = eye.projectionMatrix.elements;
      q.set(
        (Math.sign(clip.x) + pm[8]) / pm[0],
        (Math.sign(clip.y) + pm[9]) / pm[5],
        -1,
        (1 + pm[10]) / pm[14],
      );
      uniforms.kbOblique.value = Math.abs(clip.dot(q));
      clip.multiplyScalar(2 / clip.dot(q));
      pm[2] = clip.x;
      pm[6] = clip.y;
      pm[10] = clip.z + 1;
      pm[14] = clip.w;
      uniforms.kbVirtualEye.value.copy(eye.position);
      eye.getWorldDirection(uniforms.kbVirtualForward.value);
      uniforms.kbNearFar.value.set(eye.near, eye.far);

      busy = true;
      const shadows = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      if (self) self.visible = false;
      // Empty sky in the mirror is black: the frame's own clear colour is composited under a background, never seen.
      renderer.getClearColor(clearColor);
      const clearAlpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(passes.sharp);
      renderer.clear();
      mirrorDepth += 1;
      try {
        renderer.render(scene, eye);
      } finally {
        mirrorDepth -= 1;
      }
      renderer.setClearColor(clearColor, clearAlpha);
      if (self) self.visible = true;
      const px = (Math.max(0, reflect?.blur ?? 24) * h) / 1080;
      passes.blur.uniforms.tSrc.value = passes.sharp.texture;
      passes.blur.uniforms.uStep.value.set(px / w, 0);
      renderer.setRenderTarget(passes.across);
      renderer.render(passes.quad, passes.quadCamera);
      passes.blur.uniforms.tSrc.value = passes.across.texture;
      passes.blur.uniforms.uStep.value.set(0, (px * Math.max(1, reflect?.stretch ?? 1)) / h);
      const scatter = Math.max(0, reflect?.scatter ?? 0) / 1080;
      uniforms.kbReflX.value.x = (scatter * h) / w;
      uniforms.kbReflX.value.y = scatter * Math.max(1, reflect?.stretch ?? 1);
      uniforms.kbReflSpread.value.set(
        (REACH_SPREAD * px) / w,
        (REACH_SPREAD * px * Math.max(1, reflect?.stretch ?? 1)) / h,
      );
      uniforms.kbOcclusionSpread.value.set(
        (OCCLUSION_SPREAD * h) / (1080 * w),
        OCCLUSION_SPREAD / 1080,
      );
      renderer.setRenderTarget(passes.blurred);
      renderer.render(passes.quad, passes.quadCamera);
      renderer.setRenderTarget(outer);
      renderer.shadowMap.autoUpdate = shadows;
      if (mirrorDepth === 0) thisRender.made(renderer, camera);
      else thisRender.reset();
      busy = false;
    };
  }, [
    passes,
    uniforms,
    y,
    soft,
    reflect?.scale,
    reflect?.blur,
    reflect?.stretch,
    reflect?.scatter,
  ]);

  const reach = fade[1] + PLANE_MARGIN;
  const geometry = useMemo(
    () => new PlaneGeometry(2 * reach, 2 * reach, 1, 1).rotateX(-Math.PI / 2),
    [reach],
  );
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      position={[centre[0], y, centre[1]]}
      receiveShadow
      onBeforeRender={onBeforeRender as unknown as Mesh["onBeforeRender"]}
    />
  );
}
