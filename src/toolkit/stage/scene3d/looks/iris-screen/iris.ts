import { glslFloat } from "../../kit/glsl";
import { LOOK_GLSL_GOBO } from "../../kit/gobo";

/** Floor height and screen height: the drum stands from y -2 to y 12. */
export const IRIS_FLOOR_Y = -2;
export const IRIS_HEIGHT = 14;

/** The virtual sun: low behind the back screen, swaying 15 degrees either way over 80 s. */
export const IRIS_SUN = { azimuthDeg: 180, swayDeg: 15, periodS: 80 } as const;

// language=GLSL
const IRIS_GLSL = /* glsl */ `
${LOOK_GLSL_GOBO}
uniform vec3 uScreen;
uniform vec3 uGlow;
uniform vec3 uPool;
uniform vec3 uBacking;
uniform float uDark;
uniform float uPhase;
uniform vec3 uSun;
uniform float uRadius;
uniform float uCols;
uniform float uPanel;
varying vec3 vWorld;
const float IRIS_TAU = 6.283185307179586;
const float IRIS_FLOOR = ${glslFloat(IRIS_FLOOR_Y)};
const float IRIS_TOP = ${glslFloat(IRIS_FLOOR_Y + IRIS_HEIGHT)};
int irisCol(int x) {
  int n = int(uCols + 0.5);
  return x >= n ? x - n : (x < 0 ? x + n : x);
}
vec2 irisCoords(vec3 q) {
  vec2 u = goboTurns(q);
  return vec2(u.x * uCols, (u.y - IRIS_FLOOR) / uPanel);
}
vec2 irisCoordsWidth(vec3 q) {
  vec2 w = goboTurnsWidth(q);
  return vec2(w.x * uCols, w.y / uPanel);
}
// Rows level with the text open half as far and glow at 30%, so the band behind a headline stays quiet.
float irisRowLive(float y) {
  return smoothstep(2.5, 8.0, y);
}
float irisCellOpen(ivec2 c) {
  float jit = (hash21(c + ivec2(1000, 77)) - 0.5) * 0.9;
  return 0.5 + 0.5 * sin(IRIS_TAU * (uPhase - float(c.x) * 2.0 / uCols - float(c.y) * 0.035) + jit);
}
float irisOcto(vec2 q, float r) {
  vec2 a = abs(q);
  return max(max(a.x, a.y), (a.x + a.y) * 0.7071) - r;
}
float irisRadius(ivec2 c, float live) {
  return mix(0.05, mix(0.12, 0.24, live), irisCellOpen(c));
}
float irisMean(float live) {
  return mix(0.06, 0.12, live);
}
float irisInk(float d, float hw) {
  float w = max(fwidth(d), 1e-5);
  float hwe = max(hw, w * 0.75);
  return (1.0 - smoothstep(hwe - w, hwe + w, abs(d))) * clamp(hw / hwe, 0.0, 1.0);
}
float irisGuard(float px, float scale) {
  return 1.0 - smoothstep(0.35, 0.7, px * scale);
}
// Openness at panel coords g (x round the drum, y up): lens iris, then corner irises and star points weighted by fine.
float irisOpen(vec2 g, float width, float live, float fine) {
  ivec2 c = ivec2(floor(g));
  c.x = irisCol(c.x);
  vec2 q = fract(g) - 0.5;
  float rc = irisRadius(c, live);
  float m = goboEdge(irisOcto(q, rc), width, rc);
  ivec2 cc = ivec2(floor(g + 0.5));
  cc.x = irisCol(cc.x);
  vec2 qc = fract(g + 0.5) - 0.5;
  float rs = mix(0.01, mix(0.025, 0.08, live), irisCellOpen(cc + ivec2(500, 500)));
  m = max(m, goboEdge(irisOcto(qc, rs), width, rs) * fine);
  float s = floor(atan(q.y, q.x + 1e-6) / (IRIS_TAU / 8.0) + 0.5) * (IRIS_TAU / 8.0);
  vec2 p = vec2(cos(s) * q.x + sin(s) * q.y, -sin(s) * q.x + cos(s) * q.y) - vec2(0.43, 0.0);
  float hs = mix(0.008, 0.022, live);
  return max(m, goboEdge(max(abs(p.x), abs(p.y)) - hs, width, hs) * fine);
}
// Diaphragm blades: the octagon's edges extended inside a housing ring, so the iris reads as a lens.
float irisBlades(vec2 g, float live) {
  ivec2 c = ivec2(floor(g));
  c.x = irisCol(c.x);
  vec2 q = fract(g) - 0.5;
  float rc = irisRadius(c, live);
  vec2 a = abs(q);
  float d = min(min(abs(a.x - rc), abs(a.y - rc)), abs((a.x + a.y) * 0.7071 - rc));
  float r = length(q);
  float inside = aaStep(0.0, irisOcto(q, rc)) * (1.0 - smoothstep(0.33, 0.35, r));
  return max(irisInk(d, 0.008) * inside, irisInk(r - 0.345, 0.012));
}
`;

// language=GLSL
export const SCREEN_FRAGMENT: string = /* glsl */ `
${IRIS_GLSL}
void main() {
  vec3 P = vWorld;
  vec2 g = irisCoords(P);
  float px = length(irisCoordsWidth(P));
  float coarse = irisGuard(px, 2.5);
  float guard = irisGuard(px, 10.0);
  float live = irisRowLive(P.y);
  float open = mix(irisMean(live), irisOpen(g, 0.0, live, guard), coarse);
  vec2 sunXz = uSun.xz / max(length(uSun.xz), 1e-4);
  float backlit = mix(0.45, 1.0, smoothstep(-0.2, 0.9, dot(normalize(P.xz), sunXz)));
  float band = mix(0.3, 1.0, smoothstep(2.5, 9.0, P.y));
  vec3 lit = mix(uScreen, uGlow, backlit * band);
  vec2 q = fract(g) - 0.5;
  vec2 a = abs(q);
  float relief = irisInk(abs(max(a.x, a.y) - 0.5), 0.02) * guard;
  float housing = 1.0 - smoothstep(0.33, 0.35, length(q));
  float quiet = mix(0.45, 1.0, live);
  vec3 solid = mix(uScreen, uBacking, 0.35 * (1.0 - uDark));
  solid = mix(solid, mix(solid, uGlow, mix(0.12, 0.07, uDark)), housing * guard * quiet);
  float etch = max(relief * 0.4, irisBlades(g, live) * guard * 0.45);
  solid = mix(solid, mix(uScreen, uGlow, 0.3), etch * quiet * quiet);
  solid = mix(solid, mix(uScreen, uBacking, 0.18), smoothstep(8.0, 12.0, P.y) * 0.5);
  vec3 col = mix(solid, lit, open);
  col = mix(col, mix(uScreen, uGlow, 0.15), irisInk(P.y - IRIS_TOP + 0.08, 0.08));
  if (stageFadeInLine(P, 6.0, 10.0) < 0.5) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const FLOOR_FRAGMENT: string = /* glsl */ `
${IRIS_GLSL}
uniform float uPools;
uniform float uClear;
void main() {
  vec3 P = vWorld;
  float r = length(P.xz);
  GoboHit h = goboCylinder(P, uSun, uRadius);
  float live = irisRowLive(h.point.y);
  float pen = goboPenumbra(h.dist);
  float px = length(irisCoordsWidth(h.point));
  float lens = irisOpen(irisCoords(h.point), pen / uPanel, live, irisGuard(px, 6.0));
  float open = mix(irisMean(live), lens, irisGuard(px, 2.0));
  open = mix(open, 1.0, smoothstep(-pen, pen, h.point.y - IRIS_TOP));
  float light = open * goboReach(h.dist, 14.0) * h.hit;
  float clear = goboClearing(P, uClear, 3.0);
  float edge = 1.0 - smoothstep(uRadius - 1.5, uRadius, r) * 0.5;
  vec3 shade = mix(uBacking, uScreen, mix(0.45, 0.5, uDark));
  vec3 pool = mix(uPool, uGlow, 0.4 * (1.0 - uDark));
  float amount = clamp(light * clear * edge * uPools, 0.0, 1.0);
  vec3 col = mix(shade, pool, amount);
  col = mix(col, mix(shade, uPool, 0.12), (1.0 - clear) * 0.6);
  if (r > uRadius) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
