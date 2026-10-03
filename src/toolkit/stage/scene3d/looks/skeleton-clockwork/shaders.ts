import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { CLOCKWORK, TOOTH } from "./train";

/** One quad per wheel, sized to the tip circle: the plane basis and hub come from instance attributes, the turn from the master tooth count. */
// language=GLSL
export const WHEEL_VERTEX = /* glsl */ `
const float SC_TAU = 6.28318530718;
attribute vec3 aC;
attribute vec3 aU;
attribute vec3 aV;
attribute vec4 aW;
attribute vec2 aS;
uniform float uTeeth;
uniform float uModule;
varying vec2 vP;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vU;
varying vec3 vV;
varying vec4 vW;
varying float vAng;
void main() {
  vec2 p = position.xy * (aW.x + uModule * 1.4);
  vec4 w = modelMatrix * vec4(aC + aU * p.x + aV * p.y, 1.0);
  mat3 m3 = mat3(modelMatrix);
  vU = normalize(m3 * aU);
  vV = normalize(m3 * aV);
  vN = normalize(cross(vU, vV));
  vP = p;
  vW = aW;
  vAng = aS.x + SC_TAU * fract(aS.y * uTeeth);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Teeth, rim, spokes and hub as fwidth-AA distance fields in wheel units (pitch guard: small teeth settle to a flat half-tone band), shaded by a virtual sun with a turned-brass streak that stays put while the wheel turns. Opaque cut-outs (alpha to coverage); haze, grazing and near fades mix tone toward the backing, then cut on a hard antialiased edge. */
// language=GLSL
export const WHEEL_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
const float SC_TAU = 6.28318530718;
uniform float uModule;
uniform vec3 uWheel;
uniform vec3 uArbor;
uniform vec3 uFrieze;
uniform vec3 uSheen;
uniform vec3 uBacking;
uniform vec3 uSun;
varying vec2 vP;
varying vec3 vWorld;
varying vec3 vN;
varying vec3 vU;
varying vec3 vV;
varying vec4 vW;
varying float vAng;
float hardCut(float x, float edge) {
  float w = max(fwidth(x), 1e-4);
  return smoothstep(edge - w, edge + w, x);
}
void main() {
  float R = vW.x;
  float Z = vW.y;
  float S = vW.z;
  bool frieze = vW.w > 0.5 && vW.w < 1.5;
  bool pinion = vW.w > 1.5;
  float m = uModule;
  float r = length(vP);
  float px = max(length(fwidth(vP)), 1e-4) * 0.7;
  float thW = atan(vP.y, vP.x);
  float th = thW - vAng;
  float tip = R + ${glslFloat(TOOTH.addendum)} * m;
  float root = R - ${glslFloat(TOOTH.dedendum)} * m;
  float du = abs(fract(th * Z / SC_TAU) - 0.5);
  float rt = mix(tip, root, clamp((du - ${glslFloat(TOOTH.tip)}) / ${glslFloat(TOOTH.flank)}, 0.0, 1.0));
  float teeth = 1.0 - smoothstep(-px, px, r - rt);
  float solid = 1.0 - smoothstep(-px, px, r - root);
  float band = (1.0 - smoothstep(-px, px, r - tip)) * (1.0 - solid);
  float guard = smoothstep(2.0, 5.0, (SC_TAU * R / Z) / px);
  float cov = mix(max(solid, band), teeth, guard);
  float bandTone = (1.0 - guard) * band * 0.5;
  float hubR = S > 0.5 ? max(0.45, 0.15 * R) : 0.3 * R;
  float hub = 1.0 - smoothstep(-px, px, r - hubR);
  if (S > 0.5) {
    float rimIn = root - max(0.32, 0.075 * R);
    float ring = cov * smoothstep(-px, px, r - rimIn);
    float seg = SC_TAU / S;
    float ts = mod(th + seg * 0.5, seg) - seg * 0.5;
    float sw = max(0.26, 0.06 * R) * (1.0 + 0.6 * smoothstep(rimIn * 0.8, hubR, r));
    float spoke = (1.0 - smoothstep(-px, px, abs(sin(ts)) * r - sw * 0.5))
      * (1.0 - smoothstep(-px, px, r - rimIn - 0.1));
    cov = max(max(ring, spoke), hub);
  }
  cov *= smoothstep(-px, px, r - hubR * 0.35);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vN);
  float facing = abs(dot(N, V));
  float near = stageFade(vWorld, 0.8, 0.97);
  float floorCut = hardCut(vWorld.y, ${glslFloat(CLOCKWORK.floorY)});
  float a = cov * hardCut(facing, 0.06) * hardCut(near, 0.3) * (frieze ? floorCut : 1.0);
  if (a < 0.02) discard;

  vec3 base = pinion ? uArbor : (frieze ? uFrieze : uWheel);
  if (S > 0.5) base = mix(base, uArbor, 0.7 * hub);
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = normalize(uSun);
  float lambert = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  vec3 T = normalize(-sin(thW) * vU + cos(thW) * vV);
  float along = dot(T, normalize(L + V));
  float streak = pow(sqrt(max(0.0, 1.0 - along * along)), 30.0);
  float sheen = clamp(streak * 0.75 + lambert * lambert * 0.2, 0.0, 1.0) * (frieze ? 0.4 : 1.0);
  vec3 col = mix(base, uSheen, sheen);
  float haze = frieze
    ? 0.3 + (1.0 - smoothstep(-2.1, -0.9, vWorld.y)) * 0.7
    : smoothstep(12.0, 40.0, length(vWorld.xz)) * 0.3;
  float fade = max(haze, bandTone);
  fade = max(fade, 1.0 - smoothstep(0.06, 0.32, facing));
  fade = max(fade, 1.0 - smoothstep(0.3, 1.0, near));
  gl_FragColor = vec4(backingMix(col, uBacking, fade), a);
  #include <colorspace_fragment>
}
`;
