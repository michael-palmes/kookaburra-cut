import {
  AdditiveBlending,
  Color,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  ShaderChunk,
  type SkinnedMesh,
} from "three";
import type { DeviceId } from "./catalog";
import { gsaaChunk, SPECULAR_AA_GRAIN } from "./specularAA";

/** Opt-in hero finishes for device bodies (research prototype): absent means the glb's authored materials, untouched. */

export type DeviceFinishRole = "frame" | "polished" | "back";

/** Which glb materials play each finish role, per model; names from scripts/dump-glb-materials.mjs. Neither licensed phone has cover glass over its display (the front glass is the opaque black border), so `glass` adds a coat over the screen meshes instead. */
export const FINISH_ROLES: Partial<Record<DeviceId, Record<string, DeviceFinishRole>>> = {
  "iphone-15-pro": {
    "TITANIUM Brushed": "frame",
    "TITANIUM Rough": "frame",
    "TITANIUM Polished": "polished",
    SCREWS: "polished",
    "GL_BACK Rough": "back",
  },
  "iphone-17-pro": {
    "aluminum satin": "frame",
    "aluminum polished": "polished",
    "screw grooves": "polished",
    "glass cover rear": "back",
  },
  android: {
    frame_metal: "frame",
    back_glass: "back",
  },
};

export interface DeviceFrameFinish {
  roughness?: number;
  metalness?: number;
  /** 0..1 stretch of the highlight across the brushing (KHR anisotropy strength). */
  anisotropy?: number;
  /** Stretch along the grooves instead of across them (the unphysical but sometimes prettier choice). */
  anisotropyAlong?: boolean;
  /** 0..1 procedural hairline grain along the band, band-limited so it fades instead of aliasing. */
  grain?: number;
  /** Grain cells per metre across the band (the band is about 8 mm tall). */
  grainScale?: number;
  /** Scale on the glb's own brushed normal map; 0 removes it and its roughness map. */
  brushedMap?: number;
  /** Roughness where the band rolls over into the glass and the back (a polished chamfer line); absent keeps one roughness. */
  chamferRoughness?: number;
  envIntensity?: number;
  /** Environment lookups fanned across the grooves around the true mirror direction, in place of three's bent normal, which swings the band's reflection towards the viewer. A strip placed on the band's mirror direction then lands on it, as it would in a path tracer. */
  iblTaps?: number;
}

export interface DeviceFinishSpec {
  frame?: DeviceFrameFinish;
  polished?: { roughness?: number; envIntensity?: number };
  /** A specular-only coat over the display: Fresnel reflections add onto the media, which stays exact where nothing reflects. */
  glass?: {
    roughness?: number;
    ior?: number;
    specularIntensity?: number;
    envIntensity?: number;
  };
  back?: {
    roughness?: number;
    metalness?: number;
    /** Multiplies the colour the device colour set. */
    tint?: number;
    clearcoat?: number;
    clearcoatRoughness?: number;
    envIntensity?: number;
  };
  /** Research only: paints these glb materials magenta to map roles. */
  debug?: string[];
}

export const DEVICE_FINISHES: Record<string, DeviceFinishSpec> = {
  studio: {
    frame: {
      roughness: 0.3,
      metalness: 1,
      anisotropy: 0.4,
      grain: 1,
      grainScale: 20000,
      brushedMap: 0,
      chamferRoughness: 0.08,
      envIntensity: 1.6,
    },
    polished: { roughness: 0.06, envIntensity: 1.8 },
    glass: { roughness: 0.05, ior: 1.5, specularIntensity: 1, envIntensity: 1.5 },
    back: {
      roughness: 0.45,
      metalness: 0,
      tint: 0.55,
      clearcoat: 0.6,
      clearcoatRoughness: 0.12,
      envIntensity: 1.3,
    },
  },
};

export type DeviceFinish = string | DeviceFinishSpec;

export function resolveDeviceFinish(finish: DeviceFinish | undefined): DeviceFinishSpec | null {
  if (finish === undefined) return null;
  if (typeof finish === "string") return DEVICE_FINISHES[finish] ?? null;
  return finish;
}

/** Hairline grain and the brushing direction, both in the device's own frame (glTF +Z is the screen normal, so the band's grooves run along cross(Z, N)). Integer PCG-style hashing only. */
const FRAME_VERTEX_PARS = /* glsl */ `
uniform mat4 kbDeviceMatrix;
uniform mat4 kbDeviceInverse;
varying vec3 vKbDevPos;
varying vec3 vKbDevNrm;
varying vec3 vKbBrushView;
`;

const FRAME_VERTEX = /* glsl */ `
{
	vec4 kbWorld = modelMatrix * vec4( transformed, 1.0 );
	vKbDevPos = ( kbDeviceInverse * kbWorld ).xyz;
	vec3 kbDevN = normalize( mat3( kbDeviceInverse ) * ( mat3( modelMatrix ) * objectNormal ) );
	vKbDevNrm = kbDevN;
	vec3 kbP = cross( vec3( 0.0, 0.0, 1.0 ), kbDevN );
	if ( dot( kbP, kbP ) < 1e-8 ) kbP = vec3( 1.0, 0.0, 0.0 );
	vKbBrushView = ( viewMatrix * ( kbDeviceMatrix * vec4( kbP, 0.0 ) ) ).xyz;
}
`;

const FRAME_FRAGMENT_PARS = /* glsl */ `
uniform float kbGrain;
uniform float kbGrainScale;
uniform float kbAnisoAlong;
uniform float kbChamferRough;
varying vec3 vKbDevPos;
varying vec3 vKbDevNrm;
varying vec3 vKbBrushView;
uint kbHashU( uvec2 v ) {
	v = v * 1664525u + 1013904223u;
	v.x += v.y * 1664525u;
	v.y += v.x * 1664525u;
	v ^= v >> 16u;
	v.x += v.y * 1664525u;
	v.y += v.x * 1664525u;
	v ^= v >> 16u;
	return v.x ^ v.y;
}
float kbHash( vec2 p ) {
	return float( kbHashU( uvec2( ivec2( floor( p ) ) + ivec2( 65536 ) ) ) ) * ( 1.0 / 4294967295.0 );
}
float kbNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	float a = kbHash( i );
	float b = kbHash( i + vec2( 1.0, 0.0 ) );
	float c = kbHash( i + vec2( 0.0, 1.0 ) );
	float d = kbHash( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
`;

const LEGACY_GRAIN = /* glsl */ `
	float kbFw = fwidth( kbC.x );
	float kbFade = clamp( 2.0 - kbFw * 3.0, 0.0, 1.0 ) * ( 1.0 - kbChamfer );
	kbG = ( kbNoise( kbC ) * 0.6 + kbNoise( kbC * vec2( 3.1, 1.3 ) + vec2( 17.0, 3.0 ) ) * 0.4 - 0.5 ) * kbFade * kbGrain;
`;

function frameRoughness(specularAA: boolean): string {
  return /* glsl */ `
float kbG = 0.0;
float kbChamfer = kbChamferRough >= 0.0 ? smoothstep( 0.3, 0.8, abs( normalize( vKbDevNrm ).z ) ) : 0.0;
if ( kbGrain > 0.0 ) {
	vec2 kbC = vec2( vKbDevPos.z * kbGrainScale, ( vKbDevPos.x + vKbDevPos.y ) * kbGrainScale * 0.012 );
${specularAA ? SPECULAR_AA_GRAIN : LEGACY_GRAIN}	roughnessFactor = clamp( roughnessFactor * ( 1.0 + kbG * 0.35 ), 0.0, 1.0 );
}
if ( kbChamferRough >= 0.0 ) roughnessFactor = mix( roughnessFactor, kbChamferRough, kbChamfer );
`;
}

const FRAME_NORMAL = /* glsl */ `
if ( kbGrain > 0.0 ) {
	vec3 kbP0 = vKbBrushView - normal * dot( normal, vKbBrushView );
	float kbL0 = length( kbP0 );
	if ( kbL0 > 1e-5 ) normal = normalize( normal + cross( normal, kbP0 / kbL0 ) * kbG * 0.12 );
}
`;

const FRAME_ANISOTROPY = /* glsl */ `
#ifdef USE_ANISOTROPY
{
	vec3 kbP = vKbBrushView - normal * dot( normal, vKbBrushView );
	float kbL = length( kbP );
	kbP = kbL > 1e-5 ? kbP / kbL : normalize( cross( normal, vec3( 0.0, 1.0, 0.0 ) ) + vec3( 1e-4 ) );
	vec3 kbQ = cross( normal, kbP );
	material.anisotropyT = mix( kbQ, kbP, kbAnisoAlong );
	material.anisotropyB = mix( -kbP, kbQ, kbAnisoAlong );
}
#endif
`;

/** The stretched lobe as `taps` lookups fanned across the grooves, each at the base roughness, spanning three's own alphaT. */
function frameIblTaps(taps: number): string {
  return /* glsl */ `
#if defined( USE_ENVMAP ) && defined( USE_ANISOTROPY )
vec3 kbAnisoIBL( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
	vec3 across = cross( bitangent, normal );
	float acrossLen = length( across );
	if ( acrossLen < 1e-5 ) return getIBLRadiance( viewDir, normal, roughness );
	across /= acrossLen;
	float spread = mix( pow2( roughness ), 1.0, pow2( anisotropy ) );
	vec3 sum = vec3( 0.0 );
	float total = 0.0;
	for ( int i = 0; i < ${taps}; i ++ ) {
		float t = ( float( i ) + 0.5 ) / ${taps}.0 * 2.0 - 1.0;
		float w = exp( - 2.0 * t * t );
		sum += w * getIBLRadiance( viewDir, normalize( normal + across * ( t * spread ) ), roughness );
		total += w;
	}
	return sum / total;
}
#endif
`;
}

function mustReplace(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`device finish: shader anchor missing: ${anchor}`);
  return source.replace(anchor, replacement);
}

function toPhysical(material: Material): MeshPhysicalMaterial {
  if ((material as MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    return material as MeshPhysicalMaterial;
  }
  const physical = new MeshPhysicalMaterial();
  MeshStandardMaterial.prototype.copy.call(physical, material as MeshStandardMaterial);
  physical.defines = { STANDARD: "", PHYSICAL: "" };
  return physical;
}

function gsaaOnly(material: Material, key: string, specularAA: boolean): void {
  const gsaa = gsaaChunk(specularAA);
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = mustReplace(
      shader.fragmentShader,
      "#include <lights_physical_fragment>",
      gsaa.fragment,
    );
  };
  const programKey = key + gsaa.key;
  material.customProgramCacheKey = () => programKey;
}

function applyFrame(
  source: Material,
  spec: DeviceFrameFinish,
  root: Object3D,
  specularAA: boolean,
): Material {
  const gsaa = gsaaChunk(specularAA);
  const material = toPhysical(source);
  if (spec.roughness !== undefined) material.roughness = spec.roughness;
  if (spec.metalness !== undefined) material.metalness = spec.metalness;
  if (spec.envIntensity !== undefined) material.envMapIntensity = spec.envIntensity;
  if (spec.brushedMap !== undefined) {
    if (spec.brushedMap <= 0) {
      material.normalMap = null;
      material.roughnessMap = null;
      material.metalnessMap = null;
    } else {
      material.normalScale.multiplyScalar(spec.brushedMap);
    }
  }
  material.anisotropy = spec.anisotropy ?? 0;
  const taps = Math.max(0, Math.min(16, Math.round(spec.iblTaps ?? 0)));
  const uniforms = {
    kbDeviceMatrix: { value: new Matrix4() },
    kbDeviceInverse: { value: new Matrix4() },
    kbGrain: { value: spec.grain ?? 0 },
    kbGrainScale: { value: spec.grainScale ?? 20000 },
    kbChamferRough: { value: spec.chamferRoughness ?? -1 },
    kbAnisoAlong: { value: spec.anisotropyAlong ? 1 : 0 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let vs = mustReplace(
      shader.vertexShader,
      "#include <common>",
      `#include <common>${FRAME_VERTEX_PARS}`,
    );
    vs = mustReplace(vs, "#include <skinning_vertex>", `#include <skinning_vertex>${FRAME_VERTEX}`);
    shader.vertexShader = vs;
    let fs = mustReplace(
      shader.fragmentShader,
      "#include <common>",
      `#include <common>${FRAME_FRAGMENT_PARS}`,
    );
    fs = mustReplace(
      fs,
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>${frameRoughness(specularAA)}`,
    );
    fs = mustReplace(
      fs,
      "#include <normal_fragment_maps>",
      `#include <normal_fragment_maps>${FRAME_NORMAL}`,
    );
    fs = mustReplace(
      fs,
      "#include <lights_physical_fragment>",
      `${gsaa.fragment}${FRAME_ANISOTROPY}`,
    );
    if (taps > 0) {
      fs = mustReplace(
        fs,
        "#include <envmap_physical_pars_fragment>",
        `#include <envmap_physical_pars_fragment>${frameIblTaps(taps)}`,
      );
      fs = mustReplace(
        fs,
        "#include <lights_fragment_maps>",
        mustReplace(ShaderChunk.lights_fragment_maps, "getIBLAnisotropyRadiance(", "kbAnisoIBL("),
      );
    }
    shader.fragmentShader = fs;
  };
  const frameKey =
    (taps > 0
      ? `kookaburra-device-finish-frame-v1-taps${taps}`
      : "kookaburra-device-finish-frame-v1") + gsaa.key;
  material.customProgramCacheKey = () => frameKey;
  // World matrices are final by draw time, so the device frame is read here, never cached across frames.
  material.onBeforeRender = () => {
    uniforms.kbDeviceMatrix.value.copy(root.matrixWorld);
    uniforms.kbDeviceInverse.value.copy(root.matrixWorld).invert();
  };
  return material;
}

/** Returns the finished material for one glb material, or null when the finish leaves it to the legacy path. */
export function applyDeviceFinish(
  material: Material,
  name: string | undefined,
  model: DeviceId,
  spec: DeviceFinishSpec,
  root: Object3D,
  specularAA = false,
): Material | null {
  if (name && spec.debug?.includes(name)) {
    return new MeshBasicMaterial({ color: new Color(1, 0, 1) });
  }
  const role = name ? FINISH_ROLES[model]?.[name] : undefined;
  if (!role) return null;
  if (role === "frame" && spec.frame) return applyFrame(material, spec.frame, root, specularAA);
  if (role === "polished" && spec.polished) {
    const m = material as MeshStandardMaterial;
    if (spec.polished.roughness !== undefined) m.roughness = spec.polished.roughness;
    if (spec.polished.envIntensity !== undefined) m.envMapIntensity = spec.polished.envIntensity;
    gsaaOnly(m, "kookaburra-device-finish-polished-v1", specularAA);
    return m;
  }
  if (role === "back" && spec.back) {
    const b = toPhysical(material);
    const s = spec.back;
    if (s.roughness !== undefined) b.roughness = s.roughness;
    if (s.metalness !== undefined) b.metalness = s.metalness;
    if (s.tint !== undefined) b.color.multiplyScalar(s.tint);
    if (s.clearcoat !== undefined) b.clearcoat = s.clearcoat;
    if (s.clearcoatRoughness !== undefined) b.clearcoatRoughness = s.clearcoatRoughness;
    if (s.envIntensity !== undefined) b.envMapIntensity = s.envIntensity;
    gsaaOnly(b, "kookaburra-device-finish-back-v1", specularAA);
    return b;
  }
  return null;
}

/** Adds the glass coat over each display mesh: same geometry and transform, black base, additive, so only the reflection lands. */
export function addScreenCoats(
  screens: readonly Mesh[],
  spec: DeviceFinishSpec,
  specularAA = false,
): void {
  const glass = spec.glass;
  if (!glass) return;
  const coat = new MeshPhysicalMaterial({
    color: new Color(0, 0, 0),
    metalness: 0,
    roughness: glass.roughness ?? 0.03,
    ior: glass.ior ?? 1.5,
    specularIntensity: glass.specularIntensity ?? 1,
    envMapIntensity: glass.envIntensity ?? 1,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  gsaaOnly(coat, "kookaburra-device-finish-coat-v1", specularAA);
  for (const screen of screens) {
    // A folding display's skin would leave a rigid coat behind.
    if ((screen as SkinnedMesh).isSkinnedMesh) continue;
    const mesh = new Mesh(screen.geometry, coat);
    mesh.name = `${screen.name}-coat`;
    mesh.position.copy(screen.position);
    mesh.quaternion.copy(screen.quaternion);
    mesh.scale.copy(screen.scale);
    screen.parent?.add(mesh);
  }
}
