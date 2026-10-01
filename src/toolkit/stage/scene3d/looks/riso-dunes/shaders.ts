import { glslFloat, LOOK_GLSL_BACKING, LOOK_GLSL_PRINT } from "../../kit";

/** Big-dune spacing over small-dune spacing, and the small dunes' share of the dune height (the approved sketch's 17/6 and 0.42 of 1.3). */
export const SMALL_SPACING = 6 / 17;
export const SMALL_HEIGHT = 0.42 / 1.3;
/** Text calm ring at the stage depth: the outer halo minus the inner one, so calm lands behind a headline above the stage, not on the ink band behind the device. */
export const CALM_RING = { halfWidth: 4.5, inner: 1, outer: 2.6, feather: 0.3 } as const;
/** Ripple wavelength in world units. */
export const RIPPLE_WAVELENGTH = 0.3;

// Dune field shared by both stages: value noise with analytic gradients, so each plate's normal is exact without extra samples.
// language=GLSL
const DUNE_FIELD = /* glsl */ `
uniform float uSmallPhase;
uniform float uBigPhase;
uniform float uClear;
uniform float uReach;
uniform float uHeight;
uniform float uSpacing;
const vec2 WIND = vec2(0.28, 0.96);

vec3 duneNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  ivec2 k = ivec2(i);
  float a = hash21(k);
  float b = hash21(k + ivec2(1, 0));
  float c = hash21(k + ivec2(0, 1));
  float d = hash21(k + ivec2(1, 1));
  float e = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + e * u.x * u.y, du * vec2(b - a + e * u.y, c - a + e * u.x));
}
float duneProfile(float x) {
  float f = fract(x);
  return f < 0.72 ? smoothstep(0.0, 0.72, f) : 1.0 - smoothstep(0.72, 1.0, f);
}
float duneSlope(float x) {
  float f = fract(x);
  float t = f < 0.72 ? f / 0.72 : (f - 0.72) / 0.28;
  return 6.0 * t * (1.0 - t) * (f < 0.72 ? 1.0 / 0.72 : -1.0 / 0.28);
}
vec2 duneStep(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return vec2(t * t * (3.0 - 2.0 * t), 6.0 * t * (1.0 - t) / (b - a));
}

struct DuneField { float u; vec2 du; float s; vec2 ds; float amp; vec2 damp; };
struct DuneSample { float h; vec2 g; float crest; };

DuneField duneField(vec2 p) {
  vec3 wx = duneNoise(p * 0.045);
  vec3 wy = duneNoise(p * 0.045 + vec2(37.2, 11.9));
  vec3 ns = duneNoise(p * 0.07);
  vec3 na = duneNoise(p * 0.03 + 5.0);
  float spacingS = uSpacing * ${glslFloat(SMALL_SPACING)};
  DuneField f;
  f.u = dot(p + (vec2(wx.x, wy.x) - 0.5) * 14.0, WIND);
  f.du = WIND + 0.63 * (WIND.x * wx.yz + WIND.y * wy.yz);
  f.s = f.u / spacingS - uSmallPhase + 0.6 * ns.x;
  f.ds = f.du / spacingS + 0.042 * ns.yz;
  f.amp = 0.4 + 0.6 * na.x;
  f.damp = 0.018 * na.yz;
  return f;
}

// Height, gradient and big-dune profile at p + off, first order in the slow noise fields.
DuneSample duneAt(DuneField f, vec2 p, vec2 off) {
  vec2 q = p + off;
  float r = max(length(q), 1e-3);
  vec2 radial = q / r;
  vec2 inS = duneStep(uClear - 0.5, uClear + 3.0, r);
  vec2 outS = duneStep(uReach + 11.0, uReach + 25.0, r);
  float fadeS = inS.x * (1.0 - outS.x);
  float dFadeS = inS.y * (1.0 - outS.x) - inS.x * outS.y;
  float hS = uHeight * ${glslFloat(SMALL_HEIGHT)};
  float aS = f.s + dot(f.ds, off);
  float pS = duneProfile(aS);
  vec2 inB = duneStep(uReach - 1.0, uReach + 15.0, r);
  float aB = (f.u + dot(f.du, off)) / uSpacing - uBigPhase;
  float pB = duneProfile(aB);
  float amp = f.amp + dot(f.damp, off);
  DuneSample o;
  o.h = pS * hS * fadeS + pB * amp * uHeight * inB.x;
  o.g = hS * (duneSlope(aS) * fadeS * f.ds + pS * dFadeS * radial)
    + uHeight * (duneSlope(aB) * amp * inB.x / uSpacing * f.du + pB * inB.x * f.damp + pB * amp * inB.y * radial);
  o.crest = pB;
  return o;
}
`;

// Paper, its tooth and the text calm ring: all the clearing prints, since no dune or ink reaches it.
// language=GLSL
const PAPER = /* glsl */ `
${LOOK_GLSL_PRINT}
uniform vec3 uPaper;
uniform float uCalm;
varying vec3 vWorld;
const vec2 CALM_OUTER = vec2(${glslFloat(CALM_RING.halfWidth)}, ${glslFloat(CALM_RING.outer)});
const vec2 CALM_INNER = vec2(${glslFloat(CALM_RING.halfWidth)}, ${glslFloat(CALM_RING.inner)});
const float CALM_FEATHER = ${glslFloat(CALM_RING.feather)};
float paperCalm() {
  return clamp(uCalm, 0.0, 1.0) * clamp(stageHalo(vWorld, CALM_OUTER, CALM_FEATHER) - stageHalo(vWorld, CALM_INNER, CALM_FEATHER), 0.0, 1.0);
}
vec3 paper(float calm) {
  return uPaper * (1.0 + printGrain(vWorld.xz, 1.0 / 9.0) * 0.05 * (1.0 - calm));
}
`;

/** Displaces the polar floor by the dune field; dunes on the camera side of the stage sink flat. */
// language=GLSL
export const RISO_VERTEX: string = /* glsl */ `
${DUNE_FIELD}
varying vec3 vWorld;
varying float vSink;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  float sink = stageFade(w.xyz, 0.45, 0.9);
  w.y += duneAt(duneField(w.xz), w.xz, vec2(0.0)).h * sink;
  vWorld = w.xyz;
  vSink = sink;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Two slipped plates, each shaded by the virtual sun and screened against static world grain; light stock inks the shade, dark stock inks the light, and the paper fades into the backing toward the rim (display-space mix, opaque). */
// language=GLSL
export const RISO_FRAGMENT: string = /* glsl */ `
${DUNE_FIELD}
${PAPER}
${LOOK_GLSL_BACKING}
uniform vec3 uBacking;
uniform vec3 uKey;
uniform vec3 uTint;
uniform float uDark;
uniform vec3 uSun;
uniform vec2 uSlip;
uniform float uRipPhase;
uniform float uGrain;
varying float vSink;

float plateTone(DuneSample d) {
  vec3 n = normalize(vec3(-d.g.x * vSink, 1.0, -d.g.y * vSink));
  return dot(n, uSun) - uSun.y;
}

void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  float calm = paperCalm();
  vec2 offA = printSlip(p, uSlip);
  DuneField field = duneField(p);
  DuneSample plateA = duneAt(field, p, offA);
  DuneSample plateB = duneAt(field, p, -offA);
  float toneA = plateTone(plateA);
  float toneB = plateTone(plateB);
  float ripPhase = dot(p, WIND) / ${glslFloat(RIPPLE_WAVELENGTH)} - uRipPhase;
  float ripGuard = 1.0 - smoothstep(0.08, 0.2, fwidth(ripPhase));
  float rip = sin(6.2831853 * fract(ripPhase)) * 0.03 * ripGuard * (1.0 - calm) * smoothstep(0.04, 0.14, abs(toneA));
  float screen = printScreen(p, 1.0 / 22.0, 2.0 * uGrain * (1.0 - calm));
  float polarity = uDark > 0.5 ? 1.0 : -1.0;
  float sinkInk = smoothstep(0.55, 1.0, vSink);
  float nearInk = 1.0 - smoothstep(uReach - 4.5, uReach, r);
  float keyFade = (1.0 - smoothstep(uReach - 4.5, uReach - 1.5, r)) * smoothstep(uClear - 0.5, uClear + 1.5, r) * sinkInk;
  float tintFade = (1.0 - smoothstep(55.0, 85.0, r)) * sinkInk;
  float trough = (1.0 - smoothstep(0.1, 0.55, plateB.crest)) * smoothstep(uReach - 1.0, uReach + 9.0, r);
  float dTint = max(smoothstep(0.03, 0.15, polarity * (toneB + rip)), 0.9 * trough) * tintFade;
  float dKey = smoothstep(0.15, 0.3, polarity * (toneA + rip)) * keyFade;
  vec3 col = paper(calm);
  float inkStrength = 1.0 - calm;
  col = mix(col, mix(mix(uPaper, uTint, 0.3), uTint, nearInk), printInk(dTint, screen) * inkStrength);
  col = mix(col, uKey, printInk(dKey, screen) * inkStrength);
  float rim = smoothstep(75.0, 108.0, r);
  gl_FragColor = vec4(rim > 0.0 ? backingMix(col, uBacking, rim) : col, 1.0);
  #include <colorspace_fragment>
}
`;

/** The bare clearing: the dune fragment's exact output there (no dune, ink or rim fade reaches it) at a fraction of the cost. */
// language=GLSL
export const RISO_CLEARING_FRAGMENT: string = /* glsl */ `
${PAPER}
void main() {
  gl_FragColor = vec4(paper(paperCalm()), 1.0);
  #include <colorspace_fragment>
}
`;
