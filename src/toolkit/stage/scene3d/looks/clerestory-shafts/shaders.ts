import { glslFloat, LOOK_GLSL_BACKING, LOOK_GLSL_GOBO } from "../../kit";
import { CLERESTORY, DUST_NOISE, WISP_NOISE } from "./shafts";

/** Mean of the thresholded dust noise: what a guarded (sub-pixel) mote field settles to. */
export const DUST_MEAN = 0.083;

// Box-local coords: x radial (-0.5..0.5 across the width), y up the shaft (0.5 at the slot), z tangent (along the length).
// language=GLSL
export const SHAFT_VERTEX = /* glsl */ `
attribute vec2 aWave;
uniform vec3 uFall;
uniform float uBreathPhase;
varying vec3 vLocal;
varying vec3 vCamLocal;
varying vec3 vWorld;
varying float vBreath;
varying float vPxAngle;
void main() {
  vec3 slot = instanceMatrix[3].xyz;
  vec3 across = instanceMatrix[0].xyz;
  vec3 along = instanceMatrix[2].xyz;
  float drop = instanceMatrix[1].y;
  vec3 look = slot + across * position.x + along * position.z + (0.5 - position.y) * drop * uFall;
  vec4 w = modelMatrix * vec4(look, 1.0);
  vec3 cam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  float y = 0.5 - (slot.y - cam.y) / drop;
  vec3 res = cam - slot - (0.5 - y) * drop * uFall;
  vCamLocal = vec3(dot(res, across) / dot(across, across), y, dot(res, along) / dot(along, along));
  vLocal = position;
  vWorld = w.xyz;
  vBreath = 0.8 + 0.2 * sin(6.283185307179586 * aWave.x * uBreathPhase + aWave.y);
  vPxAngle = 1.0 / exportPxPerUnit(1.0);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const SHAFT_FRAGMENT = /* glsl */ `
uniform vec3 uBeam;
uniform vec3 uAir;
uniform float uMaxAlpha;
uniform float uDensity;
uniform float uDust;
uniform vec3 uFallA;
uniform vec3 uFallB;
uniform vec3 uFallC;
uniform float uDustShift;
uniform float uWispShift;
varying vec3 vLocal;
varying vec3 vCamLocal;
varying vec3 vWorld;
varying float vBreath;
varying float vPxAngle;
int csWrap(int c, int n) {
  return int(uint(c + n * 4096) % uint(n));
}
// Value noise that repeats every n cells along z, the fall axis.
float csNoise(vec3 p, int n) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  ivec3 k = ivec3(i);
  int z0 = csWrap(k.z, n);
  int z1 = csWrap(k.z + 1, n);
  float a = mix(hash31(ivec3(k.x, k.y, z0)), hash31(ivec3(k.x + 1, k.y, z0)), u.x);
  float b = mix(hash31(ivec3(k.x, k.y + 1, z0)), hash31(ivec3(k.x + 1, k.y + 1, z0)), u.x);
  float c = mix(hash31(ivec3(k.x, k.y, z1)), hash31(ivec3(k.x + 1, k.y, z1)), u.x);
  float d = mix(hash31(ivec3(k.x, k.y + 1, z1)), hash31(ivec3(k.x + 1, k.y + 1, z1)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}
void main() {
  if (stageFade(vWorld) < 0.001) discard;
  vec3 ro = vCamLocal;
  vec3 rd = vLocal - ro;
  vec3 inv = 1.0 / (rd + vec3(1e-6));
  vec3 tn = min((vec3(-0.5) - ro) * inv, (vec3(0.5) - ro) * inv);
  float tEnter = clamp(max(max(tn.x, tn.y), tn.z), 0.0, 1.0);
  vec3 seg = vWorld - cameraPosition;
  float reach = length(seg);
  float acc = 0.0;
  float wisp = 0.5;
  for (int i = 0; i < 8; i++) {
    float tt = mix(tEnter, 1.0, (float(i) + 0.5) / 8.0);
    vec3 q = ro + rd * tt;
    vec3 wq = cameraPosition + seg * tt;
    float across = 1.0 - smoothstep(0.12, 0.5, abs(q.x));
    float along = 1.0 - smoothstep(0.32, 0.5, abs(q.z));
    float vert = smoothstep(-0.5, -0.46, q.y) * (1.0 - smoothstep(0.42, 0.5, q.y)) * mix(0.7, 1.0, q.y + 0.5);
    float w = across * along * vert * stageFade(wq);
    if (w < 0.002) continue;
    vec3 f = vec3(dot(wq, uFallA), dot(wq, uFallB), dot(wq, uFallC));
    if ((i & 1) == 0) wisp = csNoise(f * ${glslFloat(WISP_NOISE.cells)} - vec3(0.0, 0.0, uWispShift), ${WISP_NOISE.period});
    float guard = 1.0 - smoothstep(0.35, 0.7, vPxAngle * reach * tt * ${glslFloat(DUST_NOISE.cells)});
    float dust = ${glslFloat(DUST_MEAN)};
    if (guard > 0.0 && uDust > 0.0) {
      vec3 dp = f * ${glslFloat(DUST_NOISE.cells)} - vec3(0.0, 0.0, uDustShift);
      dust = mix(dust, smoothstep(0.68, 0.86, csNoise(dp, ${DUST_NOISE.period})), guard);
    }
    acc += w * (0.45 + 0.8 * wisp + uDust * dust);
  }
  acc *= (1.0 - tEnter) * reach / 8.0 * uDensity;
  float a = uMaxAlpha * vBreath * (1.0 - exp(-acc * 1.1));
  if (a < 0.002) discard;
  gl_FragColor = vec4(mix(uAir, uBeam, clamp(acc * 0.9, 0.0, 1.0)), a);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const SLOT_FRAGMENT = /* glsl */ `
uniform vec3 uSlot;
varying vec3 vWorld;
void main() {
  float a = stageFade(vWorld);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uSlot, a);
  #include <colorspace_fragment>
}
`;

/** Floor: the slot rectangles traced up the light (F6) land as breathing pools; the floor fades straight into the backing, so no horizon band. */
// language=GLSL
export const FLOOR_FRAGMENT = /* glsl */ `
${LOOK_GLSL_GOBO}
${LOOK_GLSL_BACKING}
uniform vec3 uBeam;
uniform vec3 uFloor;
uniform vec3 uBacking;
uniform vec3 uSun;
uniform vec4 uSlots[${CLERESTORY.maxShafts}];
uniform vec4 uSlotAxes[${CLERESTORY.maxShafts}];
uniform int uCount;
uniform float uSoft;
varying vec3 vWorld;
void main() {
  vec3 P = vWorld;
  float r = length(P.xz);
  float grain = (vnoise(P.xz * 3.0) - 0.5) * pitchGuard(P.xz * 3.0);
  float near = clamp((12.0 / max(r, 1e-3) - 0.15) / 0.85, 0.0, 1.0);
  vec3 col = backingMix(uFloor * (1.0 + grain * 0.04), uBacking, 1.0 - smoothstep(0.0, 1.0, near));
  float pool = 0.0;
  float halo = 0.0;
  for (int i = 0; i < ${CLERESTORY.maxShafts}; i++) {
    if (i >= uCount) break;
    vec4 s = uSlots[i];
    vec4 ax = uSlotAxes[i];
    GoboHit h = goboPlane(P, uSun, s.xyz, vec3(0.0, 1.0, 0.0));
    vec2 d = h.point.xz - s.xz;
    float e = max(abs(dot(d, ax.xy)) - ax.z, abs(dot(d, vec2(-ax.y, ax.x))) - ax.w);
    pool += goboEdge(e, max(uSoft, goboPenumbra(h.dist))) * h.hit * s.w;
    halo += exp(-max(e, 0.0) * 0.5) * h.hit * s.w;
  }
  col = mix(col, uBeam, clamp(pool * 0.34 + halo * 0.08, 0.0, 0.5));
  col = backingMix(col, uBacking, smoothstep(60.0, 110.0, r));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
