import { loopSeconds } from "./clock";
import { glslFloat } from "./glsl";

/** Polar medallions (floor and ceiling dials, inlaid sunbursts): wrapped angles and turning lobes, and lines with an explicit pixel width for normalised distances. Shared by Guilloche medallion and Sunburst terrazzo. */

const TAU = Math.PI * 2;

/** `medLine` never draws narrower than this many pixels each side of its centre: below it the line keeps that width and fades coverage, so the mean tone holds and nothing breaks into dashes. */
export const MEDALLION_MIN_HALF_PX = 0.6;

/** VERTEX-SAFE (pair `medLine` with a `fwidth`-derived pixel size in a fragment). Paste `${LOOK_GLSL_MEDALLION}` above a look's `main()`. `medCeilingLeave` is how far a mirrored ceiling gives way to the backing: near the camera and on a dolly out. */
// language=GLSL
export const LOOK_GLSL_MEDALLION: string = /* glsl */ `
#ifndef KK_LOOK_MEDALLION
#define KK_LOOK_MEDALLION
const float MED_TAU = 6.28318530718;
const float MED_PI = 3.14159265359;
float medAngle(float a) { return mod(a + MED_PI, MED_TAU) - MED_PI; }
float medLobe(float angle, float centre, float width) {
  float d = medAngle(angle - centre);
  return exp(-d * d / (2.0 * width * width));
}
float medLine(float d, float halfWidth, float px) {
  float p = max(px, 1e-5);
  float dh = max(halfWidth, p * ${glslFloat(MEDALLION_MIN_HALF_PX)});
  return clamp((dh - abs(d)) / p + 0.5, 0.0, 1.0) * (halfWidth / dh);
}
float medCeilingLeave(vec3 wp) {
  return max(1.0 - stageFade(wp, 0.5, 0.9), smoothstep(16.0, 28.0, length(cameraPosition)));
}
#endif
`;

/** CPU mirror of GLSL `medLine`: coverage of a line `d` units from its centre at `px` units per pixel. Its integral across the line is `2 * halfWidth` at any pixel size. */
export function medallionLine(d: number, halfWidth: number, px: number): number {
  const p = Math.max(px, 1e-5);
  const dh = Math.max(halfWidth, p * MEDALLION_MIN_HALF_PX);
  return Math.min(1, Math.max(0, (dh - Math.abs(d)) / p + 0.5)) * (halfWidth / dh);
}

/** A dial angle in [0, TAU) that turns once per `period` seconds of look time (`turns` scales the rate), wrapped in double precision so shader floats stay small and loops close exactly. */
export function medallionTurn(t: number, period: number, turns = 1): number {
  return (TAU * loopSeconds(t * turns, period)) / period;
}
