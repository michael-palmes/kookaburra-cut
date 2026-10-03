import { STAGE_FADE_WINDOW } from "./stage";

/** GLSL chunk library for scene3d look materials. `createLookMaterial` prepends `LOOK_GLSL_VERTEX` and `LOOK_GLSL_FRAGMENT` itself; every chunk is include-guarded, so pasting one again is harmless. Chunks named VERTEX-SAFE compile in both stages; `LOOK_GLSL_AA` uses `fwidth` and is fragment-only. */

/** Formats a number as a GLSL float literal (always with a decimal point). */
export function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

/** VERTEX-SAFE. Engine-owned uniforms: the EXPORT format's pixel size and `uPx` (export height / 1080), never the preview canvas or DPR. */
// language=GLSL
export const LOOK_GLSL_FRAME: string = /* glsl */ `
#ifndef KK_LOOK_FRAME
#define KK_LOOK_FRAME
uniform vec2 uResolution;
uniform float uPx;
#endif
`;

/** VERTEX-SAFE. The house PCG-style integer hash (shaders/utils.ts `pcgHash01`), 24-bit exact floats in [0, 1). Floor floats through ivec before hashing. */
// language=GLSL
export const LOOK_GLSL_HASH: string = /* glsl */ `
#ifndef KK_LOOK_HASH
#define KK_LOOK_HASH
float kkHash(uvec3 v) {
  uint h = v.x * 374761393u ^ v.y * 668265263u ^ v.z * 2246822519u;
  h ^= h >> 13;
  h *= 1274126177u;
  h ^= h >> 16;
  return float(h & 0x00FFFFFFu) / 16777216.0;
}
float hash11(int x) { return kkHash(uvec3(uint(x), 0u, 0u)); }
float hash21(ivec2 p) { return kkHash(uvec3(uvec2(p), 0u)); }
float hash31(ivec3 p) { return kkHash(uvec3(p)); }
vec2 hash22(ivec2 p) { return vec2(kkHash(uvec3(uvec2(p), 0u)), kkHash(uvec3(uvec2(p), 1u))); }
#endif
`;

/** VERTEX-SAFE (needs LOOK_GLSL_HASH). Value noise and fbm on the house hash: `vnoise`/`fbm` (2D, 5 octaves) and `vnoise3`/`fbm3` (3D, 4 octaves), all in [0, 1). */
// language=GLSL
export const LOOK_GLSL_NOISE: string = /* glsl */ `
#ifndef KK_LOOK_NOISE
#define KK_LOOK_NOISE
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 k = ivec2(i);
  float a = hash21(k);
  float b = hash21(k + ivec2(1, 0));
  float c = hash21(k + ivec2(0, 1));
  float d = hash21(k + ivec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  ivec3 k = ivec3(i);
  float n000 = hash31(k);
  float n100 = hash31(k + ivec3(1, 0, 0));
  float n010 = hash31(k + ivec3(0, 1, 0));
  float n110 = hash31(k + ivec3(1, 1, 0));
  float n001 = hash31(k + ivec3(0, 0, 1));
  float n101 = hash31(k + ivec3(1, 0, 1));
  float n011 = hash31(k + ivec3(0, 1, 1));
  float n111 = hash31(k + ivec3(1, 1, 1));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s;
}
float fbm3(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise3(p);
    p = p * 2.03 + vec3(17.1, 9.7, 5.3);
    a *= 0.5;
  }
  return s;
}
#endif
`;

/** VERTEX-SAFE. Stage helpers (the stage centre is the world origin). `stageFade` (F11) is 0 for fragments between the camera and the stage, 1 elsewhere, over a window of the camera-to-stage distance; `stageFadeInLine` applies it only where the view ray passes near the stage centre, so walls beside the camera stay. */
// language=GLSL
export const LOOK_GLSL_STAGE: string = /* glsl */ `
#ifndef KK_LOOK_STAGE
#define KK_LOOK_STAGE
float stageFade(vec3 wp, float nearFrac, float farFrac) {
  float dStage = length(cameraPosition);
  return smoothstep(dStage * nearFrac, dStage * farFrac, distance(cameraPosition, wp));
}
float stageFade(vec3 wp) {
  return stageFade(wp, ${glslFloat(STAGE_FADE_WINDOW.near)}, ${glslFloat(STAGE_FADE_WINDOW.far)});
}
float stageFadeInLine(vec3 wp, float nearFrac, float farFrac, float missFrom, float missTo) {
  vec3 v = normalize(wp - cameraPosition);
  float miss = length(cameraPosition + max(dot(-cameraPosition, v), 0.0) * v);
  return 1.0 - (1.0 - stageFade(wp, nearFrac, farFrac)) * (1.0 - smoothstep(missFrom, missTo, miss));
}
float stageFadeInLine(vec3 wp, float missFrom, float missTo) {
  return stageFadeInLine(wp, ${glslFloat(STAGE_FADE_WINDOW.near)}, ${glslFloat(STAGE_FADE_WINDOW.far)}, missFrom, missTo);
}
#endif
`;

/** FRAGMENT-ONLY (fwidth). `aaStep`/`aaBand` antialias procedural edges and bands (MSAA does not smooth shader interiors); `pitchGuard` is 1 while a world-space pattern cell is large on screen, falling to 0 as it nears pixel size: mix toward the pattern's MEAN tone with it. `aaLine(d, halfWidth)` is a line of half width `halfWidth` (d units) that holds 1.5 px and fades instead of thinning (seams, creases). `stageCut` (needs LOOK_GLSL_STAGE) is the `stageFade` near cut as one hard antialiased edge, for alpha-to-coverage parts. */
// language=GLSL
export const LOOK_GLSL_AA: string = /* glsl */ `
#ifndef KK_LOOK_AA
#define KK_LOOK_AA
float aaStep(float edge, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(edge - w, edge + w, x);
}
float aaBand(float d, float halfWidth) {
  float w = max(fwidth(d), 1e-5);
  return 1.0 - smoothstep(halfWidth - w, halfWidth + w, abs(d));
}
float pitchGuard(vec2 cellUv) {
  float px = max(length(fwidth(cellUv)), 1e-5);
  return 1.0 - smoothstep(0.35, 0.7, px);
}
float pitchGuard(float cell) {
  float px = max(fwidth(cell), 1e-5);
  return 1.0 - smoothstep(0.35, 0.7, px);
}
float aaLine(float d, float halfWidth) {
  float px = max(fwidth(d), 1e-5);
  float w = max(halfWidth, px * 0.75);
  return (1.0 - smoothstep(w - px, w + px, abs(d))) * (halfWidth / w);
}
float stageCut(vec3 wp, float nearFrac, float farFrac) {
  float f = stageFade(wp, nearFrac, farFrac);
  float w = max(fwidth(f), 1e-4);
  return smoothstep(0.5 - w, 0.5 + w, f);
}
float stageCut(vec3 wp) {
  return stageCut(wp, ${glslFloat(STAGE_FADE_WINDOW.near)}, ${glslFloat(STAGE_FADE_WINDOW.far)});
}
#endif
`;

/** FRAGMENT-ONLY (three's sRGB transfer helpers). Paste it. `backingMix(col, backing, k)` fades a LINEAR colour toward the look's `backing` prop (0 keeps `col`, 1 lands on the backing), blended in display space so it reproduces the canvas curve of the alpha fade it replaces, and holds that curve on compositor targets too. */
// language=GLSL
export const LOOK_GLSL_BACKING: string = /* glsl */ `
#ifndef KK_LOOK_BACKING
#define KK_LOOK_BACKING
vec3 backingMix(vec3 col, vec3 backing, float k) {
  vec3 a = sRGBTransferOETF(vec4(col, 1.0)).rgb;
  vec3 b = sRGBTransferOETF(vec4(backing, 1.0)).rgb;
  return sRGBTransferEOTF(vec4(mix(a, b, clamp(k, 0.0, 1.0)), 1.0)).rgb;
}
#endif
`;

/** VERTEX-ONLY (attributes and projectionMatrix). World position and normal that honour InstancedMesh, the instance colour (white without one), and export pixels per world unit at a view depth. */
// language=GLSL
export const LOOK_GLSL_VERTEX_HELPERS: string = /* glsl */ `
#ifndef KK_LOOK_VERTEX_HELPERS
#define KK_LOOK_VERTEX_HELPERS
vec4 lookWorldPosition(vec3 p) {
#ifdef USE_INSTANCING
  return modelMatrix * instanceMatrix * vec4(p, 1.0);
#else
  return modelMatrix * vec4(p, 1.0);
#endif
}
vec3 lookWorldNormal(vec3 n) {
#ifdef USE_INSTANCING
  return normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
#else
  return normalize(mat3(modelMatrix) * n);
#endif
}
vec3 lookInstanceColor() {
#ifdef USE_INSTANCING_COLOR
  return instanceColor;
#else
  return vec3(1.0);
#endif
}
float exportPxPerUnit(float viewDepth) {
  return projectionMatrix[1][1] * 0.5 * uResolution.y / max(viewDepth, 1e-4);
}
#endif
`;

/** Everything a look vertex shader may call. */
export const LOOK_GLSL_VERTEX: string = [
  LOOK_GLSL_FRAME,
  LOOK_GLSL_HASH,
  LOOK_GLSL_NOISE,
  LOOK_GLSL_STAGE,
  LOOK_GLSL_VERTEX_HELPERS,
].join("");

/** Everything a look fragment shader may call. */
export const LOOK_GLSL_FRAGMENT: string = [
  LOOK_GLSL_FRAME,
  LOOK_GLSL_HASH,
  LOOK_GLSL_NOISE,
  LOOK_GLSL_STAGE,
  LOOK_GLSL_AA,
].join("");

/** Default look vertex shader: world position, uv, world normal and instance colour as varyings. A fragment declares only the varyings it reads. */
// language=GLSL
export const LOOK_VERTEX_SHADER: string = /* glsl */ `
varying vec3 vWorld;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vInstanceColor;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  vUv = uv;
  vNormalW = lookWorldNormal(normal);
  vInstanceColor = lookInstanceColor();
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
