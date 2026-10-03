import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { RAIN_FALL_PERIOD, RAIN_FLOOR_Y, RAIN_PUDDLE_PERIOD, RAIN_VEILS, rainSpan } from "./rain";

const [NEAR, FAR] = RAIN_VEILS;

/** Fade shared by every part: nothing nearer the camera than the stage. */
// language=GLSL
const RAIN_COMMON = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uBacking;
float hrKeep(vec3 wp) {
  return stageFade(wp, 0.8, 1.05);
}
`;

/** Streak path: point param (angle, radius, phase, end); strand data (veil, length, laps, ink). Each streak falls down its camera-turned slant a whole number of spans per period, so the fall loops exactly. */
// language=GLSL
export const STREAK_PATH = /* glsl */ `
uniform float uFall;
uniform vec2 uSlant;
vec3 inkPath(vec4 p) {
  bool nearV = inkStrand.x < 0.5;
  float span = nearV ? ${glslFloat(rainSpan(NEAR))} : ${glslFloat(rainSpan(FAR))};
  float top = nearV ? ${glslFloat(NEAR.top)} : ${glslFloat(FAR.top)};
  float fall = span * fract(inkStrand.z * uFall / ${glslFloat(RAIN_FALL_PERIOD)} + p.z);
  vec3 c = vec3(cos(p.x) * p.y, top, sin(p.x) * p.y);
  vec3 cam = transpose(mat3(modelMatrix)) * (cameraPosition - modelMatrix[3].xyz);
  vec3 toCam = cam - c;
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
  float ang = nearV ? uSlant.x : uSlant.y;
  vec3 dir = vec3(0.0, cos(ang), 0.0) + right * sin(ang);
  return c - dir * (fall / cos(ang)) + dir * p.w * inkStrand.y;
}
`;

// language=GLSL
export const STREAK_WIDTH = /* glsl */ `
vec2 inkWidth(vec4 p, vec3 world) {
  return vec2(inkStrand.x < 0.5 ? 0.032 : 0.048, 1.0);
}
`;

/** Streaks taper at both ends, fade in above the floor and out below their top, and pale toward the backing with distance. */
// language=GLSL
export const STREAK_FRAGMENT = /* glsl */ `
${RAIN_COMMON}
uniform vec3 uNear;
uniform vec3 uFar;
uniform vec2 uInk;
void main() {
  bool nearV = vInkStrand.x < 0.5;
  float top = nearV ? ${glslFloat(NEAR.top)} : ${glslFloat(FAR.top)};
  float taper = smoothstep(0.0, 0.35, vInkAlong) * (1.0 - smoothstep(0.75, 1.0, vInkAlong));
  float rise = smoothstep(${glslFloat(RAIN_FLOOR_Y)}, ${glslFloat(RAIN_FLOOR_Y + 0.9)}, vWorld.y);
  float fall = 1.0 - smoothstep(top - 7.0, top - 1.5, vWorld.y);
  float dist = distance(cameraPosition, vWorld);
  float ink = vInkStrand.w * (nearV ? uInk.x : uInk.y) * (1.0 - 0.6 * smoothstep(40.0, 70.0, dist));
  float a = inkCoverage() * taper * rise * fall * hrKeep(vWorld);
  if (a < 0.003) discard;
  gl_FragColor = vec4(backingMix(nearV ? uNear : uFar, uBacking, 1.0 - ink), a);
  #include <colorspace_fragment>
}
`;

/** Puddle slots: each cycle hashes a new spot from (slot, cycle), wrapped so the slots repeat over RAIN_PUDDLE_PERIOD. */
// language=GLSL
export const PUDDLE_VERTEX = /* glsl */ `
uniform float uPuddleTime;
attribute vec4 aSeed;
varying vec2 vLocal;
varying float vTau;
varying float vOn;
varying float vSize;
varying vec3 vWorld;
void main() {
  float u = (uPuddleTime + aSeed.z) / aSeed.y;
  int cyc = int(mod(floor(u), ${glslFloat(RAIN_PUDDLE_PERIOD)} / aSeed.y));
  int slot = int(aSeed.x);
  vec2 h = hash22(ivec2(slot * 131 + 7, cyc + 4096));
  vTau = fract(u);
  vOn = step(hash11(slot * 977 + cyc * 13 + 5), 0.62);
  vSize = aSeed.w;
  float r = mix(5.5, 26.0, sqrt(h.x));
  float ang = h.y * 6.28318530718;
  vec3 c = vec3(cos(ang) * r, ${glslFloat(RAIN_FLOOR_Y + 0.01)}, sin(ang) * r);
  vLocal = position.xz;
  vec4 w = modelMatrix * vec4(c + vec3(position.x, 0.0, position.z) * vSize, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Two rings open and pale toward the backing over each cycle. */
// language=GLSL
export const PUDDLE_FRAGMENT = /* glsl */ `
${RAIN_COMMON}
uniform vec3 uPuddle;
uniform float uPuddleInk;
varying vec2 vLocal;
varying float vTau;
varying float vOn;
varying float vSize;
varying vec3 vWorld;
float hrRing(float d, float rad, float hw) {
  float s = d - rad;
  float fw = max(fwidth(s), 1e-5);
  float dh = max(hw, fw * 0.6);
  return clamp((dh - abs(s)) / fw + 0.5, 0.0, 1.0) * (hw / dh);
}
void main() {
  float d = length(vLocal);
  float grow = 1.0 - pow(1.0 - vTau, 2.2);
  float hw = 0.035 / vSize;
  float ring = max(hrRing(d, 0.92 * grow, hw), hrRing(d, 0.55 * grow, hw) * 0.7);
  float life = pow(1.0 - vTau, 1.6) * smoothstep(0.0, 0.05, vTau);
  float a = ring * vOn * step(d, 1.0) * hrKeep(vWorld);
  if (a < 0.003 || life < 0.004) discard;
  gl_FragColor = vec4(backingMix(uPuddle, uBacking, 1.0 - uPuddleInk * life), a);
  #include <colorspace_fragment>
}
`;

/** The far horizon: a faint ring in the Puddle colour. */
// language=GLSL
export const HORIZON_FRAGMENT = /* glsl */ `
${RAIN_COMMON}
uniform vec3 uPuddle;
uniform float uHorizonInk;
void main() {
  float a = inkCoverage() * stageFade(vWorld, 0.8, 1.05);
  if (a < 0.003) discard;
  gl_FragColor = vec4(backingMix(uPuddle, uBacking, 1.0 - uHorizonInk), a);
  #include <colorspace_fragment>
}
`;
