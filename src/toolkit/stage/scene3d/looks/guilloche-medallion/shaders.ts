import { LOOK_GLSL_BACKING } from "../../kit/glsl";
import { LOOK_GLSL_MEDALLION } from "../../kit/medallion";
import { GUILLOCHE_LOOP } from "./dial";

/** Varyings for the dial discs: world position only. */
// language=GLSL
export const GUILLOCHE_VERTEX = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** One polar SDF dial for the floor and the counter-turning ceiling: rose-curve strands over their gradient, the band picked by radius, a pixel floor, mean tone at pixel pitch and a turning lathe sheen. */
// language=GLSL
export const GUILLOCHE_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
${LOOK_GLSL_MEDALLION}
uniform vec3 uA;
uniform vec3 uB;
uniform vec3 uG;
uniform vec3 uBacking;
uniform float uSpin;
uniform float uTurn;
uniform float uWeaveA;
uniform float uWeaveB;
uniform float uSheenAngle;
uniform float uScale;
uniform float uHW;
uniform vec4 uCounts;
uniform float uSheen;
uniform float uUnder;
uniform float uCeiling;
varying vec3 vWorld;
float gmRose(float r, float th, float R, float a, float n, float ph, float a2, float n2, float ph2, float px) {
  float f = R + a * sin(n * th + ph) + a2 * sin(n2 * th - ph2);
  float fp = a * n * cos(n * th + ph) + a2 * n2 * cos(n2 * th - ph2);
  float s = (r - f) / sqrt(1.0 + (fp / r) * (fp / r));
  return medLine(s, uHW, px);
}
void main() {
  vec2 q = vWorld.xz * uScale;
  float r = length(q);
  float thW = atan(q.y, q.x);
  float th = thW - uSpin * uTurn;
  float px = max(length(fwidth(q)) * 0.75, 1e-4);
  float pA = uSpin * uWeaveA;
  float pB = -uSpin * uWeaveB;
  float hwK = uHW / 0.036;
  float cA = 0.0;
  float cB = 0.0;
  float mA = 0.0;
  float mB = 0.0;
  float guard = 1.0;
  if (r > 11.6 && r < 16.2) {
    float n = uCounts.x;
    float spacing = 0.58 * 8.0 / n;
    mA = 0.24 * n / 8.0;
    guard = smoothstep(0.25, 0.6, px / spacing);
    for (int k = 0; k < ${GUILLOCHE_LOOP.lace} && guard < 0.999; k++) {
      if (float(k) >= n) break;
      cA = max(cA, gmRose(r, th, 13.9, 1.9, 14.0, MED_TAU * float(k) / n + pA, 0.0, 1.0, 0.0, px));
    }
  } else if (r > 16.9 && r < 24.0) {
    float n = uCounts.y;
    float spacing = 0.7 * 5.0 / n;
    mA = 0.09 * n / 5.0;
    mB = mA;
    guard = smoothstep(0.25, 0.6, px / spacing);
    for (int k = 0; k < ${GUILLOCHE_LOOP.braid} && guard < 0.999; k++) {
      if (float(k) >= n) break;
      cA = max(cA, gmRose(r, th, 20.45, 3.1, 9.0, MED_TAU * float(k) / n + pA, 0.0, 1.0, 0.0, px));
      cB = max(cB, gmRose(r, th, 20.45, 3.1, 11.0, MED_TAU * (float(k) + 0.5) / n + pB, 0.0, 1.0, 0.0, px));
    }
  } else if (r > 24.7 && r < 31.4) {
    float n = uCounts.z;
    float spacing = 0.66 * 7.0 / n;
    mB = 0.14 * n / 7.0;
    guard = smoothstep(0.25, 0.6, px / spacing);
    for (int k = 0; k < ${GUILLOCHE_LOOP.rosette} && guard < 0.999; k++) {
      if (float(k) >= n) break;
      float ph = MED_TAU * float(k) / n;
      cB = max(cB, gmRose(r, th, 28.05, 1.9, 24.0, ph + pB, 1.0, 8.0, ph + pA, px));
    }
  } else if (r > 33.3 && r < 36.7) {
    float n = uCounts.w;
    float spacing = 0.6 * 2.0 / n;
    mA = 0.08 * n / 2.0;
    mB = mA;
    guard = smoothstep(0.25, 0.6, px / spacing);
    for (int k = 0; k < ${GUILLOCHE_LOOP.border} && guard < 0.999; k++) {
      if (float(k) >= n) break;
      cA = max(cA, gmRose(r, th, 35.0, 1.35, 48.0, MED_TAU * float(k) / n + pA, 0.0, 1.0, 0.0, px));
      cB = max(cB, gmRose(r, th, 35.0, 1.35, 48.0, MED_TAU * (float(k) + 0.5) / n + pB, 0.0, 1.0, 0.0, px));
    }
  }
  mA = min(mA * hwK, 0.8);
  mB = min(mB * hwK, 0.8);
  cA = mix(cA, mA, guard);
  cB = mix(cB, mB, guard);

  float wv = r + 0.075 * r / (1.0 + 0.1 * r) * sin(24.0 * th + r * 0.6 + pA);
  float sW = wv / 0.24;
  float fwW = max(fwidth(sW), 1e-4);
  float hwW = min(0.09 * hwK, 0.3);
  float dhW = max(hwW, fwW * 0.5);
  float cW = clamp((dhW - abs(fract(sW) - 0.5)) / fwW + 0.5, 0.0, 1.0) * (hwW / dhW);
  float inWave = (1.0 - smoothstep(9.6, 10.0, r)) * smoothstep(1.5, 3.5, r);
  cW = mix(cW, 2.0 * hwW, smoothstep(0.25, 0.6, fwW)) * inWave * 0.6;
  cB = max(cB, cW);

  float rings = medLine(r - 10.3, uHW * 1.3, px);
  rings = max(rings, medLine(r - 10.75, uHW * 1.3, px));
  rings = max(rings, medLine(r - 16.4, uHW * 1.3, px));
  rings = max(rings, medLine(r - 24.25, uHW * 1.3, px));
  rings = max(rings, medLine(r - 32.2, uHW * 1.3, px));
  rings = max(rings, medLine(r - 33.0, uHW * 1.3, px));
  rings = max(rings, medLine(r - 37.0, uHW * 1.3, px));
  rings = max(rings, medLine(r - 37.45, uHW * 1.3, px));

  float lobe = 0.0;
  for (int k = 0; k < 3; k++) {
    lobe = max(lobe, medLobe(thW, uSpin * uSheenAngle + MED_TAU * float(k) / 3.0, 0.32));
  }
  float lift = 0.75 + uSheen * (0.8 * lobe - 0.25);
  cA = min(cA * lift, 1.0);
  cB = min(cB * lift, 1.0);

  float ground = (1.0 - smoothstep(37.0, 37.45, r)) * mix(0.55, 1.0, smoothstep(10.75, 11.2, r));
  float under = ground * uUnder * (0.75 + 0.5 * uSheen * lobe);
  vec3 col = mix(uBacking, uG, clamp(under, 0.0, 1.0));
  col = mix(col, uA, cA);
  col = mix(col, uB, max(cB, rings * 0.9));
  float fade = smoothstep(45.0, 90.0, distance(cameraPosition, vWorld)) * 0.7;
  fade = max(fade, uCeiling * medCeilingLeave(vWorld));
  gl_FragColor = vec4(backingMix(col, uBacking, fade), 1.0);
  #include <colorspace_fragment>
}
`;
