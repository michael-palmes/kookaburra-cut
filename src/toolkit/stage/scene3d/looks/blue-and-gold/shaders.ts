import { glslFloat, STROKE_SPLAT_GLSL_FRAGMENT, STROKE_SPLAT_GLSL_VERTEX } from "../../kit";
import { DAUB_FIELD, PAINTER_SUN, RIDGE_RADIUS } from "./paddock";

/** Blue and gold GLSL: a horizon glow shell, one blue ridge, the underpainted ground and the daub field (F3 stroke splats). Colours are LINEAR slot uniforms. Hazes stay alpha, never a `backing` mix: the far ground and the ridge haze over the glow shell, whose glow reaches below the horizon, so an opaque mix cuts a dark seam there. */

const sun = PAINTER_SUN.map(glslFloat).join(", ");

// language=GLSL
const CLOUD = /* glsl */ `
float cloudShadow(vec2 xz, float t) {
  float f = fbm(xz * 0.028 - vec2(t, t * 0.35) * 0.042);
  return smoothstep(0.53, 0.6, f);
}
`;

// language=GLSL
export const LOCAL_VERTEX = /* glsl */ `
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uRidge;
uniform vec3 uStraw;
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  float e = normalize(vLocal).y;
  float horizon = normalize(vWorld - cameraPosition).y;
  float a = 0.64 * (1.0 - smoothstep(-0.02, 0.18, e)) * smoothstep(-0.07, -0.01, horizon);
  gl_FragColor = vec4(mix(uRidge, uStraw, 0.55), a);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const RIDGE_FRAGMENT = /* glsl */ `
uniform vec3 uRidge;
uniform float uRidgeHeight;
uniform float uCalm;
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vec2 c = vLocal.xz / ${glslFloat(RIDGE_RADIUS)};
  float n = fbm(c * 2.2 + vec2(5.0, 2.0));
  float crest = -2.0 + mix(1.5, 8.5, smoothstep(0.3, 0.72, n)) * uRidgeHeight;
  float d = crest - vLocal.y;
  float a = smoothstep(-0.35, 0.35, d + (vnoise(c * 40.0) - 0.5) * 0.3);
  a *= 1.0 - 0.55 * (0.4 + 0.5 * smoothstep(0.0, 4.5, d));
  a *= (1.0 - 0.45 * calmWeight(vWorld, uCalm)) * stageFade(vWorld);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uRidge, a);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const GROUND_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uCloud;
uniform float uClear;
uniform float uCalm;
uniform vec3 uGold;
uniform vec3 uStraw;
uniform vec3 uShade;
uniform vec3 uRidge;
varying vec3 vLocal;
varying vec3 vWorld;
${CLOUD}
float brushFbm(vec2 p) {
  float w = max(length(fwidth(p)), 1e-5);
  float s = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    s += amp * mix(0.5, vnoise(p), 1.0 - smoothstep(0.35, 0.7, w));
    p = p * 2.03 + vec2(17.1, 9.7);
    w *= 2.03;
    amp *= 0.5;
  }
  return s;
}
void main() {
  vec2 xz = vLocal.xz;
  float r = length(xz);
  float calm = calmWeight(vWorld, uCalm);
  vec3 col = mix(uGold, uShade, 0.45);
  float brush = brushFbm(vec2(xz.x * 0.5 + xz.y * 0.2, xz.y * 1.6) + 3.0);
  col = mix(col, uGold, 0.5 * smoothstep(0.35, 0.7, brush) * (1.0 - 0.6 * calm));
  float k = uClear / ${glslFloat(DAUB_FIELD.inner)};
  col = mix(col, mix(uGold, uStraw, 0.6), 0.75 * (1.0 - smoothstep(3.0 * k, 7.5 * k, r)));
  float cs = cloudShadow(xz, uTime) * uCloud / 0.6;
  col = mix(col, mix(uShade, uRidge, 0.25), cs * mix(0.5, 0.25, smoothstep(12.0, 24.0, r)) * (1.0 - 0.5 * calm));
  float haze = smoothstep(34.0, 58.0, r);
  float a = 1.0 - 0.55 * haze;
  col = ((1.0 - haze) * col + 0.45 * haze * uRidge) / a;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const DAUB_VERTEX = /* glsl */ `
${STROKE_SPLAT_GLSL_VERTEX}
uniform float uTime;
uniform float uWind;
uniform float uCloud;
uniform float uClear;
uniform float uCalm;
uniform float uKeep;
uniform float uSize;
uniform float uBoil;
uniform int uBoilStep;
uniform vec3 uGold;
uniform vec3 uStraw;
uniform vec3 uShade;
uniform vec3 uRidge;
varying vec2 vAtlasUv;
varying vec3 vCol;
varying vec3 vDark;
varying float vFade;
const vec3 SUN = vec3(${sun});
const vec2 WIND = vec2(0.9578, 0.2873);
const float FIELD_IN = ${glslFloat(DAUB_FIELD.inner)};
const float FIELD_OUT = ${glslFloat(DAUB_FIELD.outer)};
${CLOUD}
void main() {
  vAtlasUv = vec2(0.0);
  vCol = vec3(0.0);
  vDark = vec3(0.0);
  vFade = 0.0;
  if (splatHidden(uKeep)) {
    gl_Position = splatCulled();
    return;
  }
  float len = aSplatSize.x * uSize;
  float wid = aSplatSize.y * uSize;
  vec3 boil = uBoil * (vec3(splatRandStep(2, uBoilStep), splatRandStep(3, uBoilStep), splatRandStep(4, uBoilStep)) - 0.5);
  vec2 base = aSplatRoot.xz;
  float r0 = max(length(base), 1e-3);
  float r = uClear + (r0 - FIELD_IN) * (FIELD_OUT - uClear) / (FIELD_OUT - FIELD_IN);
  vec2 root = base * (r / r0) + boil.yz * 0.3 * len;
  float ph = splatRand(1) * 6.2831853;
  float yawRest = aSplatRoot.w + 0.4 * boil.x;
  float yaw = yawRest + 0.035 * uWind * sin(uTime * 1.3 + ph);
  vec3 p = splatYaw(splatLocalCorner(position.xy, len, wid), yaw);
  float gust = vnoise(root * 0.07 - WIND * uTime * 0.12) - 0.4;
  float rustle = 0.08 * sin(uTime * 1.6 + ph);
  p.xz += WIND * (gust * 0.7 + rustle) * uWind * splatTip(position.xy) * wid;
  vec4 world = modelMatrix * vec4(root.x + p.x, aSplatRoot.y + p.y, root.y + p.z, 1.0);
  vec4 view = viewMatrix * world;
  vec3 rest = splatYaw(splatLocalNormal(), yawRest);
  float lit = dot(rest, SUN) + (splatRand(5) - 0.5) * 0.35 + uBoil * (splatRandStep(6, uBoilStep) - 0.5) * 0.3;
  float facing = abs(dot(normalize(mat3(modelMatrix) * rest), normalize(cameraPosition - world.xyz)));
  float tone = lit < 0.64 ? 0.0 : (lit < 0.86 ? 1.0 : 2.0);
  bool straw = aSplatSeed.x > 0.5;
  vec3 c0 = mix(uShade, uGold, straw ? 0.7 : 0.35);
  vec3 c1 = straw ? mix(uGold, uStraw, 0.5) : uGold;
  vec3 c2 = straw ? uStraw : mix(uGold, uStraw, 0.6);
  vec3 lit3 = tone < 0.5 ? c0 : (tone < 1.5 ? c1 : c2);
  vec3 shade3 = tone < 1.5 ? c0 : c1;
  float cs = cloudShadow(root, uTime);
  vec3 col = mix(lit3, shade3, smoothstep(0.3, 0.7, cs) * clamp(uCloud / 0.6, 0.0, 1.0));
  col = mix(col, uRidge, 0.2 * cs * uCloud);
  col = mix(col, c1, 0.45 * calmWeight(world.xyz, uCalm));
  float px = len * exportPxPerUnit(-view.z);
  float far = max(1.0 - smoothstep(5.0, 14.0, px), smoothstep(18.0, FIELD_OUT, r));
  vec3 groundHere = mix(mix(uGold, uShade, 0.45), uGold, 0.25);
  col = mix(col, groundHere, far * 0.85);
  vCol = col;
  vDark = mix(col, mix(uShade, groundHere, far), 0.35);
  vFade = (1.0 - smoothstep(FIELD_OUT - 8.0, FIELD_OUT, r)) * smoothstep(1.5, 3.5, -view.z)
    * smoothstep(0.04, 0.16, facing);
  vAtlasUv = splatAtlasUv(uv);
  gl_Position = projectionMatrix * view;
}
`;

// language=GLSL
export const DAUB_FRAGMENT = /* glsl */ `
${STROKE_SPLAT_GLSL_FRAGMENT}
varying vec2 vAtlasUv;
varying vec3 vCol;
varying vec3 vDark;
varying float vFade;
void main() {
  vec2 m = splatMask(vAtlasUv);
  float a = m.y * vFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(vDark, vCol, m.x), a);
  #include <colorspace_fragment>
}
`;
