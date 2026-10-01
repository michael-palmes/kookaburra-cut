import type { SunSpec } from "../../../../theme/tokens";
import { loopSeconds } from "./clock";
import { glslFloat } from "./glsl";

/** F6 analytic gobos: patterned light pools on floors and walls with no shadow maps. A receiving fragment traces its ray toward a virtual sun to the occluder (a drum, a wall, a roof or canopy plane), evaluates the occluder's own pattern function there with an edge width from `goboPenumbra`, so pools soften with distance, and keeps a clearing round the stage. The sun is a closed-form path on the CPU; a companion `sun` block built from the same path lights devices from the same side. */

type Vec3 = readonly [number, number, number];

/** A virtual sun: a mean direction in the v9 orbit convention (azimuth from +z toward +x, elevation up, engine/orbit.ts `sunPosition`) with an optional azimuth sway. */
export interface GoboSunPath {
  azimuthDeg: number;
  elevationDeg: number;
  /** Azimuth swing either side of the mean. */
  swayDeg?: number;
  /** Seconds per full sway. */
  periodS?: number;
}

/** Penumbra model: a pool edge is `min` world units wide at the occluder and widens by `spread` per unit travelled (about a 0.9 degree sun). */
export const GOBO_PENUMBRA = { spread: 0.016, min: 0.05 } as const;

const DEG = Math.PI / 180;

/** The sun's azimuth at look time `t` (seconds): `mean + sway * sin(2 pi t / period)`, wrapped per period so long projects stay exact. */
export function goboSunAzimuth(path: GoboSunPath, t: number): number {
  const sway = path.swayDeg ?? 0;
  const period = path.periodS ?? 0;
  if (sway === 0 || !(period > 0)) return path.azimuthDeg;
  return path.azimuthDeg + sway * Math.sin((2 * Math.PI * loopSeconds(t, period)) / period);
}

/** Unit vector toward the sun, the normalised v9 `sunPosition`. */
export function goboSunDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
}

/** Writes the sun direction at look time `t` into a uniform's vector without allocating. */
export function writeGoboSun(
  target: { set(x: number, y: number, z: number): unknown },
  path: GoboSunPath,
  t: number,
): void {
  const az = goboSunAzimuth(path, t) * DEG;
  const el = path.elevationDeg * DEG;
  target.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

/** A companion `sun` for a preset's lighting block, aimed along the path's mean so device shading agrees with the pools (companion blocks are static, so the sway is left out). */
export function goboCompanionSun(
  path: GoboSunPath,
  light: { intensity: number; kelvin?: number; angularDeg?: number },
): SunSpec {
  const sun: SunSpec = {
    azimuthDeg: path.azimuthDeg,
    elevationDeg: path.elevationDeg,
    intensity: light.intensity,
  };
  if (light.kelvin !== undefined) sun.kelvin = light.kelvin;
  if (light.angularDeg !== undefined) sun.angularDeg = light.angularDeg;
  return sun;
}

/** Where a receiver's sun ray meets an occluder, and how far it travelled. */
export interface GoboHit {
  point: [number, number, number];
  dist: number;
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (p: Vec3, d: Vec3, s: number): [number, number, number] => [
  p[0] + s * d[0],
  p[1] + s * d[1],
  p[2] + s * d[2],
];

/** Mirrors GLSL `goboPlane`: the sun ray from `p` against the plane through `origin` with `normal`; null when parallel or behind. */
export function traceGoboPlane(p: Vec3, sun: Vec3, origin: Vec3, normal: Vec3): GoboHit | null {
  const d = dot3(sun, normal);
  if (Math.abs(d) <= 1e-5) return null;
  const s =
    ((origin[0] - p[0]) * normal[0] +
      (origin[1] - p[1]) * normal[1] +
      (origin[2] - p[2]) * normal[2]) /
    d;
  return s >= 0 ? { point: along(p, sun, s), dist: s } : null;
}

/** Mirrors GLSL `goboCylinder`: the sun ray from `p` leaving a vertical drum of `radius` round the stage axis (the far root); null when the sun is overhead or the ray misses. */
export function traceGoboCylinder(p: Vec3, sun: Vec3, radius: number): GoboHit | null {
  const a = sun[0] * sun[0] + sun[2] * sun[2];
  const b = p[0] * sun[0] + p[2] * sun[2];
  const c = p[0] * p[0] + p[2] * p[2] - radius * radius;
  const disc = b * b - a * c;
  if (a < 1e-6 || disc < 0) return null;
  const s = (-b + Math.sqrt(disc)) / a;
  return s >= 0 ? { point: along(p, sun, s), dist: s } : null;
}

/** Mirrors GLSL `goboPenumbra`: pool edge width in world units after travelling `dist`. */
export function goboPenumbra(
  dist: number,
  spread: number = GOBO_PENUMBRA.spread,
  min: number = GOBO_PENUMBRA.min,
): number {
  return min + dist * spread;
}

/** FRAGMENT-ONLY (fwidth). Paste into a look fragment as `${LOOK_GLSL_GOBO}`: `goboPlane`/`goboCylinder` trace a receiver's sun ray to an occluder (`GoboHit`: point, dist, hit 0|1); `goboPenumbra(dist)` is the edge width there; `goboEdge(sdf, width[, size])` is the aperture's light (sdf < 0 open), never sharper than a pixel, and with `size` (the aperture half-width) a pinhole narrower than its penumbra dims instead of blooming; `goboReach` fades with distance; `goboClearing` keeps the stage clear; `goboTurns`/`goboTurnsWidth` are drum coordinates (turns round the axis, height) with seam-free widths. */
// language=GLSL
export const LOOK_GLSL_GOBO: string = /* glsl */ `
#ifndef KK_LOOK_GOBO
#define KK_LOOK_GOBO
struct GoboHit {
  vec3 point;
  float dist;
  float hit;
};
GoboHit goboPlane(vec3 p, vec3 sun, vec3 origin, vec3 normal) {
  float d = dot(sun, normal);
  float ok = step(1e-5, abs(d));
  float s = ok > 0.0 ? dot(origin - p, normal) / d : 0.0;
  ok *= step(0.0, s);
  s = max(s, 0.0);
  return GoboHit(p + s * sun, s, ok);
}
GoboHit goboCylinder(vec3 p, vec3 sun, float radius) {
  vec2 d = sun.xz;
  float a = dot(d, d);
  float b = dot(p.xz, d);
  float c = dot(p.xz, p.xz) - radius * radius;
  float disc = b * b - a * c;
  float ok = step(1e-6, a) * step(0.0, disc);
  float s = ok > 0.0 ? (-b + sqrt(max(disc, 0.0))) / a : 0.0;
  ok *= step(0.0, s);
  s = max(s, 0.0);
  return GoboHit(p + s * sun, s, ok);
}
float goboPenumbra(float dist, float spread, float minWidth) {
  return minWidth + dist * spread;
}
float goboPenumbra(float dist) {
  return goboPenumbra(dist, ${glslFloat(GOBO_PENUMBRA.spread)}, ${glslFloat(GOBO_PENUMBRA.min)});
}
float goboReach(float dist, float reach) {
  return exp(-dist / max(reach, 1e-3));
}
float goboClearing(vec3 p, float radius, float feather) {
  return smoothstep(radius, radius + max(feather, 1e-3), length(p.xz));
}
vec2 goboTurns(vec3 q) {
  return vec2(atan(q.z, q.x) / 6.283185307179586 + 0.5, q.y);
}
vec2 goboTurnsWidth(vec3 q) {
  float a = min(fwidth(atan(q.z, q.x)), fwidth(atan(-q.z, -q.x)));
  return vec2(a / 6.283185307179586, fwidth(q.y));
}
float goboEdge(float sdf, float width) {
  float w = max(width, max(fwidth(sdf) * 0.75, 1e-5));
  return 1.0 - smoothstep(-w, w, sdf);
}
float goboEdge(float sdf, float width, float size) {
  float w = max(width, max(fwidth(sdf) * 0.75, 1e-5));
  return (1.0 - smoothstep(-w, w, sdf)) * clamp(size / w, 0.0, 1.0);
}
#endif
`;
