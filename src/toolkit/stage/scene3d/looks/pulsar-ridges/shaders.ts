import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";

/** Pulsar ridges geometry constants: rings are built at their max and the Rings slider shows the first N, so geometry never rebuilds. */
export const PULSAR = {
  maxRings: 48,
  segments: 512,
  outer: 48,
  floor: -2,
  period: 240,
} as const;

/** The one height function both draws share: h(ring, r, theta, t), closed form, looping exactly at 240 s. Ring 0 is the innermost; rings near the camera sink flat (F11) so a dolly out never raises a ridge over the content. */
// language=GLSL
const HEIGHT = /* glsl */ `
uniform float uTime;
uniform float uRings;
uniform float uValley;
uniform float uHeight;
uniform float uMassifs;
const float PR_TAU = 6.28318530718;
const float PR_PI = 3.14159265359;
float prRadius(float k) {
  float r0 = uValley - 1.5;
  return r0 + (${glslFloat(PULSAR.outer)} - r0) * pow(k / max(uRings - 1.0, 1.0), 1.2);
}
float prRidge(float k, float r, float th) {
  float t = uTime;
  float env = 0.22;
  for (int m = 0; m < 6; m++) {
    if (float(m) >= uMassifs) break;
    float dir = m % 2 == 0 ? 1.0 : -1.0;
    float c = hash11(m * 7 + 1) * PR_TAU + dir * PR_TAU * t / ${glslFloat(PULSAR.period)};
    float w = 0.2 + 0.22 * hash11(m * 7 + 2);
    float d = mod(th - c + PR_PI, PR_TAU) - PR_PI;
    float period = m == 0 ? 20.0 : m == 1 ? 24.0 : m == 2 ? 30.0 : m == 3 ? 40.0 : m == 4 ? 48.0 : 60.0;
    float breathe = 0.72 + 0.28 * sin(PR_TAU * t / period + hash11(m * 7 + 3) * PR_TAU);
    env += exp(-d * d / (2.0 * w * w)) * breathe * (0.7 + 0.3 * hash11(m * 7 + 4));
  }
  int ri = int(k + 0.5);
  float det = 0.0;
  for (int j = 0; j < 6; j++) {
    float n = float(6 + j * 5 + int(hash11(ri * 13 + j) * 4.0));
    float ph = hash11(ri * 31 + j * 3 + 101) * PR_TAU;
    float lane = floor(hash11(ri * 17 + j + 7) * 4.0) - 1.5;
    float laps = sign(lane) * ceil(abs(lane));
    det += sin(n * th + ph + laps * PR_TAU * t / 60.0) / (1.0 + float(j) * 0.45);
  }
  det *= 1.4;
  det = 0.5 + 0.5 * det / (1.0 + abs(det));
  float amp = smoothstep(uValley, uValley + 10.0, r) * min(0.11 * r, 3.8) * (1.0 - 0.7 * smoothstep(40.0, 48.0, r));
  float spike = min(pow(det, 4.0) * 1.6, 1.0);
  return uHeight * amp * (0.04 + 0.05 * det + min(env, 1.2) * (0.1 + 0.9 * spike));
}
vec3 prCrest(float k, float th) {
  float r = prRadius(k);
  vec3 base = vec3(cos(th) * r, ${glslFloat(PULSAR.floor)}, sin(th) * r);
  float courtesy = stageFade((modelMatrix * vec4(base, 1.0)).xyz, 0.55, 0.95);
  return base + vec3(0.0, prRidge(k, r, th) * courtesy, 0.0);
}
`;

/** Skirt strips: position = (theta, ring, v); v 0 on the floor, 1 on the crest. */
// language=GLSL
export const SKIRT_VERTEX = /* glsl */ `
${HEIGHT}
varying vec3 vWorld;
varying float vV;
void main() {
  vec3 c = prCrest(position.y, position.x);
  vec3 local = vec3(c.x, mix(${glslFloat(PULSAR.floor - 0.02)}, c.y, position.z), c.z);
  vec4 w = modelMatrix * vec4(local, 1.0);
  vWorld = w.xyz;
  vV = position.z;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Opaque skirts mix toward the backing tone and write depth, so near ridges hide far ones. */
// language=GLSL
export const SKIRT_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uSkirt;
uniform vec3 uBacking;
varying vec3 vWorld;
varying float vV;
void main() {
  float fade = 1.0 - smoothstep(38.0, 78.0, distance(cameraPosition, vWorld));
  gl_FragColor = vec4(backingMix(uSkirt, uBacking, 1.0 - fade * mix(0.35, 1.0, vV)), 1.0);
  #include <colorspace_fragment>
}
`;

/** Crest ink path: point param (theta, strand); strands run outer to inner so far ink draws first. */
// language=GLSL
export const CREST_PATH = /* glsl */ `
${HEIGHT}
varying float vTone;
vec3 inkPath(vec4 p) { return prCrest(uRings - 1.0 - p.y, p.x); }
`;

// language=GLSL
export const CREST_VERTEX_HOOK = /* glsl */ `
void inkVertex(vec4 p, vec3 world) {
  vTone = clamp((world.y - ${glslFloat(PULSAR.floor)}) / 3.0, 0.0, 1.0);
}
`;

/** Headline band the ink quiets behind: an ellipse around the headline slot above the stage, at its depth, so the ridge body below stays at full strength. */
export const TEXT_BAND = { y: 1.8, halfWidth: 3.2, halfHeight: 0.5 } as const;

/** Ink from Ridge (low) to Crest (peaks), quieted in the headline band and sunk near the camera. */
// language=GLSL
export const CREST_FRAGMENT = /* glsl */ `
uniform vec3 uRidge;
uniform vec3 uCrest;
uniform float uCalm;
varying float vTone;
float prTextBand(vec3 wp) {
  vec3 h = (viewMatrix * vec4(0.0, ${glslFloat(TEXT_BAND.y)}, 0.0, 1.0)).xyz;
  vec3 v = (viewMatrix * vec4(wp, 1.0)).xyz;
  if (h.z > -1e-3 || v.z > -1e-3) return 0.0;
  vec2 q = v.xy * (h.z / v.z) - h.xy;
  float e = length(q / vec2(${glslFloat(TEXT_BAND.halfWidth)}, ${glslFloat(TEXT_BAND.halfHeight)}));
  return 1.0 - smoothstep(0.7, 1.3, e);
}
void main() {
  vec3 ink = mix(uRidge, uCrest, smoothstep(0.1, 0.9, vTone));
  float quiet = 1.0 - 0.8 * clamp(uCalm, 0.0, 1.0) * prTextBand(vWorld);
  float a = inkCoverage() * quiet * stageFade(vWorld, 0.3, 0.6);
  if (a < 0.002) discard;
  gl_FragColor = vec4(ink, a);
  #include <colorspace_fragment>
}
`;
