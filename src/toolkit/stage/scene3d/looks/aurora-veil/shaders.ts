import { glslFloat } from "../../kit";
import { AURORA } from "./curtains";

/** Near-camera fade window (fractions of the camera-to-stage distance). */
export const AURORA_FADE = { near: 0.6, far: 0.95 } as const;

/** Zenith tint dome: the backing at the horizon deepening to Sky tint overhead, with a faint airglow of the hem colour low down. */
// language=GLSL
export const DOME_FRAGMENT = /* glsl */ `
uniform vec3 uSky;
uniform vec3 uHem;
uniform vec3 uBacking;
uniform float uAmt;
uniform float uGlow;
varying vec3 vSkyDir;
void main() {
  float y = normalize(vSkyDir).y;
  float k = smoothstep(0.02, 0.95, clamp(y, 0.0, 1.0));
  vec3 c = mix(uBacking, uSky, pow(k, 0.8) * uAmt);
  float air = smoothstep(-0.04, 0.05, y) * (1.0 - smoothstep(0.05, 0.3, y));
  gl_FragColor = vec4(mix(c, uHem, air * uGlow), 1.0);
  #include <colorspace_fragment>
}
`;

/** Curtain strips: position = (s along, v up, curtain index), folded onto the far ring in closed form with finite-difference normals. */
// language=GLSL
export const CURTAIN_VERTEX = /* glsl */ `
attribute vec4 aShape;
attribute vec4 aRay;
attribute vec4 aPhase;
uniform float uTime;
uniform float uCount;
uniform float uRadius;
uniform float uHem;
uniform float uFold;
uniform float uRays;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vSV;
varying vec4 vRay;
const float AV_TAU = 6.28318530718;
vec3 avCurtain(float s, float v, float T) {
  vec4 ph = aPhase;
  float th = 3.14159265359 + AV_TAU * position.z / uCount + aShape.x + aShape.y * (s - 0.5);
  float fold = (uFold / 5.5) * (5.5 * sin(AV_TAU * 1.1 * s + ph.x + 2.0 * T)
    + 2.6 * sin(AV_TAU * 2.7 * s + ph.y - 3.0 * T)
    + 0.8 * sin(AV_TAU * 5.3 * s + ph.z + 5.0 * T));
  float r = uRadius + aShape.z + fold + v * 3.0;
  float hem = uHem + aShape.w + 1.6 * sin(AV_TAU * 1.6 * s + ph.w + T)
    + 0.5 * sin(AV_TAU * 4.2 * s - ph.x - 2.0 * T)
    + 0.35 * sin(AV_TAU * 7.0 * s + ph.y - 9.0 * T);
  return vec3(sin(th) * r, hem + v * aRay.x, cos(th) * r);
}
void main() {
  float T = AV_TAU * uTime / ${glslFloat(AURORA.period)};
  float s = position.x;
  float v = position.y;
  vec3 p = avCurtain(s, v, T);
  vec3 ts = avCurtain(s + 0.002, v, T) - avCurtain(s - 0.002, v, T);
  vec3 tv = avCurtain(s, v + 0.01, T) - p;
  vNormalW = normalize(mat3(modelMatrix) * cross(ts, tv));
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vSV = vec2(s, v);
  vRay = vec4(max(floor(aShape.y * (uRadius + aShape.z) / 0.9 * uRays), 4.0), aRay.yzw);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Veil: periodic ray noise swaying on loop harmonics, a body fading up to ragged tops, a crisp brighter hem, brighter where folds turn edge-on, a brightness wave along the curtain. */
// language=GLSL
export const CURTAIN_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform vec3 uHemColor;
uniform vec3 uCrown;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec2 vSV;
varying vec4 vRay;
float avNoise(float x, float period, int seed) {
  float i = floor(x);
  float f = x - i;
  float u = f * f * (3.0 - 2.0 * f);
  int n = int(period);
  int a = (int(i) + n * 64) % n;
  int b = (a + 1) % n;
  return mix(hash21(ivec2(a, seed)), hash21(ivec2(b, seed)), u);
}
void main() {
  float s = vSV.x;
  float v = vSV.y;
  float T = 6.28318530718 * uTime / ${glslFloat(AURORA.period)};
  float N = vRay.x;
  int seed = int(vRay.y + 0.5);
  float pulsePh = vRay.w;
  float x1 = s * N + 2.5 * sin(8.0 * T + pulsePh);
  float n = 0.55 * avNoise(x1, N, seed)
    + 0.30 * avNoise(s * N * 2.0 + 3.0 + 3.0 * sin(11.0 * T - pulsePh), N * 2.0, seed + 1)
    + 0.15 * avNoise(s * N * 4.0 - 5.0 - 4.0 * sin(14.0 * T + 1.3), N * 4.0, seed + 2);
  n = mix(0.5, n, pitchGuard(vec2(x1 * 4.0, v * 8.0)) * 0.6 + 0.4);
  float rays = smoothstep(0.28, 0.78, n);
  float top = mix(0.45, 1.0, avNoise(x1 * 0.5, max(floor(N * 0.5), 1.0), seed + 3));
  float edge = smoothstep(0.0, max(0.014, 1.5 * fwidth(v)), v);
  float body = edge * (1.0 - smoothstep(0.05, top, v));
  float hem = edge * (1.0 - smoothstep(0.015, 0.12, v));
  float ends = smoothstep(0.0, 0.18, s) * (1.0 - smoothstep(0.82, 1.0, s));
  float edgeOn = 1.0 - abs(dot(normalize(vNormalW), normalize(cameraPosition - vWorld)));
  float gain = 0.72 + 0.28 * edgeOn * edgeOn;
  float pulse = (0.8 + 0.2 * sin(vRay.z * T + pulsePh)) * (0.82 + 0.18 * sin(6.28318530718 * 2.0 * s - 16.0 * T));
  float a = clamp(body * mix(0.22, 0.9, rays) + hem * 0.4 * mix(0.7, 1.0, rays), 0.0, 1.0);
  a *= ends * gain * pulse * uAlpha;
  a *= stageFade(vWorld, ${glslFloat(AURORA_FADE.near)}, ${glslFloat(AURORA_FADE.far)});
  gl_FragColor = vec4(mix(uHemColor, uCrown, smoothstep(0.1, 0.5, v)), clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;
