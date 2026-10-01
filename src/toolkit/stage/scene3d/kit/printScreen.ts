import { glslFloat } from "./glsl";

/** F4 print screen: world-anchored grain, screens, halftone dots, ordered dither and plate misregistration for look fragments. Every helper takes world or object coordinates (never `gl_FragCoord`) and no time, so the pattern only moves with the camera, which codecs predict cheaply. Every pattern falls to its mean tone as its cell nears pixel size (the kit pitch guard), so a 320px tile and a 4K export read the same. */

/** Fine octave weight of `printScreen` at amount 1 (the riso sketch's grain 0.5). */
export const PRINT_SCREEN_FINE = 1.1;
/** Coarse octave weight of `printScreen` at amount 1. */
export const PRINT_SCREEN_COARSE = 0.45;
/** Coarse octave pitch as a multiple of the fine pitch. */
export const PRINT_COARSE_RATIO = 22 / 6;
/** Slip guard cell as a multiple of the slip length: fringes fold into clean registration below ~1.5 px. */
export const PRINT_SLIP_CELL = 1.55;
/** Default misregistration direction, degrees in the pattern plane. */
export const PRINT_SLIP_ANGLE_DEG = -29;

const R2_A1 = 3242174889;
const R2_A2 = 2447445414;
const HALF_PI_AREA = Math.PI / 4;
const FULL_DOT = 0.75;

/** FRAGMENT-ONLY (fwidth; needs the kit hash, noise and AA chunks, which the kit prepends). Paste `${LOOK_GLSL_PRINT}` above a look's `main()`. */
// language=GLSL
export const LOOK_GLSL_PRINT: string = /* glsl */ `
#ifndef KK_LOOK_PRINT
#define KK_LOOK_PRINT
float printGuard3(vec3 cell) {
  float px = max(length(fwidth(cell)), 1e-5);
  return 1.0 - smoothstep(0.35, 0.7, px);
}
float printGrain(vec2 p, float pitch) {
  vec2 c = p / pitch;
  float g = pitchGuard(c);
  return g > 0.0 ? (vnoise(c) - 0.5) * g : 0.0;
}
float printGrain(vec3 p, float pitch) {
  vec3 c = p / pitch;
  float g = printGuard3(c);
  return g > 0.0 ? (vnoise3(c) - 0.5) * g : 0.0;
}
float printScreen(vec2 p, float pitch, float amount) {
  vec2 c = p / (pitch * ${glslFloat(PRINT_COARSE_RATIO)}) + 3.1;
  float g = pitchGuard(c);
  float coarse = g > 0.0 ? (vnoise(c) - 0.5) * g : 0.0;
  return 0.5 + amount * (printGrain(p, pitch) * ${glslFloat(PRINT_SCREEN_FINE)} + coarse * ${glslFloat(PRINT_SCREEN_COARSE)});
}
float printScreen(vec3 p, float pitch, float amount) {
  vec3 c = p / (pitch * ${glslFloat(PRINT_COARSE_RATIO)}) + 3.1;
  float g = printGuard3(c);
  float coarse = g > 0.0 ? (vnoise3(c) - 0.5) * g : 0.0;
  return 0.5 + amount * (printGrain(p, pitch) * ${glslFloat(PRINT_SCREEN_FINE)} + coarse * ${glslFloat(PRINT_SCREEN_COARSE)});
}
float printInk(float density, float threshold) {
  float v = density - threshold;
  return clamp(v / max(fwidth(v), 1e-4) + 0.5, 0.0, 1.0) * smoothstep(0.0, 0.02, density);
}
vec2 printSlip(vec2 p, vec2 slip) {
  return slip * pitchGuard(p / max(length(slip) * ${glslFloat(PRINT_SLIP_CELL)}, 1e-4));
}
float printBayer(ivec2 c) {
  uint x = uint(c.x) & 7u;
  uint y = uint(c.y) & 7u;
  uint v = x ^ y;
  uint m = ((v & 1u) << 5) | ((y & 1u) << 4) | ((v & 2u) << 2) | ((y & 2u) << 1) | ((v & 4u) >> 1) | ((y & 4u) >> 2);
  return (float(m) + 0.5) / 64.0;
}
float printR2(ivec2 c) {
  uint h = uint(c.x) * ${R2_A1}u + uint(c.y) * ${R2_A2}u + 2147483648u;
  return (float(h >> 8u) + 0.5) / 16777216.0;
}
float printDitherCell(vec2 q, float tone, bool blue) {
  ivec2 c = ivec2(floor(q));
  return step(blue ? printR2(c) : printBayer(c), tone);
}
float printDither(vec2 p, float pitch, float tone, float blue) {
  vec2 q = p / pitch;
  vec2 e = fwidth(q) * 0.25;
  bool b = blue > 0.5;
  float s = printDitherCell(q - e, tone, b) + printDitherCell(q + e, tone, b)
    + printDitherCell(q + vec2(e.x, -e.y), tone, b) + printDitherCell(q + vec2(-e.x, e.y), tone, b);
  return mix(clamp(tone, 0.0, 1.0), 0.25 * s, pitchGuard(q));
}
float printDotRadius(float tone) {
  float t = clamp(tone, 0.0, 1.0);
  return t < ${glslFloat(HALF_PI_AREA)}
    ? sqrt(t / 3.14159265)
    : mix(0.5, ${glslFloat(FULL_DOT)}, (t - ${glslFloat(HALF_PI_AREA)}) / ${glslFloat(1 - HALF_PI_AREA)});
}
float printHalftone(vec2 p, float pitch, float angle, float tone) {
  float cs = cos(angle);
  float sn = sin(angle);
  vec2 q = vec2(cs * p.x + sn * p.y, cs * p.y - sn * p.x) / pitch;
  float d = length(fract(q) - 0.5);
  float r = printDotRadius(tone);
  float w = max(0.5 * length(fwidth(q)), 1e-4);
  float dots = (1.0 - smoothstep(r - w, r + w, d)) * clamp(r / w, 0.0, 1.0);
  return mix(clamp(tone, 0.0, 1.0), dots, pitchGuard(q));
}
#endif
`;

/** Plate A's slip for a misregistration of `amount` world units along `angleDeg`; plate B takes the negation, so the plates sit `amount` apart. Feed it to a `uniform vec2` and pass that through `printSlip`. */
export function printPlateSlip(
  amount: number,
  angleDeg: number = PRINT_SLIP_ANGLE_DEG,
): [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  const half = Math.max(0, amount) / 2;
  return [Math.cos(a) * half, Math.sin(a) * half];
}

/** CPU mirror of GLSL `printBayer`: the 8x8 ordered-dither threshold of an integer cell, in (0, 1). */
export function printBayer(x: number, y: number): number {
  const cx = x & 7;
  const cy = y & 7;
  const v = cx ^ cy;
  const m =
    ((v & 1) << 5) |
    ((cy & 1) << 4) |
    ((v & 2) << 2) |
    ((cy & 2) << 1) |
    ((v & 4) >> 1) |
    ((cy & 4) >> 2);
  return (m + 0.5) / 64;
}

/** CPU mirror of GLSL `printR2`: the R2 low-discrepancy threshold of an integer cell (blue-noise-like, no tile), in (0, 1), exact in 32-bit fixed point. */
export function printR2(x: number, y: number): number {
  const h = (Math.imul(x, R2_A1) + Math.imul(y, R2_A2) + 0x80000000) >>> 0;
  return ((h >>> 8) + 0.5) / 16777216;
}

/** CPU mirror of GLSL `printDotRadius`: halftone dot radius in cell units whose area tracks `tone`, merging into full cover at 1. */
export function printDotRadius(tone: number): number {
  const t = Math.min(1, Math.max(0, tone));
  if (t < HALF_PI_AREA) return Math.sqrt(t / Math.PI);
  return 0.5 + (FULL_DOT - 0.5) * ((t - HALF_PI_AREA) / (1 - HALF_PI_AREA));
}
