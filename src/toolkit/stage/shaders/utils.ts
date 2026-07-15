/** Shared GLSL snippets for the vendored paper-design effects, trimmed to what the six vendored shaders actually pull in. See NOTICE.md for provenance and the hash patch this file applies. */

// language=GLSL
export const declarePI: string = /* glsl */ `
#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846
`;

// language=GLSL
export const rotation2: string = /* glsl */ `
vec2 rotate(vec2 uv, float th) {
  return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}
`;

// language=GLSL
export const simplexNoise: string = /* glsl */ `
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
      dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`;

// PATCHED: the source's proceduralHash21 is a fract()-chain float hash; replaced with the house PCG integer hash (engine/transitionShader.ts's hash01) so it is exact across GPUs/drivers, same signature so callers (mesh-gradient's valueNoise) are untouched.
// language=GLSL
export const hash21: string = /* glsl */ `
float hash21(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p)));
  uint h = v.x * 374761393u ^ v.y * 668265263u ^ 2246822519u;
  h ^= h >> 13;
  h *= 1274126177u;
  h ^= h >> 16;
  return float(h & 0x00FFFFFFu) / 16777216.0;
}
`;

// PATCHED: the source's dither line is fract(sin(...)) whose sin precision is driver-defined; replaced with the same house PCG hash applied to gl_FragCoord (always non-negative window coordinates).
// language=GLSL
export const colorBandingFix: string = /* glsl */ `
  {
    uvec2 ph = uvec2(gl_FragCoord.xy);
    uint phh = ph.x * 374761393u ^ ph.y * 668265263u ^ 2246822519u;
    phh ^= phh >> 13;
    phh *= 1274126177u;
    phh ^= phh >> 16;
    color += 1. / 256. * (float(phh & 0x00FFFFFFu) / 16777216.0 - .5);
  }
`;

// Copied byte-identical from shader-utils.ts: a texture lookup, not a float hash, so no PCG patch needed.
// language=GLSL
export const textureRandomizerR: string = /* glsl */ `
float randomR(vec2 p) {
  vec2 uv = floor(p) / 100. + .5;
  return texture(u_noiseTexture, fract(uv)).r;
}
`;
