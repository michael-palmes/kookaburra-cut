import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { TERRACE, TERRACE_FLOOR_Y } from "./terrace";

const HOUSES = TERRACE.variants * TERRACE.slots;

// language=GLSL
const COMMON = /* glsl */ `
#define TR_HOUSES ${HOUSES}
#define TR_SLOTS ${TERRACE.slots}
#define TR_UNITS ${TERRACE.maxUnits}
const float TR_TAU = 6.283185307179586;
const float TR_Y0 = ${glslFloat(TERRACE_FLOOR_Y)};
const float TR_W = ${glslFloat(TERRACE.width)};
const float TR_PAGE = ${glslFloat(TERRACE.page)};
const float TR_PHASE = ${glslFloat(TERRACE.phase)};
uniform vec4 uHA[TR_HOUSES];
uniform vec4 uHB[TR_HOUSES];
uniform float uVar[TR_UNITS];
uniform float uRadius;
uniform float uUnits;
uniform float uSX;
uniform float uSA;
uniform float uWave;
uniform float uCrests;
uniform float uOpenTop;
uniform vec3 uSun;
float trTheta(float ui) {
  return (ui + 0.5 + TR_PHASE) * TR_TAU / uUnits;
}
float trUnitAt(float th) {
  return mod(floor(th / TR_TAU * uUnits - TR_PHASE), uUnits);
}
// Mirrors terraceFold: 0 standing, pi/2 flat.
float trFold(float th) {
  float open = smoothstep(-0.95, uOpenTop, cos(uCrests * th - uWave));
  return (1.0 - open) * 1.5707963;
}
`;

/** Pieces: authored upright in card space (x, S, A), folded by s = S - A sin b, z = A cos b about the unit's fold line. */
// language=GLSL
export const PIECE_VERTEX: string = /* glsl */ `
${COMMON}
attribute vec4 aMeta;
attribute vec4 aFace;
varying vec3 vWorld;
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vCard;
varying vec4 vMeta;
varying vec4 vFace;
void main() {
  float ui = aMeta.x;
  if (ui > uUnits - 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float th = trTheta(ui);
  float beta = trFold(th);
  float sb = sin(beta);
  float cb = cos(beta);
  vec3 er = vec3(sin(th), 0.0, -cos(th));
  vec3 et = vec3(cos(th), 0.0, sin(th));
  float A = position.z * uSA;
  float s = position.y - A * sb;
  float lift = aMeta.y < 0.5 ? 0.012 : (aMeta.y < 1.5 ? 0.036 : 0.024);
  vec3 p = et * (position.x * uSX) + er * (uRadius - s) + vec3(0.0, TR_Y0 + A * cb + lift, 0.0);
  vN = aMeta.y > 1.5 ? vec3(0.0, 1.0, 0.0) : normalize(-er * cb + vec3(0.0, sb, 0.0));
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vLocal = p;
  vCard = position;
  vMeta = aMeta;
  vFace = aFace;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
const SHADE = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uLit;
uniform vec3 uShadeC;
uniform vec3 uCrease;
uniform vec3 uSheet;
uniform vec3 uShadowC;
uniform vec3 uTable;
uniform vec3 uBacking;
uniform float uShadowAmt;
float trBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tn3 = min(t0, t1);
  vec3 tf3 = max(t0, t1);
  float tn = max(max(max(tn3.x, tn3.y), tn3.z), 0.0);
  float tf = min(min(tf3.x, tf3.y), tf3.z);
  return smoothstep(0.0, 0.03 + 0.1 * tn, tf - tn);
}
// Signed distance (positive inside) to the back page's house cut-outs, in card (x, A).
float trLeafHole(int v, vec2 q) {
  float d = -1e3;
  for (int h = 0; h < TR_SLOTS; h++) {
    vec4 ha = uHA[v * TR_SLOTS + h];
    vec4 hb = uHB[v * TR_SLOTS + h];
    if (hb.w < 0.5) continue;
    float top = ha.w + (hb.w < 1.5 ? hb.y : 0.0);
    d = max(d, min(min(q.x - ha.x, ha.y - q.x), min(top - q.y, q.y)));
  }
  return d;
}
// Sun shadow at P from unit ui's houses (and its back page unless skipLeaf), traced in unfolded card space.
float trShadow(vec3 P, float ui, float ex, bool skipLeaf) {
  float th = trTheta(ui);
  float beta = trFold(th);
  float sb = sin(beta);
  float cb = cos(beta);
  if (cb < 0.03) return 0.0;
  vec3 er = vec3(sin(th), 0.0, -cos(th));
  vec3 et = vec3(cos(th), 0.0, sin(th));
  float Aw = (P.y - TR_Y0) / cb;
  vec3 ro = vec3(dot(P, et) / uSX, uRadius - dot(P, er) + Aw * sb, Aw / uSA);
  float dA = uSun.y / cb;
  vec3 rd = vec3(dot(uSun, et) / uSX, -dot(uSun, er) + dA * sb, dA / uSA);
  rd = sign(rd) * max(abs(rd), vec3(1e-4)) + vec3(step(abs(rd), vec3(0.0))) * 1e-4;
  float sh = 0.0;
  int v = int(uVar[int(ui)] + 0.5);
  for (int h = 0; h < TR_SLOTS; h++) {
    int k = v * TR_SLOTS + h;
    vec4 ha = uHA[k];
    vec4 hb = uHB[k];
    if (hb.w < 0.5 || abs(float(k) - ex) < 0.5) continue;
    sh = max(sh, trBox(ro, rd, vec3(ha.x, 0.0, 0.0), vec3(ha.y, ha.z, ha.w)));
    if (hb.w < 1.5) sh = max(sh, trBox(ro, rd, vec3(ha.x, 0.0, ha.w), vec3(ha.y, ha.z - hb.x, ha.w + hb.y)));
    if (hb.w > 2.5) {
      float m = (ha.y - ha.x) * 0.22;
      sh = max(sh, trBox(ro, rd, vec3(ha.x + m, ha.z - 0.03, ha.w), vec3(ha.y - m, ha.z, ha.w + hb.z * 0.55)));
    }
  }
  if (!skipLeaf) {
    float lam = -ro.y / rd.y;
    if (lam > 0.0) {
      vec3 q = ro + lam * rd;
      float soft = 0.02 + 0.05 * lam;
      float d = min(TR_W * 0.5 - abs(q.x), min(q.z, TR_PAGE - q.z));
      sh = max(sh, smoothstep(-soft, soft, d) * (1.0 - smoothstep(-soft, soft, trLeafHole(v, q.xz))));
    }
  }
  return sh;
}
float trCrease(float d) {
  return min(1.0, aaLine(d, 0.012) * 1.6);
}
// Facet tone from the sun: deep shade (toward the crease) facing away, shade side-on, lit facing it.
vec3 trFacet(float ndl) {
  float t = smoothstep(-0.35, 0.85, ndl);
  vec3 deep = mix(uShadeC, uCrease, 0.8);
  return t < 0.5 ? mix(deep, uShadeC, t * 2.0) : mix(uShadeC, uLit, t * 2.0 - 1.0);
}
`;

/** Pieces: facet shade from the virtual sun, creases on every fold, cut-outs (page windows, arcades, gables) as MSAA coverage and the unit's own sun shadows. */
// language=GLSL
export const PIECE_FRAGMENT: string = /* glsl */ `
${COMMON}
${SHADE}
varying vec3 vWorld;
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vCard;
varying vec4 vMeta;
varying vec4 vFace;
void main() {
  float role = vMeta.y;
  int slot = int(vMeta.z + 0.5);
  int v = int(vMeta.w + 0.5);
  vec3 c = vCard;
  float keep = 1.0;
  float fold = 0.0;
  if (role < 0.5) {
    keep = 1.0 - aaStep(0.0, trLeafHole(v, c.xz));
    fold = trCrease(c.z);
  } else if (role < 1.5) {
    vec4 ha = uHA[slot];
    vec4 hb = uHB[slot];
    float top = vFace.w;
    float over = c.z - top;
    if (hb.w > 2.5) {
      float xm = 0.5 * (ha.x + ha.y);
      float hw = 0.5 * (ha.y - ha.x);
      float gable = aaStep(0.0, hw * (1.0 - over / hb.z) - abs(c.x - xm));
      keep = over > 0.0 ? gable : 1.0;
    }
    if (hb.w > 1.5 && hb.w < 2.5) {
      float n = max(1.0, floor((ha.y - ha.x) / 0.36));
      float pitch = (ha.y - ha.x) / n;
      float lx = mod(c.x - ha.x, pitch) - 0.5 * pitch;
      float r = pitch * 0.3;
      float spring = ha.w * 0.34;
      float ad = c.z < spring ? r - abs(lx) : r - length(vec2(lx, c.z - spring));
      keep *= 1.0 - aaStep(0.0, min(ad, c.z + 1.0));
    }
    float base = hb.w < 1.5 && c.y < ha.z - 0.01 ? ha.w : 0.0;
    fold = max(trCrease(c.z - base), trCrease(c.z - top));
  } else {
    fold = max(trCrease(vFace.y * vFace.z), trCrease((1.0 - vFace.y) * vFace.z));
  }
  float a = keep * stageCut(vWorld, 0.8, 1.0);
  if (a < 0.01) discard;
  vec3 n = gl_FrontFacing ? vN : -vN;
  float ndl = dot(n, uSun);
  vec3 col = trFacet(ndl);
  if (role > 1.5) col = mix(uShadeC, uSheet, smoothstep(0.0, 0.3, ndl));
  if (!gl_FrontFacing) col = mix(col, uShadeC, 0.5);
  float sh = gl_FrontFacing ? trShadow(vLocal + n * 0.01, vMeta.x, role < 0.5 ? -9.0 : float(slot), role < 0.5) : 0.0;
  col = mix(col, uShadowC, sh * uShadowAmt * smoothstep(-0.05, 0.3, ndl));
  col = mix(col, uCrease, fold * 0.45);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Floor: the card sheet with each unit's cut-outs (the table shows through), the fold creases and sun shadows from the fragment's unit and its neighbour toward the sun. */
// language=GLSL
export const FLOOR_FRAGMENT: string = /* glsl */ `
${COMMON}
${SHADE}
uniform vec2 uFade;
varying vec3 vWorld;
void main() {
  vec3 p = vWorld;
  float r = length(p.xz);
  float ui = trUnitAt(atan(p.x, -p.z));
  float tu = trTheta(ui);
  vec3 er = vec3(sin(tu), 0.0, -cos(tu));
  vec3 et = vec3(cos(tu), 0.0, sin(tu));
  float x = dot(p, et) / uSX;
  float s = uRadius - dot(p, er);
  int v = int(uVar[int(ui)] + 0.5);
  float inUnit = TR_W * 0.5 - abs(x);
  float hole = min(inUnit, min(s + TR_PAGE * uSA, -s));
  float foot = s;
  for (int h = 0; h < TR_SLOTS; h++) {
    vec4 ha = uHA[v * TR_SLOTS + h];
    vec4 hb = uHB[v * TR_SLOTS + h];
    if (hb.w < 0.5) continue;
    float across = min(x - ha.x, ha.y - x);
    hole = max(hole, min(across, min(s, ha.z - s)));
    if (across > 0.0) foot = s - ha.z;
  }
  float stand = cos(trFold(trTheta(ui)));
  float contact = (1.0 - smoothstep(0.0, 0.45, foot)) * step(0.0, foot) * aaStep(0.0, inUnit) * stand;
  float cut = aaStep(0.0, hole);
  float crease = trCrease(s) * aaStep(0.0, inUnit);
  float sh = 0.0;
  if (r > uRadius - 3.5 && r < uRadius + 11.5) {
    float side = dot(uSun, et) > 0.0 ? 1.0 : -1.0;
    sh = max(trShadow(p, ui, -9.0, false), trShadow(p, mod(ui + side, uUnits), -9.0, false));
  }
  float g = pitchGuard(p.xz * 6.0);
  vec3 col = mix(uSheet, uTable, cut);
  col = mix(col, uCrease, 0.35 * crease);
  col = mix(col, uShadowC, contact * 0.45 * (1.0 - cut));
  col = mix(col, mix(uShadowC, uTable, cut), sh * uShadowAmt);
  col *= 1.0 + 0.012 * (vnoise(p.xz * 6.0) - 0.5) * g;
  col = backingMix(col, uBacking, smoothstep(uFade.x, uFade.y, r));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
