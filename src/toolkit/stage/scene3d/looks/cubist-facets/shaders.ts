import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";

/** Near fade window (fractions of the camera-to-stage distance) shared by every part. */
export const CUBIST_FADE = { near: 0.6, far: 0.95 } as const;

/** Eye-level haze band in degrees of elevation from the camera: landscape, then fully portrait (it rises to meet the higher headline). */
export const CUBIST_HAZE_BAND = {
  landscape: [-6, 9],
  portrait: [8, 19],
  feather: 6,
} as const;

/** Contour half width in world units: about 3 px wide at 1080p across the ring, fading rather than thinning once under a pixel. */
export const CUBIST_LINE_HALF_WIDTH = 0.03;

// language=GLSL
const SHARED = /* glsl */ `
uniform vec3 uOchre;
uniform vec3 uUmber;
uniform vec3 uGrey;
uniform vec3 uPale;
uniform vec3 uBacking;
uniform float uHaze;
const float CF_FADE_NEAR = ${glslFloat(CUBIST_FADE.near)};
const float CF_FADE_FAR = ${glslFloat(CUBIST_FADE.far)};
float cfPortrait() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  return 1.0 - smoothstep(0.6, 1.2, aspect);
}
float cfHazeBand(vec3 wp) {
  float p = cfPortrait();
  float lo = mix(${glslFloat(CUBIST_HAZE_BAND.landscape[0])}, ${glslFloat(CUBIST_HAZE_BAND.portrait[0])}, p);
  float hi = mix(${glslFloat(CUBIST_HAZE_BAND.landscape[1])}, ${glslFloat(CUBIST_HAZE_BAND.portrait[1])}, p);
  vec3 d = wp - cameraPosition;
  float ev = degrees(atan(d.y, length(d.xz)));
  float f = ${glslFloat(CUBIST_HAZE_BAND.feather)};
  return smoothstep(lo - f, lo, ev) * (1.0 - smoothstep(hi, hi + f, ev));
}
vec3 cfMid() { return mix(uGrey, uOchre, 0.5); }
`;

// language=GLSL
export const RELIEF_VERTEX = /* glsl */ `
uniform float uBreath;
uniform float uBreathPhase;
attribute vec3 aHalf;
attribute vec3 aCell;
attribute vec3 aBary;
attribute vec3 aEdge;
attribute vec2 aMod;
attribute vec3 aSeed;
varying vec3 vWorld;
varying vec3 vHalf;
varying vec3 vCell;
varying vec3 vBary;
varying vec3 vEdge;
varying vec2 vMod;
varying vec3 vSeed;
void main() {
  float d = uBreath * sin(uBreathPhase + aSeed.y * 6.28318530718);
  vec4 w = modelMatrix * vec4(position + aCell * d, 1.0);
  vWorld = w.xyz;
  vHalf = aHalf;
  vCell = aCell;
  vBary = aBary;
  vEdge = aEdge;
  vMod = aMod;
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** The relief: a four-step tonal ramp set by each half's fold against a turning light, crease modelling, passage fades at some top edges, world-width contours and the eye-level haze. */
// language=GLSL
export const RELIEF_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${SHARED}
uniform vec3 uLight;
uniform float uPassage;
uniform float uLineHalf;
varying vec3 vWorld;
varying vec3 vHalf;
varying vec3 vCell;
varying vec3 vBary;
varying vec3 vEdge;
varying vec2 vMod;
varying vec3 vSeed;
float cfStep(float th, float x) { return smoothstep(th - 0.05, th + 0.05, x); }
float cfLine(float d, float hw) {
  float w = max(fwidth(d), 1e-5);
  float hwe = max(hw, w * 0.75);
  return (1.0 - smoothstep(hwe - w, hwe + w, d)) * clamp(hw / hwe, 0.0, 1.0);
}
void main() {
  float c0 = dot(normalize(vCell), uLight);
  float k = dot(normalize(vHalf), uLight) - c0;
  float x = 0.7 * c0 + 3.2 * k + (vSeed.x - 0.5) * 0.15;
  vec3 s0 = mix(uUmber, uGrey, 0.3);
  vec3 s3 = mix(uOchre, uPale, 0.55);
  vec3 col = s0;
  col = mix(col, uGrey, cfStep(-0.45, x));
  col = mix(col, uOchre, cfStep(0.05, x));
  col = mix(col, s3, cfStep(0.55, x));
  vec3 mid = cfMid();
  float nearCrease = 1.0 - smoothstep(0.0, 0.55, vMod.x);
  col = mix(col, k < 0.0 ? s0 : s3, 0.4 * nearCrease * smoothstep(0.0, 0.04, abs(k)));
  float passage = clamp((uPassage - vSeed.z) / 0.04, 0.0, 1.0);
  col = mix(col, mid, passage * (1.0 - smoothstep(0.0, 0.4, vMod.y)));
  vec2 g = vWorld.xy * 0.3 + vWorld.z * 0.17;
  col *= 1.0 + (0.6 * vnoise(g) + 0.4 * vnoise(g * 2.03 + 17.1) - 0.5) * 0.05;
  float line = 0.0;
  for (int i = 0; i < 3; i++) {
    if (vEdge[i] > 0.0) line = max(line, cfLine(vBary[i] * vEdge[i], uLineHalf));
  }
  float band = cfHazeBand(vWorld);
  vec3 haze = mix(mid, uPale, 0.3);
  col = mix(col, haze, clamp(uHaze * band, 0.0, 1.0));
  col = mix(col, mix(uUmber, s0, 0.3), 0.7 * line * (1.0 - 0.4 * uHaze * band));
  col = backingMix(col, uBacking, smoothstep(9.0, 11.2, vWorld.y));
  float a = stageFade(vWorld, CF_FADE_NEAR, CF_FADE_FAR);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** The sky behind the courses: a recess tone through the courses' height (so a gap between cells reads as depth while the camera is inside the ring) and in the haze band (a soft ground at their foot), the backing elsewhere. */
// language=GLSL
export const SKY_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${SHARED}
uniform float uRadius;
varying vec3 vSkyDir;
varying vec3 vWorld;
void main() {
  float y = normalize(vSkyDir).y;
  float inside = 1.0 - smoothstep(uRadius - 4.0, uRadius + 2.0, length(cameraPosition.xz));
  float recess = smoothstep(-0.16, -0.06, y) * (1.0 - smoothstep(0.34, 0.46, y)) * inside;
  float k = max(0.85 * recess, 0.5 * cfHazeBand(vWorld) * min(uHaze / 0.7, 1.0));
  gl_FragColor = vec4(backingMix(uBacking, mix(uGrey, uOchre, 0.4), k), 1.0);
  #include <colorspace_fragment>
}
`;
