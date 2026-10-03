import { LOOK_GLSL_DISH } from "../../kit/dish";
import { glslFloat, LOOK_GLSL_BACKING } from "../../kit/glsl";
import { SAND } from "./rose";

// language=GLSL
const DISH = /* glsl */ `
${LOOK_GLSL_DISH}
uniform vec3 uDish;
`;

/** Sand shading shared by the floor and the grooves, so a groove's feathered edge lands on the floor's exact tone: grain, the dish facing the virtual sun, the ball's soft shadow and the two-way groove/ridge ramp. */
// language=GLSL
const SAND_FRAGMENT_COMMON = /* glsl */ `
${LOOK_GLSL_BACKING}
${DISH}
uniform vec3 uSand;
uniform vec3 uGroove;
uniform vec3 uRidge;
uniform vec3 uBacking;
uniform vec3 uSun;
uniform vec3 uBall;
uniform float uFadeStart;
uniform float uFadeEnd;
float sandShadow(vec3 wp) {
  vec2 c = uBall.xz - uSun.xz / max(uSun.y, 0.2) * 0.25;
  return 1.0 - smoothstep(0.12, 0.55, length(wp.xz - c));
}
float sandBase(vec3 wp, vec3 up) {
  vec2 p = wp.xz;
  vec2 g1 = mat2(0.866, 0.5, -0.5, 0.866) * p * 15.0;
  vec2 g2 = mat2(0.94, -0.342, 0.342, 0.94) * p * 26.0;
  float k1 = pitchGuard(g1);
  float k2 = pitchGuard(g2);
  float grain = (vnoise(p * 0.9) - 0.5) * 0.25;
  if (k1 > 0.0) grain += (vnoise(g1) - 0.5) * k1 * 0.65;
  if (k2 > 0.0) grain += (vnoise(g2) - 0.5) * k2 * 0.65;
  float body = (dot(up, uSun) - uSun.y) / 0.46 * 0.3;
  return grain * 0.35 + body - 0.55 * sandShadow(wp);
}
vec3 sandTone(float k) {
  return k < 0.0 ? mix(uSand, uGroove, min(-k, 1.0)) : mix(uSand, uRidge, min(k, 1.0));
}
vec3 sandFinish(vec3 col, vec3 wp, vec3 up) {
  float far = smoothstep(uFadeStart, uFadeEnd, length(wp.xz));
  return backingMix(col, uBacking, max(far, dishEdgeOn(wp, up)));
}
`;

// language=GLSL
export const FLOOR_FRAGMENT = /* glsl */ `
${SAND_FRAGMENT_COMMON}
varying vec3 vWorld;
void main() {
  vec3 up = dishNormal(vWorld.xz, uDish);
  vec3 col = sandTone(sandBase(vWorld, up));
  gl_FragColor = vec4(sandFinish(col, vWorld, up), 1.0);
  #include <colorspace_fragment>
}
`;

/** The whole loop's groove ribbon: `position` is (path fraction, side -1..1). The rose and its tangent are closed form here, so the Clearing, Reach and Petals sliders never rebuild geometry. */
// language=GLSL
export const RIBBON_VERTEX = /* glsl */ `
${DISH}
uniform float uClear;
uniform float uReach;
uniform float uPetals;
uniform float uHalfWidth;
varying vec3 vWorld;
varying float vS;
varying float vV;
varying vec2 vSide;
const float ST_TAU = 6.28318530718;
void main() {
  float u = position.x;
  float mid = 0.5 * (uClear + uReach);
  float span = 0.5 * (uReach - uClear);
  float ph = ST_TAU * fract(uPetals * u);
  float r = mid + span * cos(ph);
  float a = ${glslFloat(SAND.startAngle)} + ST_TAU * fract(${glslFloat(SAND.turns)} * u);
  vec2 radial = vec2(sin(a), -cos(a));
  vec2 around = vec2(cos(a), sin(a));
  vec2 tangent = normalize(-span * uPetals * sin(ph) * radial + r * ${glslFloat(SAND.turns)} * around);
  vec2 side = vec2(-tangent.y, tangent.x);
  vec2 p = radial * r + side * uHalfWidth * position.y;
  vec4 w = modelMatrix * vec4(p.x, ${glslFloat(SAND.floorY)} + dishHeight(length(p), uDish) + 0.012, p.y, 1.0);
  vWorld = w.xyz;
  vS = u * ${glslFloat(SAND.loop)};
  vV = position.y;
  vSide = side;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Six-groove raked band: a sine profile shaded against the virtual sun, live while younger than the memory and relaxing flat after. Grooves past pixel pitch or seen at grazing angles fall to a flat band tone (darker on light sand, lighter on dark). */
// language=GLSL
export const RIBBON_FRAGMENT = /* glsl */ `
${SAND_FRAGMENT_COMMON}
uniform float uTm;
uniform float uMemory;
uniform float uGrooves;
uniform float uHalfWidth;
uniform float uBandSign;
varying vec3 vWorld;
varying float vS;
varying float vV;
varying vec2 vSide;
void main() {
  float age = mod(uTm - vS, ${glslFloat(SAND.loop)});
  float life = 1.0 - smoothstep(uMemory * 0.45, uMemory, age);
  float u = (vV + 1.0) * 0.5 * uGrooves;
  float pitch = pitchGuard(u);
  vec3 up = dishNormal(vWorld.xz, uDish);
  vec3 side = vec3(vSide.x, 0.0, vSide.y);
  side = normalize(side - dot(side, up) * up);
  float slope = 0.07 * life * 3.14159265 * sin(6.28318531 * u) * uGrooves / (2.0 * uHalfWidth);
  vec3 n = normalize(up - slope * side);
  float k = (dot(n, uSun) - dot(up, uSun)) / 0.46;
  k = mix(0.22 * uBandSign * life, k, pitch);
  vec3 v = normalize(cameraPosition - vWorld);
  k = mix(0.08 * uBandSign * life, k, smoothstep(0.07, 0.24, abs(dot(v, up))));
  vec3 col = sandTone(k + sandBase(vWorld, up));
  float edge = 1.0 - smoothstep(0.78, 1.0, abs(vV));
  float head = smoothstep(0.0, 0.6, age);
  float a = edge * head * min(life * 3.0, 1.0);
  if (a < 0.002) discard;
  gl_FragColor = vec4(sandFinish(col, vWorld, up), a);
  #include <colorspace_fragment>
}
`;

/** The steel ball: unlit, shaded by the virtual sun with a tight highlight; hidden between a far camera and the stage. */
// language=GLSL
export const BALL_VERTEX = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  vNormalW = lookWorldNormal(normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const BALL_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uSun;
uniform vec3 uSteel;
uniform vec3 uDark;
uniform vec3 uShine;
uniform vec3 uBacking;
uniform float uFadeStart;
uniform float uFadeEnd;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(cameraPosition - vWorld);
  float diffuse = max(dot(n, uSun), 0.0);
  float spec = pow(max(dot(reflect(-uSun, n), v), 0.0), 24.0);
  vec3 col = mix(mix(uDark, uSteel, 0.35 + 0.65 * diffuse), uShine, spec * 0.8);
  col = backingMix(col, uBacking, smoothstep(uFadeStart, uFadeEnd, length(vWorld.xz)));
  if (stageFade(vWorld) < 0.5) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
