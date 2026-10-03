import { glslFloat, LOOK_GLSL_PRINT } from "../../kit";
import { GROUND_Y, SWAY_LOOP } from "./lace";

/** Shadow lace GLSL: the glowing shell (a sky dome shaded by direction: horizon band, breathing lamp halo, the lamp disc and print grain), the stage floor, the silhouette ribbons (F2 ink with a stepped sway in `inkPath`) and the hummock bands. The shell's outer colour is the backing. Colours are LINEAR uniforms. */

/** The lamp disc's angular radius (radians). */
export const LAMP_RADIUS = 0.026;
/** The floor dissolves into the horizon glow between these radii. */
export const FLOOR_FADE = { start: 14, end: 33.5 } as const;

// language=GLSL
const SHELL = /* glsl */ `
uniform vec3 uIn;
uniform vec3 uBacking;
uniform vec3 uLampDir;
uniform float uPulse;
float slGlow(vec3 d) {
  float band = smoothstep(-0.4, -0.08, d.y) * (1.0 - smoothstep(-0.02, 0.42, d.y));
  float halo = exp(-pow(acos(clamp(dot(d, uLampDir), -1.0, 1.0)) / 0.55, 2.0)) * uPulse;
  return clamp(max(band * 0.85, halo), 0.0, 1.0);
}
vec3 slShell(vec3 d) { return mix(uBacking, uIn, slGlow(d)); }
`;

// language=GLSL
export const DOME_FRAGMENT = /* glsl */ `
${LOOK_GLSL_PRINT}
${SHELL}
uniform vec3 uLamp;
uniform float uGrain;
varying vec3 vSkyDir;
void main() {
  vec3 d = normalize(vSkyDir);
  vec3 col = slShell(d);
  col *= 1.0 + 0.17 * uGrain * printGrain(d, 1.0 / 60.0);
  float dl = length(d - uLampDir);
  float q = dl / ${glslFloat(LAMP_RADIUS)};
  vec3 lamp = mix(uLamp, uIn, smoothstep(0.32, 1.0, q) * 0.35);
  col = mix(col, lamp, 1.0 - aaStep(${glslFloat(LAMP_RADIUS)}, dl));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const FLOOR_FRAGMENT = /* glsl */ `
${SHELL}
uniform vec3 uSil;
varying vec3 vWorld;
void main() {
  vec2 p = vWorld.xz;
  float r = length(p);
  vec3 col = mix(uSil, uBacking, 0.4);
  vec2 ld = normalize(uLampDir.xz);
  float along = dot(p, ld);
  float across = abs(p.x * ld.y - p.y * ld.x);
  float streak = smoothstep(4.0, 30.0, along) * exp(-pow(across / (2.0 + along * 0.18), 2.0)) * uPulse;
  col = mix(col, uIn, streak * 0.35);
  col = mix(col, mix(uBacking, uIn, 0.85), smoothstep(${glslFloat(FLOOR_FADE.start)}, ${glslFloat(FLOOR_FADE.end)}, r));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Ink path: a plant point in its card facing the stage, scaled about the pivot by Plant height and bent about the card's radial axis by the stepped sway (stop motion: `uStepT` is quantised on the CPU). */
// language=GLSL
export const LACE_PATH = /* glsl */ `
uniform float uStepT;
uniform float uSway;
uniform float uHeight;
vec3 slRotate(vec3 v, vec3 ax, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(ax, v) * s + ax * dot(ax, v) * (1.0 - c);
}
vec3 inkPath(vec4 p) {
  float th = inkStrand.x;
  float r = inkStrand.y;
  float freq = floor(inkStrand.w / 8.0);
  float phase = inkStrand.w - 8.0 * freq;
  vec3 tangent = vec3(cos(th), 0.0, sin(th));
  vec3 root = vec3(r * sin(th), ${glslFloat(GROUND_Y)}, -r * cos(th));
  vec3 pivot = vec3(root.x, inkStrand.z, root.z);
  vec3 rest = root + tangent * p.x + vec3(0.0, p.y, 0.0);
  float w = 6.28318530718 * uStepT / ${glslFloat(SWAY_LOOP)};
  float a = uSway * p.w * (sin(freq * w + phase) + 0.35 * sin((2.0 * freq + 3.0) * w + 2.0 * phase));
  vec3 axis = normalize(vec3(root.x, 0.0, root.z));
  return pivot + slRotate((rest - pivot) * uHeight, axis, a);
}
`;

// language=GLSL
export const LACE_WIDTH = /* glsl */ `
vec2 inkWidth(vec4 p, vec3 world) { return vec2(p.z * uHeight, 0.0); }
`;

// language=GLSL
export const LACE_FRAGMENT = /* glsl */ `
uniform vec3 uInk;
void main() {
  float a = inkCoverage() * stageFade(vWorld);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uInk, a);
  #include <colorspace_fragment>
}
`;

// language=GLSL
export const HUMMOCK_FRAGMENT = /* glsl */ `
uniform vec3 uInk;
uniform float uRadius;
uniform float uSeed;
uniform float uHeight;
varying vec3 vWorld;
void main() {
  vec2 q = normalize(vWorld.xz);
  float h = (0.12 + 0.5 * smoothstep(0.35, 0.8, vnoise(q * uRadius * 0.32 + uSeed)) + 0.08 * vnoise(q * uRadius * 3.0 + 3.0)) * uHeight;
  float a = (1.0 - aaStep(${glslFloat(GROUND_Y)} + h, vWorld.y)) * stageFade(vWorld);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uInk, a);
  #include <colorspace_fragment>
}
`;
