import { loopSeconds } from "../../kit/clock";
import type { LatticePoint } from "../../kit/instanced";

const TAU = Math.PI * 2;

/** Board layout in world units and the field's fixed shape. Discs fill `discShare` of a cell's width, so a cell's mean coverage holds at any pitch. */
export const FLIP = {
  boardY: -2.3,
  /** The mirrored ceiling board, so the default front view frames the headline. */
  ceilingY: 5.5,
  /** The ceiling reads the field mirrored in x and this many radians ahead. */
  ceilingShift: 1.8,
  /** Discs rest this far above the board so the two never z-fight. */
  lift: 0.012,
  boardRadius: 36,
  discShare: 0.18 / 0.44,
  /** Fronts settle to one quiet tone between these radii; the floor lands on the backing at `hazeEnd`. */
  calmStart: 11,
  calmEnd: 21,
  hazeStart: 12,
  hazeEnd: 32,
  /** Densest slider values, for the instance capacity. */
  minPitch: 0.3,
  maxReach: 34,
} as const;

/** Disc radius for a pitch. */
export function discRadius(pitch: number): number {
  return pitch * FLIP.discShare;
}

/** Square board cells inside a disc, cell centres at half-pitch offsets, emitted row by row from -z to +z (export contract, like the kit's lattices). */
export function squareLattice(pitch: number, radius: number): LatticePoint[] {
  if (!(pitch > 0) || !(radius >= 0)) return [];
  const n = Math.ceil(radius / pitch);
  const out: LatticePoint[] = [];
  for (let j = -n; j < n; j++) {
    for (let i = -n; i < n; i++) {
      const x = (i + 0.5) * pitch;
      const z = (j + 0.5) * pitch;
      if (Math.hypot(x, z) <= radius) out.push({ x, z });
    }
  }
  return out;
}

/** Instance capacity: the densest pitch at the widest reach. */
export const FLIP_CAPACITY = squareLattice(FLIP.minPitch, FLIP.maxReach).length;

/** Loop phase in radians, 0 to TAU over `period` seconds of look time (wrapped in double precision). */
export function flipPhase(t: number, period: number): number {
  return (TAU * loopSeconds(t, period)) / period;
}

/** Field offset that shows Face on about `cover` of the board outside the clearing (an odd quintic fit to the wave sum's quantiles). */
export function flipBias(cover: number): number {
  const u = 0.5 - cover;
  return 1.26893 * u - 0.53054 * u ** 3 + 12.40722 * u ** 5;
}

/** CPU mirror of GLSL `fdField`: three travelling plane waves through a slow domain warp (integer time frequencies, so the loop is exact), minus the clearing. `side` -1 reads it as the ceiling does. Positive shows Face. */
export function flipField(
  x: number,
  z: number,
  phase: number,
  o: { bias: number; clear: number; front: number; side?: 1 | -1 },
): number {
  const side = o.side ?? 1;
  const px = (x * side) / o.front;
  const pz = z / o.front;
  const ph = phase + ((1 - side) * FLIP.ceilingShift) / 2;
  const qx = px + 2.6 * Math.sin(pz / 7 + ph + 0.7);
  const qz = pz + 2.6 * Math.sin(px / 8.5 - 2 * ph + 2.1);
  const s1 = Math.sin(((qx * 0.94 + qz * 0.342) * TAU) / 19 - 4 * ph + 0.4);
  const s2 = Math.sin(((qx * -0.5 + qz * 0.866) * TAU) / 14 - 5 * ph + 2.3);
  const s3 = Math.sin(((qx * -0.208 + qz * -0.978) * TAU) / 23 - 3 * ph + 4.9);
  const f = 0.45 * s1 + 0.33 * s2 + 0.3 * s3 - o.bias;
  const r = Math.hypot(x, z);
  const t = Math.min(1, Math.max(0, (r - o.clear) / 2.5));
  return f - 1.6 * (1 - t * t * (3 - 2 * t));
}
