import { LOOK_GLSL_HASH, LOOK_GLSL_NOISE } from "../../stage/scene3d/kit/glsl";

/** Smallest drawn mote, pixels: a mote below it keeps its energy in a sprite this size, so it never flickers out between pixels. */
export const DUST_MIN_PX = 1.5;

// Seeded motes that drift with the clock and wrap inside a box, lit only where the spot's cone, cookie and shadow reach them.
// language=GLSL
export const DUST_VERTEX = /* glsl */ `
${LOOK_GLSL_HASH}
${LOOK_GLSL_NOISE}
attribute vec4 aSeed;
uniform vec3 uMin;
uniform vec3 uMax;
uniform vec3 uShift;
uniform vec3 uWander;
uniform float uJitter;
uniform float uJitterScale;
uniform vec2 uRadius;
uniform float uPxPerUnit;
uniform vec3 uApex;
uniform vec3 uAxis;
uniform float uCosOuter;
uniform float uCosInner;
uniform float uDecay;
uniform float uG;
uniform mat4 uLightMatrix;
uniform sampler2D uGobo;
uniform float uGoboOn;
uniform sampler2D uShadowMap;
uniform float uShadowOn;
uniform float uShadowBias;
varying float vLight;

float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566370614359172 * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

float visibility(vec4 c) {
  vec3 s = c.xyz / c.w;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  vec2 m = textureLod(uShadowMap, s.xy, 0.0).rg;
  float z = s.z + uShadowBias;
  if (z <= m.x) return 1.0;
  float variance = max(m.y * m.y, 1e-7);
  float d = z - m.x;
  return clamp((variance / (variance + d * d) - 0.3) / 0.65, 0.0, 1.0);
}

void main() {
  vec3 size = uMax - uMin;
  vec3 p = uMin + mod(aSeed.xyz * size + uShift, size);
  vec3 q = p * uJitterScale + uWander;
  p += uJitter * (vec3(vnoise3(q), vnoise3(q + vec3(19.1, 7.3, 3.7)), vnoise3(q + vec3(5.9, 41.3, 13.1))) - 0.5);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  vec3 l = p - uApex;
  float dist = length(l);
  vec3 ldir = l / max(dist, 1e-5);
  float light = smoothstep(uCosOuter, uCosInner, dot(ldir, uAxis)) / pow(dist * dist, 0.5 * uDecay);
  vec4 c = uLightMatrix * vec4(p, 1.0);
  if (uGoboOn > 0.5) light *= textureLod(uGobo, c.xy / c.w, 0.0).r;
  if (uShadowOn > 0.5) light *= visibility(c);
  vec3 toEye = normalize(cameraPosition - p);
  light *= hgPhase(dot(ldir, toEye), uG) * 12.566370614359172;

  float diameter = 2.0 * mix(uRadius.x, uRadius.y, aSeed.w) * uPxPerUnit / max(-mv.z, 1e-3);
  float drawn = max(diameter, ${DUST_MIN_PX.toFixed(1)});
  gl_PointSize = drawn;
  vLight = light * (diameter * diameter) / (drawn * drawn);
}
`;

// language=GLSL
export const DUST_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vLight;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.35, 1.0, r);
  gl_FragColor = vec4(uColor * (vLight * a * 1.7), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
