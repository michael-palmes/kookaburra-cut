import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import {
  type Camera,
  Color,
  DataTexture,
  DepthTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { createSeededRandom } from "../../engine/rng";

/** A satin stage floor (the `satin` backdrop): a planar reflection blurred with the height of what it reflects, an albedo and sheen that fade with distance so it dissolves into the void, sparse glitter flakes, and floor-only pools standing in for caustics. Deterministic: fixed passes, no history. */

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
  /** The albedo and sheen fall to black between these radii. */
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
  };
  glitter?: Partial<FloorGlitter>;
  pools?: FloorPool[];
}

const MAX_POOLS = 4;
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

const COLOR = /* glsl */ `
float kbFadeK = 1.0 - smoothstep( kbFade.x, kbFade.y, length( vKbWorld.xz - kbCentre ) );
diffuseColor.rgb *= kbFadeK;
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
  glitter,
  pools = [],
}: SatinFloorProps) {
  const reflect = reflection
    ? { strength: 1, blur: 24, heightBlur: 1.5, contact: 0, scale: 1, ...reflection }
    : null;
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
      eye: new PerspectiveCamera(),
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
    }),
    [passes],
  );

  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ metalness: 0, envMapIntensity: 0 });
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
        `#include <common>${FRAGMENT_PARS}`,
      );
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
        `#include <lights_fragment_end>${REFLECTION}`,
      );
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => "kookaburra-satin-floor-v5";
    return m;
  }, [uniforms]);
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
      const strength = uniforms.kbReflOn.value;
      if (busy || strength < 0.5 || scene.overrideMaterial) return;
      const self = meshRef.current;
      const cam = camera as PerspectiveCamera;
      const outer = renderer.getRenderTarget();
      if (outer) size.set(outer.width, outer.height);
      else renderer.getDrawingBufferSize(size);
      const scale = Math.max(0.1, Math.min(1, reflect?.scale ?? 1));
      const w = Math.max(1, Math.round(size.x * scale));
      const h = Math.max(1, Math.round(size.y * scale));
      if (passes.sharp.width !== w || passes.sharp.height !== h) passes.sharp.setSize(w, h);
      // The blur runs at half size: smoother for the same taps, and a quarter of the work.
      const bw = Math.max(1, Math.round(w / 2));
      const bh = Math.max(1, Math.round(h / 2));
      for (const t of [passes.across, passes.blurred]) {
        if (t.width !== bw || t.height !== bh) t.setSize(bw, bh);
      }
      const eye = passes.eye;
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
      renderer.render(scene, eye);
      renderer.setClearColor(clearColor, clearAlpha);
      if (self) self.visible = true;
      const px = (Math.max(0, reflect?.blur ?? 24) * h) / 1080;
      passes.blur.uniforms.tSrc.value = passes.sharp.texture;
      passes.blur.uniforms.uStep.value.set(px / w, 0);
      renderer.setRenderTarget(passes.across);
      renderer.render(passes.quad, passes.quadCamera);
      passes.blur.uniforms.tSrc.value = passes.across.texture;
      passes.blur.uniforms.uStep.value.set(0, px / h);
      renderer.setRenderTarget(passes.blurred);
      renderer.render(passes.quad, passes.quadCamera);
      renderer.setRenderTarget(outer);
      renderer.shadowMap.autoUpdate = shadows;
      busy = false;
    };
  }, [passes, uniforms, y, reflect?.scale, reflect?.blur]);

  const geometry = useMemo(() => new PlaneGeometry(80, 80, 1, 1).rotateX(-Math.PI / 2), []);
  useLayoutEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      position={[0, y, 0]}
      receiveShadow
      onBeforeRender={onBeforeRender as unknown as Mesh["onBeforeRender"]}
    />
  );
}
