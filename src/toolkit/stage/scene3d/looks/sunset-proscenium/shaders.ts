import { LOOK_GLSL_BACKING } from "../../kit";

// language=GLSL
const COMMON = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uBand;
uniform vec3 uAlt;
uniform vec3 uBacking;
uniform float uDark;
varying vec3 vWorld;
`;

// language=GLSL
export const RIB_VERTEX: string = /* glsl */ `
attribute vec3 aRib;
varying vec3 vRib;
varying vec3 vWorld;
void main() {
  vRib = aRib;
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Soffits and risers: alternating bands, stepped risers with a cove lamp in each concave corner, the cove pulse rising outward through the ribs. Fragments whose view ray passes near the stage dissolve between the camera and the stage. */
// language=GLSL
export const RIB_FRAGMENT: string = /* glsl */ `
${COMMON}
uniform vec3 uWarm;
uniform vec3 uRose;
uniform float uPhase;
uniform float uRoseMix;
uniform float uRibs;
uniform float uSteps;
uniform float uGlow;
varying vec3 vRib;
float spStepped(float x) {
  float w = max(fwidth(x), 1e-5);
  return floor(x) + smoothstep(1.0 - w, 1.0, fract(x));
}
void main() {
  float k = floor(vRib.x + 0.5);
  float riser = step(0.5, vRib.y);
  float s = vRib.z;
  vec3 band = mod(k, 2.0) < 0.5 ? uBand : mix(uBand, uAlt, 0.6);
  float ph = fract(uPhase - (k + riser) / (uRibs + 1.0) * 0.6);
  float pulse = exp(-((ph - 0.5) * (ph - 0.5)) / 0.04);
  float rest = mix(0.35, 0.22, uDark);
  float level = (rest + (1.0 - rest) * pulse) * uGlow;
  vec3 cove = mix(uWarm, uRose, uRoseMix);
  float high = smoothstep(1.5, 4.5, vWorld.y);
  float st = clamp(spStepped(s * uSteps) / max(uSteps - 1.0, 1.0), 0.0, 1.0) * step(1.5, uSteps);
  vec3 rise = mix(band, band * mix(0.92, 0.85, uDark), st);
  float wash = exp(-(1.0 - s) / 0.45) * level * high;
  float core = aaBand(s - 0.96, 0.04) * level * high;
  rise = mix(rise, cove, clamp(wash * mix(0.6, 0.78, uDark) + core * 0.9, 0.0, 1.0));
  vec3 soffit = mix(band, uAlt, 0.3) * mix(0.94, 0.85, uDark);
  float back = exp(-s / 0.5) * level * high * step(0.5, k);
  float lip = aaBand(s - 0.985, 0.015);
  soffit = mix(soffit, cove, clamp(back * mix(0.62, 0.8, uDark), 0.0, 1.0));
  soffit = mix(soffit, soffit * 0.8, lip);
  vec3 col = mix(soffit, rise, riser);
  float sf = stageFadeInLine(vWorld, 0.55, 0.95, 6.0, 10.0);
  col = backingMix(col, uBacking, 1.0 - smoothstep(0.5, 0.95, sf));
  if (sf < 0.5) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Stage floor under the nest: a faint band tone inside the arch width, fading to the backing toward the audience and the far nest. */
// language=GLSL
export const FLOOR_FRAGMENT: string = /* glsl */ `
${COMMON}
uniform float uInner;
uniform float uDepth;
void main() {
  float inside = 1.0 - smoothstep(uInner - 1.0, uInner + 3.0, abs(vWorld.x));
  float k = inside * (1.0 - smoothstep(2.0, uDepth + 6.6, abs(vWorld.z)));
  vec3 tone = mix(uBand, uAlt, 0.3);
  gl_FragColor = vec4(backingMix(tone, uBacking, 1.0 - k * 0.16), 1.0);
  #include <colorspace_fragment>
}
`;
