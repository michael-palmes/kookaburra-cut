import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { PENDULUM } from "./pendulum";

/** F11 window (fractions of the camera-to-stage distance) shared by bobs, threads and rails. */
export const RING_FADE = { near: 0.74, far: 0.96 } as const;

const FADE = `${glslFloat(RING_FADE.near)}, ${glslFloat(RING_FADE.far)}`;

/** Pendulum `s` hangs from rail k at angle phi (0 = +z), swings along the rail and makes (base + tri) swings per period. */
// language=GLSL
const POSE = /* glsl */ `
#ifndef PR_POSE
#define PR_POSE
const float PR_TAU = 6.28318530718;
uniform float uCount;
uniform float uRadius;
uniform float uSwing;
uniform float uBase;
uniform float uPhase;
vec3 prRail(float s) {
  float k = 0.0;
  float i = s;
  float n = uCount;
  for (int r = 0; r < ${PENDULUM.maxRails - 1}; r++) {
    if (i < n) break;
    i -= n;
    k += 1.0;
    n += ${glslFloat(PENDULUM.extraPerRail)};
  }
  return vec3(k, i, n);
}
void prPose(float s, out vec3 P, out vec3 B, out vec3 X, out vec3 Y, out vec3 Z) {
  vec3 rail = prRail(s);
  float k = rail.x;
  float i = rail.y;
  float n = rail.z;
  float phi = PR_TAU * i / n;
  float tri = min(i, n - i);
  float L = mix(${glslFloat(PENDULUM.lengthMax)}, ${glslFloat(PENDULUM.lengthMin)}, tri / (n * 0.5));
  float amp = asin(min(uSwing / L, 1.0));
  float th = amp * cos(PR_TAU * fract((uBase + tri) * uPhase));
  vec3 tang = vec3(cos(phi), 0.0, -sin(phi));
  Z = vec3(sin(phi), 0.0, cos(phi));
  float R = uRadius + ${glslFloat(PENDULUM.railStep)} * k;
  P = vec3(Z.x * R, ${glslFloat(PENDULUM.railY)} + ${glslFloat(PENDULUM.railStep)} * k, Z.z * R);
  Y = -sin(th) * tang + cos(th) * vec3(0.0, 1.0, 0.0);
  X = cos(th) * tang + sin(th) * vec3(0.0, 1.0, 0.0);
  B = P - L * Y;
}
#endif
`;

/** Turned brass from the virtual sun: half-Lambert, a glint and a fresnel rim toward Sheen; near parts cut with a hard antialiased edge (alpha to coverage) and fade their tone to the backing. */
// language=GLSL
const BRASS = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uSheen;
uniform vec3 uSun;
uniform vec3 uBacking;
vec4 prBrass(vec3 base, vec3 N, vec3 wp, float body, float glint, float rim) {
  vec3 V = normalize(cameraPosition - wp);
  vec3 L = normalize(uSun);
  float lam = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float spec = pow(max(dot(N, normalize(L + V)), 0.0), 28.0);
  float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 3.0);
  float sheen = clamp(lam * lam * body + spec * glint + fres * rim, 0.0, 1.0);
  vec3 col = mix(base, uSheen, sheen);
  float fade = stageFade(wp, ${FADE});
  col = backingMix(col, uBacking, 1.0 - fade);
  return vec4(col, stageCut(wp, ${FADE}));
}
`;

// language=GLSL
export const BOB_VERTEX = /* glsl */ `
${POSE}
attribute float aPendulum;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec3 P, B, X, Y, Z;
  prPose(aPendulum, P, B, X, Y, Z);
  vec4 w = modelMatrix * vec4(B + X * position.x + Y * position.y + Z * position.z, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * (X * normal.x + Y * normal.y + Z * normal.z));
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const BOB_FRAGMENT = /* glsl */ `
${BRASS}
uniform vec3 uBob;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec4 c = prBrass(uBob, normalize(vNormalW), vWorld, 0.55, 0.9, 0.3);
  if (c.a < 0.01) discard;
  gl_FragColor = c;
  #include <colorspace_fragment>
}
`;

/** Ink path: strand data x is the pendulum, param x runs 0 at the bob to 1 at the rail. */
// language=GLSL
export const THREAD_PATH = /* glsl */ `
${POSE}
vec3 inkPath(vec4 p) {
  vec3 P, B, X, Y, Z;
  prPose(inkStrand.x, P, B, X, Y, Z);
  return mix(B, P, p.x);
}
`;

// language=GLSL
export const THREAD_FRAGMENT = /* glsl */ `
uniform vec3 uThread;
uniform float uOpacity;
void main() {
  float a = inkCoverage() * uOpacity * stageFade(vWorld, ${FADE});
  if (a < 0.003) discard;
  gl_FragColor = vec4(uThread, a);
  #include <colorspace_fragment>
}
`;

/** Rails: a unit torus (ring in xy, radius 1) re-expanded per instance to rail k's radius and height, tube width kept. */
// language=GLSL
export const RAIL_VERTEX = /* glsl */ `
uniform float uRadius;
attribute float aRail;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec2 c = normalize(position.xy);
  vec3 off = position - vec3(c, 0.0);
  float R = uRadius + ${glslFloat(PENDULUM.railStep)} * aRail;
  float y = ${glslFloat(PENDULUM.railY)} + ${glslFloat(PENDULUM.railStep)} * aRail;
  vec3 local = vec3(c.x * R + off.x, y + off.z, -(c.y * R + off.y));
  vec4 w = modelMatrix * vec4(local, 1.0);
  vWorld = w.xyz;
  vNormalW = normalize(mat3(modelMatrix) * vec3(normal.x, normal.z, -normal.y));
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const RAIL_FRAGMENT = /* glsl */ `
${BRASS}
uniform vec3 uRail;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec4 c = prBrass(uRail, normalize(vNormalW), vWorld, 0.0, 0.6, 0.0);
  if (c.a < 0.01) discard;
  gl_FragColor = c;
  #include <colorspace_fragment>
}
`;
