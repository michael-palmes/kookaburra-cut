import { LOOK_GLSL_RING_BANDS, LOOK_GLSL_RING_EDGE } from "../../kit";

/** Static world grain, applied as about one display code value so dark mist never bands on H.264. `inkGuard` takes a grain cell's pixel footprint (derivatives are taken before any discard) and fades the grain before it nears pixel size. */
// language=GLSL
const INK_GRAIN = /* glsl */ `
float inkGuard(float px) {
  return 1.0 - smoothstep(0.35, 0.7, px);
}
float inkGrain(vec3 p, float guard) {
  return (vnoise3(p) - 0.5) * guard;
}
vec3 inkDither(vec3 c, float g) {
  return c + g * (4.0 / 255.0) * 2.2 * pow(max(c, vec3(1e-4)), vec3(0.545));
}
`;

/** Sky wall: horizon mist thinning to the backing, with the sun or moon disc on a fixed bearing. */
// language=GLSL
export const SKY_FRAGMENT = /* glsl */ `
${INK_GRAIN}
uniform vec3 uMist;
uniform vec3 uSun;
uniform vec3 uDiscDir;
uniform float uDiscR;
uniform float uMistH;
varying vec3 vWorld;
void main() {
  vec3 dir = normalize(vWorld);
  float grainGuard = inkGuard(length(fwidth(dir)) * 160.0);
  float e = dir.y;
  float a = 1.0 - (0.85 * smoothstep(0.0, uMistH, e) + 0.15 * smoothstep(uMistH, 0.5, e));
  vec3 col = uMist;
  if (uDiscR > 0.0) {
    float th = length(dir - uDiscDir);
    float halo = (1.0 - smoothstep(uDiscR, uDiscR * 1.33, th)) * 0.18;
    a = halo + a * (1.0 - halo);
    float core = 1.0 - aaStep(uDiscR, th);
    float outA = core + a * (1.0 - core);
    col = (uSun * core + uMist * a * (1.0 - core)) / max(outA, 1e-4);
    a = outA;
  }
  if (a < 0.002) discard;
  col = inkDither(col, inkGrain(dir * 160.0, grainGuard));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Valley floor: a mist wash over the backing, pooling at each ridge's foot, paler under the stage, full mist far out. */
// language=GLSL
export const FLOOR_FRAGMENT = /* glsl */ `
${LOOK_GLSL_RING_BANDS}
${INK_GRAIN}
uniform vec3 uMist;
uniform vec3 uNear;
uniform float uPoolR[RING_BANDS_MAX];
uniform vec2 uLumpDrift;
uniform vec2 uWashDrift;
uniform float uPools;
varying vec3 vRing;
void main() {
  vec2 xz = vRing.xz;
  float r = length(xz);
  float pools = 0.0;
  float nearR = 1e4;
  for (int i = 0; i < RING_BANDS_MAX; i++) {
    float R = uPoolR[i];
    if (R <= 0.0) continue;
    nearR = min(nearR, R);
    pools = max(pools, smoothstep(R - 7.0, R - 0.4, r) * (1.0 - smoothstep(R + 0.4, R + 3.0, r)));
  }
  float valley = smoothstep(nearR - 6.0, nearR, r);
  float lump = fbm(xz * 0.09 + uLumpDrift);
  float w0 = 0.22 + 0.28 * smoothstep(5.0, 15.0, r) + uPools * pools * smoothstep(0.35, 0.7, lump);
  w0 = mix(w0, 1.0, valley * valley);
  float wash = fbm(xz * 0.12 + uWashDrift);
  float k = 0.12 * smoothstep(0.45, 0.75, wash) * smoothstep(5.0, 12.0, r)
    * (1.0 - smoothstep(36.0, 44.0, r));
  float w = 1.0 - (1.0 - k) * (1.0 - w0);
  vec3 col = ((1.0 - k) * w0 * uMist + k * uNear) / max(w, 1e-4);
  float s = smoothstep(40.0, 70.0, r);
  float w2 = 1.0 - (1.0 - s) * (1.0 - w);
  col = ((1.0 - s) * w * col + s * uMist) / max(w2, 1e-4);
  float fxz = length(fwidth(xz));
  float g = inkGrain(vec3(xz * 6.0, 0.0), inkGuard(fxz * 6.0));
  w2 = clamp(w2 + g * 0.12 * (1.0 - w2), 0.0, 1.0);
  col = inkDither(col, inkGrain(vec3(xz * 2.5, 3.0), inkGuard(fxz * 2.5)));
  gl_FragColor = vec4(col, w2);
  #include <colorspace_fragment>
}
`;

/** Ridge bands: a circle-sampled crest cut wet or hard, pigment pooled at the crest, mist rising from the foot with drifting wisps, and eye-level haze. */
// language=GLSL
export const RIDGE_FRAGMENT = /* glsl */ `
${LOOK_GLSL_RING_BANDS}
${LOOK_GLSL_RING_EDGE}
${INK_GRAIN}
uniform vec3 uBandCol[RING_BANDS_MAX];
uniform float uBandLo[RING_BANDS_MAX];
uniform float uBandHi[RING_BANDS_MAX];
uniform float uBandFreq[RING_BANDS_MAX];
uniform float uBandSeed[RING_BANDS_MAX];
uniform float uBandWisp[RING_BANDS_MAX];
uniform vec3 uMist;
uniform float uHard;
uniform float uFootK;
uniform float uFogH;
uniform float uFloorY;
uniform float uBreathe;
uniform float uHaze;
varying vec3 vWorld;
varying vec3 vRing;
varying float vRingBand;
varying float vRingFade;
void main() {
  int b = int(floor(vRingBand + 0.5));
  float kf = float(b);
  float r = length(vRing.xz);
  vec2 dir = vRing.xz / max(r, 1e-4);
  float lo = uBandLo[b];
  float hi = uBandHi[b];
  float seed = uBandSeed[b];
  float crest = ringCrest(dir, lo, hi, uBandFreq[b], seed);
  float d = crest - vRing.y;
  float bleed = (vnoise(dir * r * 1.1 + vec2(seed, 0.0)) - 0.5) * 0.12;
  float bleedW = 0.05 + 0.09 * vnoise(dir * r * 0.6 + vec2(seed + 3.0, 7.0));
  float a = ringEdge(d, uHard, bleed, bleedW);
  float fw = max(fwidth(d), 1e-5);
  float fr = length(fwidth(vRing));
  if (a < 0.002) discard;

  float foot = lo - uFootK * (hi - lo) + 0.35 * sin(uBreathe + kf * 1.7);
  float depthN = clamp(d / max(crest - foot, 0.3), 0.0, 1.5);
  vec3 wp = ringRotate(vRing, uBandWisp[b]);
  float wisp = fbm3(vec3(wp.x * 0.18, wp.y * 1.4 + kf * 5.0, wp.z * 0.18));
  float mist = smoothstep(0.22, 1.0, depthN + (wisp - 0.5) * 0.5);
  float fog = 1.0 - smoothstep(0.0, uFogH, vRing.y - uFloorY + (wisp - 0.5) * uFogH);
  mist = max(mist, fog);

  float pool = exp(-max(d, 0.0) / 0.3) * (1.0 - uHard);
  float gran = inkGrain(vRing * 4.0, inkGuard(fr * 4.0)) * (1.0 - uHard);
  float body = 0.18 * (1.0 - pool) + gran * 0.16;
  vec3 col = mix(uBandCol[b], uMist, clamp(body + mist * (1.0 - 0.35 * uHard), 0.0, 1.0));
  float edgeW = max(0.03, fw);
  float cut = 1.0 - smoothstep(edgeW - fw, edgeW + fw, abs(d - edgeW * 1.4));
  col = mix(col, uMist, 0.3 * uHard * cut * (1.0 - mist));
  float elev = vWorld.y / max(length(vWorld.xz), 1e-3);
  col = mix(col, uMist, uHaze * (1.0 - smoothstep(0.08, 0.17, elev)));
  col = inkDither(col, inkGrain(vRing * 7.0, inkGuard(fr * 7.0)) * mist);
  gl_FragColor = vec4(col, a * stageFade(vWorld) * vRingFade);
  #include <colorspace_fragment>
}
`;
