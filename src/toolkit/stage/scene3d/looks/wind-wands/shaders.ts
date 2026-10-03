import { glslFloat, LOOK_GLSL_BACKING } from "../../kit";
import { GROVE } from "./grove";

/** Ground mist depth: cameras looking down see the rods planted in this layer instead of cut by the elevation band. */
export const WAND_MIST = 2.5;
/** Camera pitch (sine of the look-down angle) over which the haze hands from the elevation band to the ground mist. */
export const WAND_RAISE = [Math.sin((9 * Math.PI) / 180), Math.sin((16 * Math.PI) / 180)] as const;

/** The bend both draws share (mirrors grove.ts `wandTip` and `wandPoint`). Shape is (sway cycles per loop, phase, stiffness). */
// language=GLSL
const BEND = /* glsl */ `
const float WW_TAU = 6.28318530718;
uniform float uTime;
uniform float uLean;
uniform float uSway;
uniform float uGustT;
uniform float uHeight;
vec2 wwWind() {
  float psi = ${glslFloat(GROVE.windMean)} + ${glslFloat(GROVE.windVeer)} * sin(WW_TAU * uTime / ${glslFloat(GROVE.loop)});
  return vec2(cos(psi), sin(psi));
}
vec2 wwTip(vec2 base, float h, vec3 shape) {
  vec2 w = wwWind();
  float g = 0.5 + 0.5 * cos(WW_TAU * (dot(base, w) / ${glslFloat(GROVE.gustLength)} - uTime / uGustT));
  g *= g;
  float ph = WW_TAU * shape.x * uTime / ${glslFloat(GROVE.loop)} + shape.y;
  float sway = sin(ph) + 0.22 * sin(3.0 * ph);
  float amp = uSway * h * shape.z * (0.55 + 0.9 * g);
  float lean = h * shape.z * (uLean * (0.35 + g) + 0.25 * uSway * sin(2.0 * ph + 1.1));
  return w * lean + vec2(-w.y, w.x) * amp * sway;
}
vec3 wwPoint(vec2 base, float h, vec2 tip, float s) {
  vec2 d = tip * (s * s * (3.0 - s) * 0.5);
  float drop = 0.6 * dot(tip, tip) / h * s * s * s;
  return vec3(base.x + d.x, ${glslFloat(GROVE.floorY)} + h * s - drop, base.y + d.y);
}
`;

/** Rod ink path: point param (along, sway cycles, phase, stiffness), strand data (foot x, foot z, height, row). */
// language=GLSL
export const ROD_PATH = /* glsl */ `
${BEND}
uniform float uRodWidth;
vec3 inkPath(vec4 p) {
  float h = inkStrand.z * uHeight;
  return wwPoint(inkStrand.xy, h, wwTip(inkStrand.xy, h, p.yzw), p.x);
}
`;

/** Rods taper from foot to tip and widen a little with height. */
// language=GLSL
export const ROD_WIDTH = /* glsl */ `
vec2 inkWidth(vec4 p, vec3 world) {
  return vec2(uRodWidth * mix(1.0, 0.4, p.x) * (0.6 + 0.02 * inkStrand.z * uHeight), 0.0);
}
`;

/** Rods dissolve below the haze band seen from a level camera, or into a ground mist seen from above, and thin with distance. */
// language=GLSL
export const ROD_FRAGMENT = /* glsl */ `
uniform vec3 uWand;
uniform vec2 uHaze;
void main() {
  float dist = length(vWorld.xz);
  float band = smoothstep(uHaze.x, uHaze.y, (vWorld.y + 0.6) / max(dist, 1.0));
  float mist = smoothstep(${glslFloat(GROVE.floorY)}, ${glslFloat(GROVE.floorY + WAND_MIST)}, vWorld.y);
  float pitch = viewMatrix[1][2];
  float raise = smoothstep(${glslFloat(WAND_RAISE[0])}, ${glslFloat(WAND_RAISE[1])}, pitch);
  float haze = mix(0.06, 1.0, mix(band, mist, raise));
  float air = 1.0 - 0.45 * smoothstep(20.0, 50.0, dist);
  float a = inkCoverage() * haze * air * stageFade(vWorld, 0.72, 0.96);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uWand, a);
  #include <colorspace_fragment>
}
`;

/** Lantern beads: camera-facing quads on the bent tips, a minimum pixel radius and, on dark backings, a soft pulsing halo. */
// language=GLSL
export const LANTERN_VERTEX = /* glsl */ `
${BEND}
attribute vec4 aWand;
attribute vec3 aSway;
uniform float uDark;
varying vec2 vQ;
varying float vCore;
varying vec3 vWorld;
varying float vPulse;
void main() {
  float h = aWand.z * uHeight;
  vec3 c = (modelMatrix * vec4(wwPoint(aWand.xy, h, wwTip(aWand.xy, h, aSway), 1.0), 1.0)).xyz;
  vec3 vc = (viewMatrix * vec4(c, 1.0)).xyz;
  vWorld = c;
  vQ = position.xy;
  if (vc.z > -0.1) {
    vCore = 0.0;
    vPulse = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float ppu = exportPxPerUnit(-vc.z);
  float coreR = max(0.2 * ppu, 2.0 * uPx);
  float outR = coreR * mix(1.6, 3.2, uDark);
  vCore = coreR / outR;
  vPulse = 0.8 + 0.2 * sin(WW_TAU * floor(aSway.x * 0.5) * uTime / ${glslFloat(GROVE.loop)} + aSway.y * 3.0);
  vc.xy += position.xy * outR / ppu;
  gl_Position = projectionMatrix * vec4(vc, 1.0);
}
`;

// language=GLSL
export const LANTERN_FRAGMENT = /* glsl */ `
uniform vec3 uLantern;
uniform vec3 uWand;
uniform float uDark;
varying vec2 vQ;
varying float vCore;
varying vec3 vWorld;
varying float vPulse;
void main() {
  float d = length(vQ);
  float w = fwidth(d);
  float core = 1.0 - smoothstep(vCore - w, vCore + w, d);
  float halo = uDark * (1.0 - smoothstep(vCore, 1.0, d));
  halo = halo * halo * 0.4 * vPulse;
  float a = max(core, halo) * stageFade(vWorld, 0.72, 0.96);
  a *= 1.0 - 0.4 * smoothstep(24.0, 50.0, length(vWorld.xz));
  if (a < 0.004) discard;
  vec3 col = mix(uLantern, mix(uLantern, uWand, 0.3), (1.0 - uDark) * (1.0 - vPulse));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

/** Ground: the Ground slot under the stage, settling into the backing by r 40, so no horizon line reaches the text band. */
// language=GLSL
export const GROUND_FRAGMENT = /* glsl */ `
${LOOK_GLSL_BACKING}
uniform vec3 uGround;
uniform vec3 uBacking;
varying vec3 vWorld;
void main() {
  gl_FragColor = vec4(backingMix(uGround, uBacking, smoothstep(8.0, 40.0, length(vWorld.xz))), 1.0);
  #include <colorspace_fragment>
}
`;
