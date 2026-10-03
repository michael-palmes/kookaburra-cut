import { glslFloat, LOOK_GLSL_BACKING, LOOK_GLSL_INSTANCE_ANCHOR } from "../../kit";
import { LOUVRE } from "./louvre";

// language=GLSL
const SHARED = /* glsl */ `
varying vec3 vWorld;
varying vec3 vN;
varying float vFace;
varying float vGuard;
`;

/** Slats: static anchors on the ring, each posed in the vertex stage from its angle, row and the sweep phase (`lrTurn` mirrors `louvreTurn`). */
// language=GLSL
export const SLAT_VERTEX: string = /* glsl */ `
${LOOK_GLSL_INSTANCE_ANCHOR}
${SHARED}
const float LR_TAU = 6.28318530718;
const float LR_PI = 3.14159265359;
uniform float uPhase;
uniform float uFront;
uniform float uRowLag;
uniform float uRowPitch;
uniform float uSlatH;
uniform float uSlatW;
uniform float uPitch;
float lrTurn(float u) {
  float k = clamp(u / uFront, 0.0, 1.0);
  float turn = LR_TAU * k * k * k * (k * (k * 6.0 - 15.0) + 10.0);
  float s = clamp((u - uFront) / min(uFront * ${glslFloat(LOUVRE.tail)}, 1.0 - uFront), 0.0, 1.0);
  return turn + ${glslFloat(6.75 * LOUVRE.sway)} * s * (1.0 - s) * (1.0 - s) * sin(3.0 * LR_PI * s);
}
vec3 lrRotY(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
void main() {
  vec3 anchor = lookInstanceAnchor();
  float theta = atan(anchor.z, anchor.x);
  float row = floor((anchor.y - ${glslFloat(LOUVRE.bottom)}) / uRowPitch + 0.5);
  float u = fract(uPhase - theta / LR_TAU - row * uRowLag);
  float a = atan(-cos(theta), -sin(theta)) + lrTurn(u);
  vec3 tangent = vec3(-sin(theta), 0.0, cos(theta)) * uPitch;
  vec3 mid = anchor + vec3(0.0, 0.5 * uSlatH, 0.0);
  vec4 c0 = projectionMatrix * viewMatrix * modelMatrix * vec4(mid, 1.0);
  vec4 c1 = projectionMatrix * viewMatrix * modelMatrix * vec4(mid + tangent, 1.0);
  vec2 aspect = vec2(projectionMatrix[1][1] / projectionMatrix[0][0], 1.0);
  float periodPx = c0.w > 0.1 && c1.w > 0.1
    ? length((c1.xy / c1.w - c0.xy / c0.w) * aspect) * 0.5 * uResolution.y
    : 100.0;
  vGuard = smoothstep(2.5, 7.0, periodPx);
  vec3 p = position * vec3(mix(uPitch, uSlatW, vGuard), uSlatH, ${glslFloat(LOUVRE.depth)});
  vec4 w = modelMatrix * vec4(lrRotY(p, a) + anchor, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * lrRotY(normal, a));
  vFace = abs(normal.z) > 0.5 ? sign(normal.z) : 0.0;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** The top rail: a plain ring ribbon in the Frame colour. */
// language=GLSL
export const RAIL_VERTEX: string = /* glsl */ `
${SHARED}
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vFace = 0.0;
  vGuard = 1.0;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Fixed virtual-light shading toward the backing (lit faces toward a light backing, unlit faces toward a dark one), the pitch guard's mean tone, floor and top fades and a hard near cut. */
// language=GLSL
export const LOUVRE_FRAGMENT: string = /* glsl */ `
${LOOK_GLSL_BACKING}
${SHARED}
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uFrame;
uniform vec3 uBacking;
uniform vec3 uSun;
uniform float uLightMode;
uniform float uTop;
void main() {
  float f = stageFade(vWorld, 0.8, 0.98);
  float a = stageCut(vWorld, 0.8, 0.98);
  if (a < 0.01) discard;
  vec3 n = normalize(vN);
  float lit = clamp(dot(n, normalize(uSun)) * 0.5 + 0.5, 0.0, 1.0);
  vec3 face = vFace > 0.5 ? uA : (vFace < -0.5 ? uB : uFrame);
  vec3 col = backingMix(face, uBacking, mix(1.0 - lit, lit, uLightMode) * 0.55);
  col = mix(backingMix(face, uBacking, 0.6), col, vGuard);
  float y = vWorld.y;
  float rise = smoothstep(${glslFloat(LOUVRE.bottom)}, ${glslFloat(LOUVRE.bottom + 3.2)}, y);
  float crown = 1.0 - smoothstep(uTop - 1.0, uTop + 0.4, y);
  col = backingMix(col, uBacking, 0.8 * (1.0 - rise * crown));
  col = backingMix(col, uBacking, 1.0 - smoothstep(0.5, 1.0, f));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;
