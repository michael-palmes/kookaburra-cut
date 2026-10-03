import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { THEATRE_FLOOR_Y, THEATRE_MAX_RINGS, THEATRE_RINGS, THEATRE_ROCK_LOOP_S } from "./theatre";

const table = (name: string, values: readonly number[]) =>
  `const float ${name}[${values.length}] = float[${values.length}](${values.map(glslFloat).join(", ")});`;

// language=GLSL
const COMMON = /* glsl */ `
#define PT_RINGS ${THEATRE_MAX_RINGS}
const float PT_TAU = 6.283185307179586;
const float PT_Y0 = ${glslFloat(THEATRE_FLOOR_Y)};
${table(
  "PT_R",
  THEATRE_RINGS.map((r) => r.radius),
)}
${table(
  "PT_N",
  THEATRE_RINGS.map((r) => r.wings),
)}
${table(
  "PT_PHASE",
  THEATRE_RINGS.map((r) => r.phase),
)}
${table(
  "PT_GAP",
  THEATRE_RINGS.map((r) => r.gap),
)}
${table(
  "PT_H",
  THEATRE_RINGS.map((r) => r.height),
)}
uniform float uFlatH;
uniform float uTrees;
uniform float uRingOn[PT_RINGS];
uniform float uPrev[PT_RINGS];
uniform vec3 uLamp;
float ptWingW(int k) {
  return 2.0 * PT_R[k] * sin(0.5 * PT_TAU / PT_N[k] * (1.0 - PT_GAP[k]));
}
float ptNoise(float th, float fr, float sd) {
  return vnoise(vec2(cos(th), sin(th)) * fr + vec2(40.0 + sd * 13.1, 40.0 + sd * 7.7));
}
float ptHill(int k, float th) {
  if (k == 0) {
    float n = 0.6 * ptNoise(th, 2.6, 1.0) + 0.4 * ptNoise(th, 6.5, 2.0);
    return 0.3 + 0.75 * smoothstep(0.25, 0.75, n);
  }
  if (k == 2) {
    float n = 0.6 * ptNoise(th, 3.4, 3.0) + 0.4 * ptNoise(th, 8.0, 4.0);
    return 0.6 + 1.7 * smoothstep(0.25, 0.75, n);
  }
  if (k == 3) {
    float n = 0.62 * ptNoise(th, 4.2, 5.0) + 0.38 * ptNoise(th, 10.0, 6.0);
    return 1.2 + 2.6 * smoothstep(0.2, 0.8, n);
  }
  float n = 0.6 * ptNoise(th, 3.0, 8.0) + 0.4 * ptNoise(th, 7.5, 9.0);
  return 2.0 + 3.0 * smoothstep(0.2, 0.8, n);
}
float ptTheta(int k, float wi, float u) {
  return (wi + PT_PHASE[k] + 0.5 * PT_GAP[k] + u * (1.0 - PT_GAP[k])) * PT_TAU / PT_N[k];
}
// (u across the wing, wing index) at bearing th on ring k.
vec2 ptWingAt(int k, float th) {
  float w = th / PT_TAU * PT_N[k] - PT_PHASE[k];
  float wi = floor(w);
  float f = w - wi;
  return vec2((f - 0.5 * PT_GAP[k]) / (1.0 - PT_GAP[k]), mod(wi, PT_N[k]));
}
float ptCirc(vec2 p, vec2 c, float r) { return r - length(p - c); }
float ptEll(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  return (1.0 - length(q)) * min(r.x, r.y);
}
// Tree row on ring 1: one lollipop or gum per 1.5 unit cell, none behind the default headline.
float ptTree(float wi, float x, float y, float W) {
  float cw = 1.5;
  float xs = x + 0.5 * W;
  float ci = floor(xs / cw);
  float nC = floor(W / cw);
  if (ci < 1.0 || ci > nC - 2.0) return -1.0;
  float tc = mod(ptTheta(1, wi, (ci + 0.5) * cw / W) + 3.1415927, PT_TAU) - 3.1415927;
  if (tc > -0.78 && tc < 0.06) return -1.0;
  ivec2 cell = ivec2(int(wi) * 97 + int(ci) + 1000, 311);
  vec2 h = hash22(cell);
  if (h.x >= uTrees) return -1.0;
  float h3 = hash11(int(wi) * 131 + int(ci) * 7 + 5);
  float lx = xs - (ci + 0.5) * cw + (h.y - 0.5) * 0.35;
  vec2 p = vec2(lx, y);
  float ht = 0.5 + 0.5 * h3;
  float r = 0.27 + 0.12 * h.y;
  if (hash21(cell + ivec2(0, 977)) < 0.41) {
    float d = ptCirc(p, vec2(0.0, ht + r * 0.55), r);
    return max(d, min(0.055 - abs(lx), ht + r * 0.3 - y));
  }
  float lean = (h3 - 0.5) * 0.3;
  float tx = lx - lean * y;
  float trunk = min(0.06 - abs(tx), ht + 0.15 - y);
  float fork = min(0.045 - abs(lx - lean * ht - (y - ht * 0.7) * 0.5), min(y - ht * 0.7, ht + 0.25 - y));
  vec2 c0 = vec2(lean * ht, ht + 0.2);
  float d = ptEll(p, c0 + vec2(-0.28, 0.02), vec2(r * 1.15, r * 0.62));
  d = max(d, ptEll(p, c0 + vec2(0.24, 0.12), vec2(r * 1.05, r * 0.6)));
  d = max(d, ptEll(p, c0 + vec2(-0.02, 0.36), vec2(r * 0.9, r * 0.5)));
  return max(d, max(trunk, fork));
}
// Card coverage distance (positive inside) for wing wi of ring k; y is height above the floor in flat units.
float ptCard(int k, float wi, float u, float y) {
  if (u < 0.0 || u > 1.0) return -1.0;
  float W = ptWingW(k);
  float e = min(u, 1.0 - u) * W;
  float th = ptTheta(k, wi, u);
  if (k == 1) {
    float g = (0.16 + 0.16 * ptNoise(th, 9.0, 7.0)) * mix(0.4, 1.0, smoothstep(0.0, 0.8, e));
    return max(g - y, ptTree(wi, (u - 0.5) * W, y, W));
  }
  return ptHill(k, th) * mix(0.3, 1.0, smoothstep(0.0, 1.6, e)) - y;
}
// Soft drop shadow: ring j's coverage where the ray from q toward the footlight crosses it.
float ptCast(int j, vec3 q) {
  vec2 p = q.xz;
  vec2 d = uLamp.xz - p;
  float A = dot(d, d);
  float B = 2.0 * dot(p, d);
  float C = dot(p, p) - PT_R[j] * PT_R[j];
  float disc = B * B - 4.0 * A * C;
  if (disc < 0.0 || C < 0.0) return 0.0;
  float s = (-B - sqrt(disc)) / (2.0 * A);
  if (s < 0.0 || s > 1.0) return 0.0;
  vec2 hp = p + s * d;
  float yq = q.y + s * (uLamp.y - q.y);
  vec2 wu = ptWingAt(j, atan(hp.x, -hp.y));
  float dd = ptCard(j, wu.y, wu.x, (yq - PT_Y0) / uFlatH);
  float travel = s * length(uLamp - q);
  float soft = 0.02 + 0.022 * travel;
  return smoothstep(-soft, soft, dd) * exp(-travel * 0.05);
}
vec3 ptRotY(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}
`;

// language=GLSL
const ROCK = /* glsl */ `
attribute vec4 aPivot;
attribute vec4 aInfo;
uniform float uRockTime;
uniform float uRock;
vec3 ptRock(vec3 p, vec3 pivot) {
  vec3 axis = normalize(vec3(pivot.x, 0.0, pivot.z) + vec3(1e-5));
  float a = uRock * sin(PT_TAU * aInfo.w * uRockTime / ${glslFloat(THEATRE_ROCK_LOOP_S)} + aPivot.w);
  vec3 v = p - pivot;
  float c = cos(a);
  float s = sin(a);
  return pivot + v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}
`;

/** Flats: unit-height quads stretched to each ring's height, rocking on their sticks about the radial axis. */
// language=GLSL
export const FLAT_VERTEX: string = /* glsl */ `
${COMMON}
${ROCK}
varying vec3 vWorld;
varying vec3 vRest;
varying vec4 vInfo;
void main() {
  int k = int(aInfo.x + 0.5);
  if (uRingOn[k] < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float top = PT_H[k] * uFlatH;
  vec3 rest = vec3(position.x, PT_Y0 - 0.02 + position.y * (top + 0.02), position.z);
  vec4 w = modelMatrix * vec4(ptRock(rest, vec3(aPivot.x, PT_Y0, aPivot.z)), 1.0);
  vWorld = w.xyz;
  vRest = rest;
  vInfo = aInfo;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
const CARD_COLOURS = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uCols[PT_RINGS];
uniform vec3 uEdges[PT_RINGS];
uniform float uHaze[PT_RINGS];
uniform vec3 uBackCol;
uniform vec3 uBacking;
uniform float uShade;
uniform float uShadeAmt;
`;

/** Flats: the analytic silhouette as MSAA coverage, a cut-edge rim on the footlight side and the inner ring's drop shadow. */
// language=GLSL
export const FLAT_FRAGMENT: string = /* glsl */ `
${COMMON}
${CARD_COLOURS}
varying vec3 vWorld;
varying vec3 vRest;
varying vec4 vInfo;
void main() {
  int k = int(vInfo.x + 0.5);
  float wi = vInfo.y;
  float u = vInfo.z;
  float y = (vRest.y - PT_Y0) / uFlatH;
  float d = ptCard(k, wi, u, y);
  float th = atan(vRest.x, -vRest.z);
  vec3 tng = vec3(cos(th), 0.0, sin(th));
  vec2 ld = normalize(vec2(clamp(dot(uLamp - vRest, tng) * 0.35, -1.2, 1.2), 1.0));
  float px = max(length(fwidth(vRest)), 1e-4);
  float rw = max(0.045, 1.6 * px);
  float dOff = ptCard(k, wi, u + ld.x * rw / ptWingW(k), y + ld.y * rw / uFlatH);
  int prev = int(floor(uPrev[k] + 0.5));
  float sh = prev >= 0 ? ptCast(prev, vRest) : 0.0;
  float grainUv = 9.0;
  float grain = mix(0.5, vnoise(vRest.xy * grainUv + vRest.zz * grainUv), pitchGuard(vRest.xy * grainUv));
  float cover = aaStep(0.0, d);
  float rim = cover * (1.0 - aaStep(0.0, dOff));
  float a = cover * stageCut(vWorld, 0.8, 1.0);
  if (a < 0.01) discard;
  vec3 col;
  if (!gl_FrontFacing) {
    col = uBackCol;
  } else {
    col = uCols[k] * (1.0 + 0.05 * (1.0 - smoothstep(0.0, 1.5, y)));
    col *= 0.985 + 0.03 * grain;
    col = mix(col, col * uShade, sh * uShadeAmt);
    col = mix(col, uEdges[k], rim);
  }
  col = backingMix(col, uBacking, uHaze[k]);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Clouds: card clouds on the fly-wire track, rocking from their wires; the track turns about +y. */
// language=GLSL
export const CLOUD_VERTEX: string = /* glsl */ `
${COMMON}
${ROCK}
attribute vec2 aLocal;
uniform float uCloudTurn;
varying vec3 vWorld;
varying vec2 vLocal;
varying vec4 vInfo;
void main() {
  vec3 p = ptRotY(ptRock(position, aPivot.xyz), uCloudTurn);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vLocal = aLocal;
  vInfo = aInfo;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const CLOUD_FRAGMENT: string = /* glsl */ `
${COMMON}
uniform vec3 uCloud;
uniform vec3 uCloudEdge;
varying vec3 vWorld;
varying vec2 vLocal;
varying vec4 vInfo;
float ptCloud(vec2 p, float seed) {
  float d = -10.0;
  for (int i = 0; i < 5; i++) {
    vec2 h = hash22(ivec2(int(seed) * 17 + i, 91));
    float fi = float(i);
    float r = 0.34 + 0.34 * h.y * (1.0 - abs(fi - 2.0) / 3.0);
    d = max(d, ptCirc(p, vec2(-1.0 + 0.5 * fi + (h.x - 0.5) * 0.25, r * 0.7), r));
  }
  return min(d, p.y - 0.03);
}
void main() {
  float seed = vInfo.y;
  vec2 lp = vec2((vLocal.x - 0.5) * 3.4, vLocal.y);
  float d = ptCloud(lp, seed);
  float px = max(length(fwidth(lp)), 1e-4);
  float rw = max(0.05, 1.6 * px);
  float dOff = ptCloud(lp + normalize(vec2(0.35, 1.0)) * rw, seed);
  float cover = aaStep(0.0, d);
  float rim = cover * (1.0 - aaStep(0.0, dOff));
  float a = cover * stageCut(vWorld, 0.8, 1.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(uCloud, uCloudEdge, rim), a);
  #include <colorspace_fragment>
}
`;

/** The paper sun (rayed disc) or moon (crescent with a rim), built on the -z axis and turned to the sun's bearing. */
// language=GLSL
export const SUN_VERTEX: string = /* glsl */ `
${COMMON}
uniform float uSunTurn;
varying vec3 vWorld;
varying vec2 vDisc;
void main() {
  vDisc = uv * 2.0 - 1.0;
  vec4 w = modelMatrix * vec4(ptRotY(position, uSunTurn), 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const SUN_FRAGMENT: string = /* glsl */ `
${COMMON}
uniform vec3 uSun;
uniform vec3 uSunEdge;
uniform vec3 uSunDim;
uniform float uMoon;
varying vec3 vWorld;
varying vec2 vDisc;
void main() {
  float r = length(vDisc);
  float ang = atan(vDisc.y, vDisc.x);
  float rays = 0.78 + 0.16 * abs(fract(ang / PT_TAU * 16.0) * 2.0 - 1.0);
  float outline = mix(rays, 0.9, uMoon);
  float cover = 1.0 - aaStep(outline, r);
  float a = cover * stageCut(vWorld, 0.8, 1.0);
  if (a < 0.01) discard;
  vec3 col = mix(uSunEdge, uSun, 1.0 - aaStep(0.66, r) * (1.0 - uMoon));
  float crescent = uMoon * (1.0 - aaStep(0.78, length(vDisc - vec2(0.34, 0.12))));
  col = mix(col, uSunDim, crescent * 0.55);
  col = mix(col, uSunEdge, uMoon * aaBand(r - 0.86, 0.035));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Board floor: planks and joints clear of the stage, every shown ring's footlight shadow, fading to the backing far out. */
// language=GLSL
export const FLOOR_FRAGMENT: string = /* glsl */ `
${COMMON}
${LOOK_GLSL_BACKING}
uniform vec3 uFloor;
uniform vec3 uSeam;
uniform vec3 uBacking;
uniform float uShade;
uniform float uShadeAmt;
varying vec3 vWorld;
void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  float pv = p.y / 0.9;
  float plank = floor(pv);
  float g = pitchGuard(pv);
  float tone = hash11(int(plank) + 500) - 0.5;
  vec3 col = uFloor * (1.0 + 0.05 * tone * g);
  float seam = aaLine(fract(pv + 0.5) - 0.5, 0.012) * g;
  float joint = aaLine(fract(p.x / 5.3 + hash11(int(plank) + 77)) - 0.5, 0.01) * g * 0.7;
  col = mix(col, uSeam, max(seam, joint) * 0.5 * smoothstep(5.0, 8.0, r));
  float sh = 0.0;
  if (r < 50.0) {
    for (int j = 0; j < PT_RINGS; j++) {
      if (uRingOn[j] > 0.5 && PT_R[j] < r - 0.02) sh = max(sh, ptCast(j, vec3(p.x, PT_Y0, p.y)));
    }
  }
  col = mix(col, col * uShade, sh * uShadeAmt * 0.55);
  col = backingMix(col, uBacking, smoothstep(30.0, 70.0, r));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Fly wires and the brass sun wire as ink ribbons: cloud wires turn with the track, the sun wire with the sun. */
export const WIRE_PATH: string = /* glsl */ `
uniform float uCloudTurn;
uniform float uSunTurn;
vec3 inkPath(vec4 p) {
  float a = inkStrand.x > 0.5 ? uSunTurn : uCloudTurn;
  float c = cos(a);
  float s = sin(a);
  return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}
`;

// language=GLSL
export const WIRE_FRAGMENT: string = /* glsl */ `
${COMMON}
uniform vec3 uWire;
uniform vec3 uBrass;
uniform float uWireAlpha;
void main() {
  float sun = step(0.5, vInkStrand.x);
  vec3 col = mix(uWire, uBrass, sun);
  float a = inkCoverage() * mix(uWireAlpha, 1.0, sun) * stageFade(vWorld, 0.8, 1.0);
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;
