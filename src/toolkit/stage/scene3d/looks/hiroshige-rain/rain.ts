import { createSeededRandom } from "../../../../../engine/rng";
import { type InkStrand, inkPolyline, loopSeconds } from "../../kit";

/** Hiroshige rain layout: two cylindrical veils of slanted streaks (a sparse near veil, a paler denser far veil) and puddle rings on the floor. */

export const RAIN_FLOOR_Y = -2;
/** Every streak falls a whole number of spans per period, so the fall loops exactly. */
export const RAIN_FALL_PERIOD = 480;
/** Puddle cycles last 5 to 9 whole seconds, so every slot repeats over their lowest common multiple. */
export const RAIN_PUDDLE_PERIOD = 2520;
export const RAIN_SWAY_PERIOD = 30;
export const RAIN_SWAY_DEG = 2.5;
export const RAIN_HORIZON_RADIUS = 70;

export interface RainVeil {
  /** Streaks at density 1. */
  count: number;
  inner: number;
  outer: number;
  top: number;
  length: readonly [number, number];
  speed: readonly [number, number];
}

export const RAIN_VEILS: readonly [RainVeil, RainVeil] = [
  { count: 520, inner: 11, outer: 16, top: 15, length: [1.4, 2.4], speed: [1.6, 2.2] },
  { count: 1600, inner: 22, outer: 34, top: 21, length: [2, 3.2], speed: [1.2, 1.6] },
];

export const RAIN_DENSITY_MAX = 1.6;
export const RAIN_PUDDLE_SLOTS = 56;
export const RAIN_PUDDLES_MAX = 2;

/** Fall span of a veil: from its top to past the floor by half its longest streak, so the wrap hides below the floor fade. */
export function rainSpan(veil: RainVeil): number {
  return veil.top - RAIN_FLOOR_Y + veil.length[1] / 2 + 0.4;
}

/** Whole spans per fall period for a speed in units per second (at least one). */
export function rainLaps(veil: RainVeil, speed: number): number {
  return Math.max(1, Math.round((speed * RAIN_FALL_PERIOD) / rainSpan(veil)));
}

/** Streaks shown for a density: the veils' sum at density 1, scaled. */
export function rainStrandCount(density: number): number {
  const total = RAIN_VEILS[0].count + RAIN_VEILS[1].count;
  const d = Math.min(RAIN_DENSITY_MAX, Math.max(0, Number.isFinite(density) ? density : 1));
  return Math.round(total * d);
}

/** Streak strands at the maximum density, the two veils interleaved so any prefix keeps their ratio. Points are (angle, radius, phase, end -0.5 or 0.5); data is (veil, length, laps, ink). */
export function rainStrands(): InkStrand[] {
  const veils = RAIN_VEILS.map((veil, v) => {
    const rand = createSeededRandom(0x4a1e + v * 7919);
    const n = Math.round(veil.count * RAIN_DENSITY_MAX);
    const out: InkStrand[] = [];
    for (let i = 0; i < n; i++) {
      const th = rand() * Math.PI * 2;
      const r = veil.inner + (veil.outer - veil.inner) * Math.sqrt(rand());
      const phase = rand();
      const len = veil.length[0] + (veil.length[1] - veil.length[0]) * rand();
      const speed = veil.speed[0] + (veil.speed[1] - veil.speed[0]) * rand();
      const ink = 0.8 + 0.2 * rand();
      out.push(
        inkPolyline(
          [
            [th, r, phase, -0.5],
            [th, r, phase, 0.5],
          ],
          [v, len, rainLaps(veil, speed), ink],
        ),
      );
    }
    return out;
  });
  const [near, far] = veils;
  const total = near.length + far.length;
  const out: InkStrand[] = [];
  let ni = 0;
  let fi = 0;
  for (let k = 0; k < total; k++) {
    const nearDue = Math.floor(((k + 1) * near.length) / total) > ni;
    if ((nearDue && ni < near.length) || fi >= far.length) out.push(near[ni++]);
    else out.push(far[fi++]);
  }
  return out;
}

/** Puddle slot seeds at the maximum count: (slot, cycle seconds 5 to 9, offset seconds, ring size). */
export function rainPuddleSeeds(): Float32Array {
  const rand = createSeededRandom(0x7d1e);
  const n = RAIN_PUDDLE_SLOTS * RAIN_PUDDLES_MAX;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const cycle = 5 + Math.min(4, Math.floor(rand() * 5));
    out.set([i, cycle, rand() * 9, 1.2 + 0.8 * rand()], i * 4);
  }
  return out;
}

/** Slant of each veil in radians at look time `t`: the slider angle plus a 2.5 degree sway over 30 s, the veils out of phase. */
export function rainSlants(
  t: number,
  nearDeg: number,
  farDeg: number,
  out: [number, number] = [0, 0],
): [number, number] {
  const phase = (2 * Math.PI * loopSeconds(t, RAIN_SWAY_PERIOD)) / RAIN_SWAY_PERIOD;
  const sway = (RAIN_SWAY_DEG * Math.PI) / 180;
  out[0] = (nearDeg * Math.PI) / 180 + sway * Math.sin(phase);
  out[1] = (farDeg * Math.PI) / 180 + sway * Math.sin(phase + 1.7);
  return out;
}
