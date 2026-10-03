import { glslFloat } from "../../kit";
import { BLOOMS } from "./blooms";

/** F11 window (fractions of the camera-to-stage distance) for every part: a bloom between the camera and the stage vanishes whole. */
export const BLOOM_FADE = { near: 0.72, far: 0.95 } as const;

/** How far toward the camera (in bloom sizes) a core's quad sits: past its own petals (the open rim reaches about 1.4), so the core glows through its silk while devices and nearer blooms still hide it. */
export const CORE_LIFT = 1.5;

const MAX = BLOOMS.max;
const FADE = `${glslFloat(BLOOM_FADE.near)}, ${glslFloat(BLOOM_FADE.far)}`;

// language=GLSL
const BLOOM_UNIFORMS = /* glsl */ `
#define SB_MAX ${MAX}
uniform vec4 uBloom[SB_MAX];
uniform vec3 uAnchor[SB_MAX];
uniform float uSize;
float sbFade(vec3 c) { return stageFade(c, ${FADE}); }
`;

/** Petal strips: aLW is (along 0..1, across -1..1); aPetal is (bloom, azimuth, inner layer, flutter seed). Each strip is a circular arc in its radial plane whose base angle and bend follow the bloom's openness. */
// language=GLSL
export const PETAL_VERTEX = /* glsl */ `
${BLOOM_UNIFORMS}
uniform float uFlutter;
attribute vec2 aLW;
attribute vec4 aPetal;
varying vec3 vWorld;
varying float vAcross;
varying float vOpen;
varying vec3 vCore;
varying float vFade;
void main() {
  int j = int(aPetal.x + 0.5);
  vec4 b = uBloom[j];
  float o = b.w;
  float outer = 1.0 - aPetal.z;
  float sz = uAnchor[j].z * uSize;
  float len = mix(1.1, 1.5, outer) * sz;
  float al = mix(0.06, 1.8, o) * mix(0.8, 1.0, outer);
  al += (0.03 + 0.07 * o) * sin(uFlutter + aPetal.w * 6.28318530718);
  float be = mix(0.04, -1.3, o) * mix(0.85, 1.0, outer);
  be = abs(be) < 1e-3 ? -1e-3 : be;
  float l = aLW.x;
  float th = al + be * l;
  vec2 p = len / be * vec2(cos(al) - cos(th), sin(al) - sin(th));
  float hw = 0.3 * sz * mix(0.8, 1.0, outer) * pow(sin(3.14159265 * (0.08 + 0.84 * l)), 0.7);
  float psi = aPetal.y;
  vec3 er = vec3(cos(psi), 0.0, sin(psi));
  vec3 et = vec3(-sin(psi), 0.0, cos(psi));
  vec2 n2 = vec2(cos(th), sin(th));
  float cup = -0.1 * aLW.y * aLW.y * sz;
  vec3 crown = b.xyz + vec3(0.0, 0.28 * sz, 0.0);
  vec3 local = crown + er * (0.08 + p.x + n2.x * cup) + vec3(0.0, p.y + n2.y * cup, 0.0) + et * (aLW.y * hw);
  vec4 w = modelMatrix * vec4(local, 1.0);
  vWorld = w.xyz;
  vAcross = aLW.y;
  vOpen = o;
  vCore = (modelMatrix * vec4(b.xyz, 1.0)).xyz;
  vFade = sbFade(vCore);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// language=GLSL
export const PETAL_FRAGMENT = /* glsl */ `
uniform vec3 uPetal;
uniform vec3 uFold;
uniform vec3 uCore;
uniform vec3 uLight;
varying vec3 vWorld;
varying float vAcross;
varying float vOpen;
varying vec3 vCore;
varying float vFade;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float facing = abs(dot(n, v));
  float diff = 0.5 + 0.5 * dot(n, normalize(uLight));
  float g = vOpen * exp(-distance(vWorld, vCore) / 0.75);
  float lit = clamp(diff * 0.8 + g * 0.55, 0.0, 1.0);
  vec3 col = mix(uFold, uPetal, lit);
  col = mix(col, uCore, g * 0.3);
  float edge = 1.0 - aaStep(0.97, abs(vAcross));
  float a = mix(0.84, 0.97, 1.0 - facing) * vFade * edge;
  if (a < 0.03) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Core discs and halos: camera-facing quads, aQuad is (bloom, corner x, corner y). */
// language=GLSL
export const CORE_VERTEX = /* glsl */ `
${BLOOM_UNIFORMS}
attribute vec3 aQuad;
varying vec2 vQuad;
varying float vOpen;
varying float vFade;
void main() {
  int j = int(aQuad.x + 0.5);
  vec4 b = uBloom[j];
  float sz = uAnchor[j].z * uSize;
  vec3 c = (modelMatrix * vec4(b.xyz, 1.0)).xyz;
  vQuad = aQuad.yz;
  vOpen = b.w;
  vFade = sbFade(c);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float d = max(length(mv.xyz), 1e-3);
  float k = max(d - ${glslFloat(CORE_LIFT)} * sz, 0.5 * d) / d;
  mv.xyz *= k;
  mv.xy += aQuad.yz * 0.9 * sz * k;
  gl_Position = projectionMatrix * mv;
}
`;

// language=GLSL
export const CORE_FRAGMENT = /* glsl */ `
uniform vec3 uCore;
varying vec2 vQuad;
varying float vOpen;
varying float vFade;
void main() {
  float r = length(vQuad);
  float disc = 1.0 - aaStep(0.15, r);
  float halo = exp(-r * r / 0.12) * 0.55 * vOpen;
  float a = max(disc * (0.25 + 0.75 * vOpen), halo) * vFade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uCore, a);
  #include <colorspace_fragment>
}
`;

/** Ink path for the rig rings (strand data y 1 outer, 2 inner; param x the angle) and the cables (strand data x the bloom, param x 0 at the crown to 1 at the rig). */
// language=GLSL
export const CABLE_PATH = /* glsl */ `
${BLOOM_UNIFORMS}
uniform float uRigRadius;
varying float vCableFade;
vec3 inkPath(vec4 p) {
  if (inkStrand.y > 0.5) {
    float r = inkStrand.y > 1.5 ? uRigRadius * ${glslFloat(BLOOMS.innerRadius)} : uRigRadius;
    return vec3(sin(p.x) * r, ${glslFloat(BLOOMS.rigY)}, cos(p.x) * r);
  }
  int j = int(inkStrand.x + 0.5);
  vec4 b = uBloom[j];
  vec3 crown = b.xyz + vec3(0.0, 0.3 * uAnchor[j].z * uSize, 0.0);
  vec3 top = vec3(uAnchor[j].x, ${glslFloat(BLOOMS.rigY)}, uAnchor[j].y);
  return mix(crown, top, p.x);
}
`;

// language=GLSL
export const CABLE_VERTEX_HOOK = /* glsl */ `
void inkVertex(vec4 p, vec3 world) {
  int j = int(inkStrand.x + 0.5);
  vec3 c = (modelMatrix * vec4(uBloom[j].xyz, 1.0)).xyz;
  vCableFade = inkStrand.y > 0.5 ? -1.0 : sbFade(c);
}
`;

// language=GLSL
export const CABLE_FRAGMENT = /* glsl */ `
uniform vec3 uCable;
uniform float uOpacity;
varying float vCableFade;
void main() {
  float fade = vCableFade < 0.0 ? stageFade(vWorld, ${FADE}) : vCableFade;
  float a = inkCoverage() * uOpacity * fade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCable, a);
  #include <colorspace_fragment>
}
`;

/** Floor pools: a soft core-coloured pool under each open bloom, widening with its height above the floor. */
// language=GLSL
export const POOL_FRAGMENT = /* glsl */ `
${BLOOM_UNIFORMS}
uniform vec3 uCore;
uniform float uPool;
uniform int uCount;
varying vec3 vWorld;
void main() {
  float k = 0.0;
  for (int j = 0; j < SB_MAX; j++) {
    if (j >= uCount) break;
    vec4 b = uBloom[j];
    if (b.w <= 0.0) continue;
    float d = length(vWorld.xz - b.xz);
    float h = b.y - vWorld.y;
    k += b.w * exp(-d * d / (0.09 * h * h));
  }
  float a = min(k, 1.0) * uPool * stageFade(vWorld, ${FADE});
  if (a < 0.002) discard;
  gl_FragColor = vec4(uCore, a);
  #include <colorspace_fragment>
}
`;
