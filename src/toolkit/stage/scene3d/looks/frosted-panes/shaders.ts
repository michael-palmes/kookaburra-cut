import { LOOK_GLSL_BACKING } from "../../kit";
import { FROSTED } from "./panes";

// language=GLSL
export const PANE_VERTEX = /* glsl */ `
attribute vec2 aSize;
attribute float aSeed;
varying vec3 vWorld;
varying vec3 vNormalP;
varying vec2 vLp;
varying vec2 vSize;
varying float vSeed;
void main() {
  vec4 w = lookWorldPosition(position);
  vWorld = w.xyz;
  vNormalP = lookWorldNormal(vec3(0.0, 0.0, 1.0));
  vLp = uv * aSize;
  vSize = aSize;
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// Panes: analytic Gaussian blooms per lamp behind the frost (no transmission pass), a pinpoint hot spot, object-space tooth, etch band and shoji lattice, each pitch guarded; rain only when asked.
// language=GLSL
export const PANE_FRAGMENT = /* glsl */ `
uniform vec3 uGlass;
uniform vec3 uFrame;
uniform vec3 uBloom;
uniform vec3 uLampColor;
uniform vec3 uBacking;
uniform vec3 uLamps[${FROSTED.maxLamps}];
uniform int uLampCount;
uniform float uBloomCap;
uniform float uFrost;
uniform float uRain;
uniform float uLoop;
varying vec3 vWorld;
varying vec3 vNormalP;
varying vec2 vLp;
varying vec2 vSize;
varying float vSeed;
float fpLine(float d, float hw, float px) {
  float w = max(hw, px * 0.75);
  return (1.0 - smoothstep(w - px, w + px, abs(d))) * (hw / w);
}
// Beads sit still, runnels slide down on whole loops of the 60 s cycle; both clear the frost.
float fpRain(vec2 lp, float guard) {
  ivec2 c = ivec2(floor(lp / 0.22)) + ivec2(int(vSeed * 997.0), 31);
  vec2 h = hash22(c);
  vec2 centre = (vec2(floor(lp / 0.22)) + 0.2 + 0.6 * h) * 0.22;
  float r = 0.025 + 0.03 * hash21(c + ivec2(7, 3));
  float bead = step(hash21(c + ivec2(13, 5)), 0.55 * uRain) * (1.0 - aaStep(r, length(lp - centre)));
  float col = floor(lp.x / 0.6);
  float hc = hash21(ivec2(int(col) + int(vSeed * 613.0), 77));
  float x0 = (col + 0.3 + 0.4 * hc) * 0.6 + 0.03 * sin(lp.y * 3.0 + hc * 6.0);
  float head = vSize.y * (1.0 - fract(floor(1.0 + hc * 4.0) * uLoop + hc));
  float dy = lp.y - head;
  float live = step(hc, uRain);
  float drop = (1.0 - aaStep(0.05, length(vec2(lp.x - x0, dy * 0.8))));
  float trail = fpLine(lp.x - x0, 0.015, fwidth(lp.x)) * step(0.0, dy) * (1.0 - smoothstep(0.0, 1.5, dy));
  return max(bead * guard, max(drop, trail * 0.7) * live);
}
void main() {
  vec3 n = normalize(vNormalP);
  float spread = mix(0.7, 1.3, clamp(uFrost, 0.0, 1.0));
  float g = 0.0;
  float hot = 0.0;
  for (int j = 0; j < ${FROSTED.maxLamps}; j++) {
    if (j >= uLampCount) break;
    vec3 toL = uLamps[j] - vWorld;
    float depth = -dot(toL, n);
    if (depth <= 0.0) continue;
    float lat2 = max(dot(toL, toL) - depth * depth, 0.0);
    float sig = (0.25 + 0.3 * depth) * spread;
    g += exp(-lat2 / (2.0 * sig * sig)) * 1.5 / (1.0 + 0.3 * depth);
    hot += exp(-lat2 / (0.0288 * (1.0 + depth))) / (1.0 + depth * depth);
  }
  vec2 lp = vLp;
  vec2 px = fwidth(lp);
  float toothGuard = pitchGuard(lp * 26.0);
  float tooth = toothGuard > 0.0 ? (vnoise(lp * 26.0 + vSeed * 50.0) - 0.5) * toothGuard : 0.0;
  float guard = pitchGuard(lp / 0.09);
  float bandY = vSize.y * (0.58 + 0.2 * vSeed);
  float band = aaBand(lp.y - bandY, 0.22) * pitchGuard(lp.y / 0.44);
  float etch = fpLine(lp.y - bandY - 0.36, 0.035, px.y) + fpLine(lp.y - bandY + 0.36, 0.035, px.y);
  float frost = mix(1.0, 0.72, band);
  vec3 col = uGlass * (1.0 + tooth * 0.12 * uFrost);
  col = mix(col, uBloom, clamp(g * frost, 0.0, uBloomCap));
  col = mix(col, uLampColor, clamp(hot * 0.8 * mix(1.4, 0.6, uFrost), 0.0, 0.6));
  if (uRain > 0.001) {
    float wet = fpRain(lp, pitchGuard(lp / 0.22));
    col = mix(col, mix(uBacking, uBloom, clamp(g * 1.4, 0.0, 1.0)), wet * 0.6);
  }
  float edge = min(min(lp.x, vSize.x - lp.x), min(lp.y, vSize.y - lp.y));
  float frame = 1.0 - aaStep(0.09, edge);
  float railPitch = vSize.y / floor(vSize.y / 1.6 + 0.5);
  float rails = fpLine((fract(lp.y / railPitch + 0.5) - 0.5) * railPitch, 0.045, px.y);
  float stile = fpLine(lp.x - vSize.x * 0.5, 0.045, px.x);
  float lattice = max(frame, max(rails, stile) * guard) + etch * guard * 0.5;
  col = mix(col, uFrame, clamp(lattice, 0.0, 1.0) * mix(0.3, 0.75, guard));
  float a = stageFade(vWorld);
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const CORE_FRAGMENT = /* glsl */ `
uniform vec3 uLampColor;
varying vec3 vWorld;
void main() {
  float a = stageFade(vWorld);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uLampColor, a);
  #include <colorspace_fragment>
}
`;

/** Floor: the backing with a faint Frame-tinted ring where the panes stand, fading back into the backing. */
// language=GLSL
export const FLOOR_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uFrame;
uniform vec3 uBacking;
uniform float uRing;
varying vec3 vWorld;
void main() {
  float r = length(vWorld.xz);
  float ring = smoothstep(uRing - 5.5, uRing - 1.5, r) * (1.0 - smoothstep(uRing + 2.0, uRing + 11.5, r));
  vec3 col = mix(uBacking, uFrame, 0.18 + 0.22 * ring);
  gl_FragColor = vec4(backingMix(col, uBacking, smoothstep(30.0, 90.0, r)), 1.0);
  #include <colorspace_fragment>
}
`;
