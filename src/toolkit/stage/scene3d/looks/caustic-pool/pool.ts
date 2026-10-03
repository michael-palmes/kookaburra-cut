import { loopSeconds } from "../../kit/clock";
import type { Scene3dCompanionLighting } from "../../types";

const TAU = Math.PI * 2;

/** Pool layout in world units: the tiled floor, the rippled surface overhead and the long fade into the backing. */
export const POOL = {
  floorY: -2.2,
  surfaceY: 5.5,
  discRadius: 72,
  fadeStart: 12,
  fadeEnd: 70,
  /** Surface ripples are this much broader than the floor nets. */
  surfaceScale: 16 / 6,
} as const;

/** Whole turns per loop of each turbulence iteration: integers, so the nets close exactly at the loop. */
export const CAUSTIC_TURNS = [-8, -5, -3, 2, 4] as const;

/** Loop phase in radians, 0 to TAU over `loop` seconds of look time (wrapped in double precision). */
export function causticPhase(t: number, loop: number): number {
  return (TAU * loopSeconds(t, loop)) / loop;
}

/** Each turbulence iteration's phase as (cos, sin), written into `out` (one pair per iteration, the shader's `uTurn`). */
export function causticTurns(phase: number, out: { set(x: number, y: number): unknown }[]): void {
  CAUSTIC_TURNS.forEach((k, n) => {
    out[n]?.set(Math.cos(phase * k), Math.sin(phase * k));
  });
}

/** Soft iterated turbulence, 2 PI periodic in `p` and in the phase: the reference form. */
export function causticAt(px: number, py: number, phase: number): number {
  let ix = px;
  let iy = py;
  let c = 1;
  for (const k of CAUSTIC_TURNS) {
    const t = phase * k;
    const nx = px + Math.cos(t - ix) + Math.sin(t + iy);
    const ny = py + Math.sin(t - iy) + Math.cos(t + ix);
    ix = nx;
    iy = ny;
    const sx = Math.sin(ix + t);
    const cy = Math.cos(iy + t);
    c += Math.abs(sx * cy) / (1.25 * Math.sqrt(sx * sx + cy * cy) + 1e-5);
  }
  c /= CAUSTIC_TURNS.length;
  return Math.abs(1.17 - c ** 1.4) ** 8;
}

/** CPU mirror of the GLSL `cpCaustic`: the same field from precomputed turns, trig only on the warped point; `dir` -1 runs it in reverse. */
export function causticAtTurns(px: number, py: number, turns: [number, number][], dir = 1): number {
  let cx = Math.cos(px);
  let cyy = Math.cos(py);
  let sxx = Math.sin(px);
  let sy = Math.sin(py);
  let c = 1;
  for (const [ct, s] of turns) {
    const st = dir * s;
    const ix = px + ct * cx + st * sxx + st * cyy + ct * sy;
    const iy = py + st * cyy - ct * sy + ct * cx - st * sxx;
    cx = Math.cos(ix);
    sxx = Math.sin(ix);
    cyy = Math.cos(iy);
    sy = Math.sin(iy);
    const sx = sxx * ct + cx * st;
    const cy = cyy * ct - sy * st;
    c += Math.abs(sx * cy) / (1.25 * Math.sqrt(sx * sx + cy * cy) + 1e-5);
  }
  c /= turns.length;
  return Math.abs(1.17 - c ** 1.4) ** 8;
}

/** Fastest phase rate of the nets in radians per second of look time. */
export function causticRate(loop: number): number {
  return (TAU * Math.max(...CAUSTIC_TURNS.map(Math.abs))) / loop;
}

/** Matching rig: a soft cool key from high overhead (elevation 70, azimuth 200), as daylight through the surface, over a gentle diffuse fill. */
export function poolLighting(mode: "light" | "dark", kelvin: number): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:softbox", intensity: dark ? 0.3 : 0.65, rotationDeg: 0 },
    sun: {
      azimuthDeg: 200,
      elevationDeg: 70,
      intensity: dark ? 0.55 : 0.9,
      kelvin,
      angularDeg: 3,
    },
    ambient: dark ? 0.16 : 0.4,
  };
}
