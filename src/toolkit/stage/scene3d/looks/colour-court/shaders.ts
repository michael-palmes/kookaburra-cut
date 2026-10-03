import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { COURT_FLOOR_Y, COURT_MAX_WALLS, COURT_SLOT, COURT_SLOT_WALL } from "./court";

/** Near fade window shared by the walls (fractions of the camera-to-stage distance), applied only where a wall would cover the stage. */
export const COURT_FADE = { near: 0.6, far: 0.95 } as const;

const N = COURT_MAX_WALLS;

// language=GLSL
const COURT_GLSL = /* glsl */ `
uniform vec4 uWallA[${N}];
uniform vec2 uWallT[${N}];
uniform float uWallCount;
uniform vec3 uSun;
uniform vec3 uSlotCol;
uniform vec3 uShade;
uniform vec3 uFloor;
uniform vec3 uBacking;
uniform float uTime;
const float CC_FLOOR = ${glslFloat(COURT_FLOOR_Y)};
const vec4 CC_SLOT = vec4(${glslFloat(COURT_SLOT.u)}, ${glslFloat(COURT_SLOT.halfWidth)}, ${glslFloat(COURT_SLOT.bottom)}, ${glslFloat(COURT_SLOT.top)});
const int CC_SLOT_WALL = ${COURT_SLOT_WALL};
// The sun ray from p against every other wall: (shadow, light through the slot), penumbra growing with distance.
vec2 ccSunTrace(vec3 p, int self) {
  float shadow = 0.0;
  float blade = 0.0;
  for (int j = 0; j < ${N}; j++) {
    if (float(j) >= uWallCount) break;
    if (j == self) continue;
    vec2 T = uWallT[j];
    vec3 n = vec3(-T.y, 0.0, T.x);
    vec3 c = vec3(uWallA[j].x, CC_FLOOR, uWallA[j].y);
    float dn = dot(uSun, n);
    if (abs(dn) < 1e-4) continue;
    float s = dot(c - p, n) / dn;
    if (s < 0.02) continue;
    vec3 q = p + uSun * s;
    float u = dot(q - c, vec3(T.x, 0.0, T.y));
    float h = q.y - CC_FLOOR;
    float pw = 0.04 + 0.035 * s;
    float cov = smoothstep(-pw, pw, uWallA[j].z - abs(u)) * smoothstep(-pw, pw, uWallA[j].w - h) * smoothstep(-pw, pw, h);
    if (j == CC_SLOT_WALL) {
      float inSlot = smoothstep(-pw, pw, CC_SLOT.y - abs(u - CC_SLOT.x)) * smoothstep(-pw, pw, h - CC_SLOT.z) * smoothstep(-pw, pw, CC_SLOT.w - h);
      blade = max(blade, inSlot);
      cov *= 1.0 - inSlot;
    }
    shadow = max(shadow, cov);
  }
  return vec2(shadow, blade * (1.0 - shadow));
}
`;

// language=GLSL
export const WALL_VERTEX = /* glsl */ `
attribute float aWall;
varying vec3 vWorld;
varying vec3 vN;
varying float vWall;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vWall = aWall;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Plaster walls in half-light: lit faces take the sun minus other walls' shadows, stage-side faces of field walls carry soft stacked Rothko fields, and the slot wall glows through its slot. */
// language=GLSL
export const WALL_FRAGMENT = /* glsl */ `
${COURT_GLSL}
uniform vec3 uRosa;
uniform vec3 uOchre;
uniform vec3 uJac;
uniform vec2 uWallC[${N}];
uniform float uFields;
uniform float uBladeAmount;
varying vec3 vWorld;
varying vec3 vN;
varying float vWall;
float ccRect(vec2 p, vec2 h) {
  vec2 d = abs(p) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float ccGlaze(vec2 p) {
  return 0.6 * vnoise(p) + 0.4 * vnoise(p * 2.03 + vec2(17.1, 9.7));
}
vec3 ccPalette(float i) {
  return i < 0.5 ? uRosa : (i < 1.5 ? uOchre : uJac);
}
void main() {
  int self = int(vWall + 0.5);
  vec4 A = uWallA[self];
  vec2 T = uWallT[self];
  vec2 info = uWallC[self];
  vec3 c = vec3(A.x, CC_FLOOR, A.y);
  float u = dot(vWorld - c, vec3(T.x, 0.0, T.y));
  float h = vWorld.y - CC_FLOOR;
  vec3 N = normalize(vN);
  vec3 base = ccPalette(info.x);
  vec3 toStage = normalize(vec3(-c.x, 0.0, -c.z));
  float fieldFace = info.y * step(0.5, dot(N, toStage));
  float gain = uFields / 0.35 * 1.6 * fieldFace;
  if (gain > 0.0) {
    vec2 p = vec2(u, h);
    float W = A.z;
    float H = A.w;
    float glaze = ccGlaze(p * vec2(0.5, 1.4));
    vec3 field = ccPalette(mod(info.x + 1.0, 3.0));
    vec3 deep = mix(base, uShade, 0.6);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float cy = H * (0.2 + 0.3 * fk);
      float hh = H * (0.11 + 0.03 * mod(fk, 2.0));
      float feather = (0.18 + 0.06 * sin(6.28318530718 * uTime / 40.0 + fk * 2.1)) * H * 0.3;
      float m = 1.0 - smoothstep(-feather, feather, ccRect(p - vec2(0.0, cy), vec2(W * 0.78, hh)));
      float tone = 0.28 + 0.07 * sin(6.28318530718 * uTime / 60.0 + fk * 1.7) + (glaze - 0.5) * 0.12;
      base = mix(base, k == 1 ? deep : field, clamp(m * tone * gain, 0.0, 1.0));
    }
  }
  float facing = smoothstep(-0.04, 0.3, dot(N, uSun));
  vec2 tr = ccSunTrace(vWorld, self);
  float lit = facing * (1.0 - tr.x);
  vec3 col = mix(mix(base, uShade, 0.34), base, lit);
  col = mix(col, uSlotCol, uBladeAmount * 0.65 * tr.y * facing);
  col *= 1.0 + (vnoise(vWorld.xy * 2.3 + vWorld.z * 1.7) - 0.5) * 0.03;
  col = mix(col, uFloor, 0.55 * (1.0 - smoothstep(0.0, 1.6, h)));
  if (self == CC_SLOT_WALL) {
    float aw = max(fwidth(u), 1e-4);
    float ah = max(fwidth(h), 1e-4);
    float slot = smoothstep(-aw, aw, CC_SLOT.y - abs(u - CC_SLOT.x)) * smoothstep(-ah, ah, h - CC_SLOT.z) * smoothstep(-ah, ah, CC_SLOT.w - h);
    col = mix(col, uSlotCol, slot);
  }
  float a = stageFadeInLine(vWorld, ${glslFloat(COURT_FADE.near)}, ${glslFloat(COURT_FADE.far)}, 5.0, 18.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** The court floor: the backing warmed toward the walls' mean, wall shadows sweeping it and the slot's blade capped by the Slot blade param. */
// language=GLSL
export const FLOOR_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${COURT_GLSL}
uniform float uBladeAmount;
varying vec3 vWorld;
void main() {
  vec2 tr = ccSunTrace(vWorld, -1);
  vec3 col = mix(uFloor, mix(uFloor, uShade, 0.38), tr.x);
  col = mix(col, uSlotCol, uBladeAmount * tr.y);
  col *= 1.0 + (vnoise(vWorld.xz * 1.9) - 0.5) * 0.025;
  col = backingMix(col, uBacking, smoothstep(34.0, 60.0, length(vWorld.xz)));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
