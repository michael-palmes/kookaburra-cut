import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { KITES } from "./kites";

const MAX_LINES = KITES.maxLines;
const LAMP_SIN = KITES.lampFade.map((deg) => Math.sin((deg * Math.PI) / 180));

/** VERTEX. The line maths shared by the ribbons (mirrors `linePoint` in kites.ts) and the lake mirror: reflect a look-space point in the lake with a slow closed-form ripple. */
// language=GLSL
const LINE = /* glsl */ `
uniform vec3 uHead[${MAX_LINES}];
uniform vec3 uAnchor[${MAX_LINES}];
uniform vec4 uWave[${MAX_LINES}];
uniform vec4 uShape[${MAX_LINES}];
uniform float uT;
uniform float uPsi;
uniform float uFigure;
const float BK_TAU = 6.28318530718;
const float BK_PI = 3.14159265359;
const float BK_PERIOD = ${glslFloat(KITES.period)};
const vec3 BK_WIND = vec3(${glslFloat(KITES.wind[0])}, 0.0, ${glslFloat(KITES.wind[2])});
vec3 bkLine(int l, float u) {
  float c = cos(uPsi);
  float s = sin(uPsi);
  float wx = BK_WIND.x * c - BK_WIND.z * s;
  float wz = BK_WIND.x * s + BK_WIND.z * c;
  vec3 a = uAnchor[l];
  vec3 h = uHead[l];
  vec4 wv = uWave[l];
  vec4 shape = uShape[l];
  float span = shape.x;
  float dx = h.x - a.x;
  float dz = h.z - a.z;
  float ph = BK_TAU * wv.x * uT / BK_PERIOD + wv.y;
  float sway = span * 0.55 * sin(ph) * uFigure;
  vec3 head = vec3(
    a.x + dx * c - dz * s - wz * sway,
    h.y + span * 0.22 * sin(2.0 * ph + 0.6) * uFigure,
    a.z + dx * s + dz * c + wx * sway
  );
  float len = distance(head, a);
  float wave = sin(BK_PI * u) * sin(BK_TAU * wv.z * uT / BK_PERIOD - 7.0 * u + wv.w);
  float zig = cos(BK_PI * (1.0 - u) / shape.y) * smoothstep(shape.w - shape.y, shape.w, u);
  float lat = 0.35 * span * wave + shape.z * zig;
  vec3 p = a + (head - a) * u;
  return vec3(p.x - wz * lat, p.y - 0.045 * len * 4.0 * u * (1.0 - u), p.z + wx * lat);
}
`;

// language=GLSL
const MIRROR = /* glsl */ `
vec3 bkMirror(vec3 p) {
  float floorY = ${glslFloat(KITES.floorY)};
  vec3 m = vec3(p.x, 2.0 * floorY - p.y, p.z);
  m.x += 0.12 * sin(0.9 * p.z + BK_TAU * 3.0 * uT / BK_PERIOD) * (p.y - floorY) / 10.0;
  return m;
}
`;

/** Kite cells: instanced, posed on the CPU. `MIRROR` reflects the posed kite in the lake (look space, so camera rigs keep the reflection true). */
// language=GLSL
export const KITE_VERTEX = /* glsl */ `
attribute float aCell;
attribute vec2 aPanel;
attribute float aSwap;
uniform float uT;
const float BK_TAU = 6.28318530718;
const float BK_PERIOD = ${glslFloat(KITES.period)};
${MIRROR}
varying vec3 vN;
varying vec3 vWorld;
varying float vCell;
varying vec2 vPanel;
void main() {
  vec3 local = (instanceMatrix * vec4(position, 1.0)).xyz;
  vec3 n = mat3(instanceMatrix) * normal;
#ifdef BK_MIRROR
  local = bkMirror(local);
  n.y = -n.y;
#endif
  vec4 w = modelMatrix * vec4(local, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  vCell = aCell < 1.5 ? abs(aCell - aSwap) : 2.0;
  vPanel = aPanel;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Calico cells, cedar spars: two-sided lambert from the virtual sun (light presets pale toward the backing in sun, dark ones sink toward it in shade), sewn hems in the Line colour and far haze toward the backing. Solid kites cut their near fade with a hard antialiased edge (alpha to coverage); reflections fade by alpha. */
// language=GLSL
export const KITE_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uSail;
uniform vec3 uCellC;
uniform vec3 uLine;
uniform vec3 uBacking;
uniform vec3 uSun;
uniform float uLight;
uniform float uReflect;
varying vec3 vN;
varying vec3 vWorld;
varying float vCell;
varying vec2 vPanel;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  if (dot(N, V) < 0.0) N = -N;
  vec3 face = vCell < 0.5 ? uSail : (vCell < 1.5 ? uCellC : uLine);
  float lit = dot(N, uSun);
  float lam = clamp(lit * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(face, uBacking, mix(1.0 - lam, lam, uLight) * mix(0.45, 0.32, uLight));
  col = mix(col, mix(face, uBacking, 0.45), clamp(-lit, 0.0, 1.0) * 0.35 * uLight);
  float hem = min(min(vPanel.x, 1.0 - vPanel.x), min(vPanel.y, 1.0 - vPanel.y));
  float hw = fwidth(hem) * 1.5 + 0.045;
  col = mix(col, uLine, (1.0 - smoothstep(0.0, hw, hem)) * 0.4 * step(vCell, 1.5));
  float dist = length(vWorld.xz);
  col = backingMix(col, uBacking, 0.25 * smoothstep(30.0, 60.0, dist));
#ifdef BK_MIRROR
  float a = stageFade(vWorld, 0.72, 0.96) * uReflect * (1.0 - smoothstep(35.0, 80.0, dist));
  if (a < 0.004) discard;
#else
  float a = stageCut(vWorld, 0.72, 0.96);
  if (a < 0.02) discard;
#endif
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Kite lines (F2 ink ribbons): point param (u along the line, line index); `BK_MIRROR` draws the lake reflection. */
// language=GLSL
export const LINE_PATH = /* glsl */ `
${LINE}
${MIRROR}
varying float vH;
varying float vDist;
vec3 inkPath(vec4 p) {
  vec3 q = bkLine(int(p.y + 0.5), p.x);
#ifdef BK_MIRROR
  return bkMirror(q);
#else
  return q;
#endif
}
`;

// language=GLSL
export const LINE_VERTEX_HOOK = /* glsl */ `
void inkVertex(vec4 p, vec3 world) {
  vec3 q = bkLine(int(p.y + 0.5), p.x);
  vH = q.y - ${glslFloat(KITES.floorY)};
  vDist = max(length(q.xz), 1.0);
}
`;

/** Lines fade out before the horizon (by elevation from the stage) and near the camera. */
// language=GLSL
export const LINE_FRAGMENT = /* glsl */ `
uniform vec3 uLine;
uniform float uReflect;
varying float vH;
varying float vDist;
void main() {
  float haze = smoothstep(0.1, 0.22, (vH - 1.5) / vDist);
  float a = 0.9 * inkCoverage() * haze * stageFade(vWorld, 0.72, 0.96);
#ifdef BK_MIRROR
  a *= uReflect;
#endif
  if (a < 0.004) discard;
  gl_FragColor = vec4(uLine, a);
  #include <colorspace_fragment>
}
`;

/** Lamp sprites under each front cell: a core of at least 1.8 reference px (and 1.2 raster px, fading below it), a halo in dark presets, fading in between `KITES.lampFade` degrees above the stage. */
// language=GLSL
export const LAMP_VERTEX = /* glsl */ `
attribute vec3 aLamp;
uniform float uT;
uniform float uDark;
uniform vec2 uInkRaster;
const float BK_TAU = 6.28318530718;
const float BK_PERIOD = ${glslFloat(KITES.period)};
${MIRROR}
varying vec2 vQ;
varying float vCore;
varying float vCover;
varying float vUp;
varying vec3 vWorld;
void main() {
  vUp = smoothstep(${glslFloat(LAMP_SIN[0])}, ${glslFloat(LAMP_SIN[1])}, aLamp.y / max(length(aLamp), 1e-3));
#ifdef BK_MIRROR
  vec3 local = bkMirror(aLamp);
#else
  vec3 local = aLamp;
#endif
  vec4 w = modelMatrix * vec4(local, 1.0);
  vWorld = w.xyz;
  vec3 vc = (viewMatrix * w).xyz;
  float pxPerUnit = exportPxPerUnit(-vc.z);
  float raster = uInkRaster.y > 0.0 ? uInkRaster.y / uResolution.y : 1.0;
  float want = max(0.16 * pxPerUnit, 1.8 * uPx);
  float coreR = max(want, 1.2 / raster);
  float outR = coreR * mix(1.5, 3.0, uDark);
  vCore = coreR / outR;
  vCover = want / coreR;
  vQ = position.xy;
  vc.xy += position.xy * outR / pxPerUnit;
  gl_Position = projectionMatrix * vec4(vc, 1.0);
}
`;

// language=GLSL
export const LAMP_FRAGMENT = /* glsl */ `
uniform vec3 uLamp;
uniform float uDark;
uniform float uReflect;
varying vec2 vQ;
varying float vCore;
varying float vCover;
varying float vUp;
varying vec3 vWorld;
void main() {
  float d = length(vQ);
  float w = fwidth(d);
  float core = 1.0 - smoothstep(vCore - w, vCore + w, d);
  float halo = uDark * (1.0 - smoothstep(vCore, 1.0, d));
  float a = max(core * vCover, halo * halo * 0.4) * vUp * stageFade(vWorld, 0.72, 0.96);
#ifdef BK_MIRROR
  a *= uReflect;
#endif
  if (a < 0.004) discard;
  gl_FragColor = vec4(uLamp, a);
  #include <colorspace_fragment>
}
`;

/** The flooded salt lake: a tone between the palette and the backing that dissolves into the backing outward, so no shoreline reaches the text band. */
// language=GLSL
export const LAKE_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uLake;
uniform vec3 uBacking;
varying vec3 vWorld;
void main() {
  float r = length(vWorld.xz);
  gl_FragColor = vec4(backingMix(uLake, uBacking, smoothstep(6.0, 42.0, r)), 1.0);
  #include <colorspace_fragment>
}
`;
