import { createSeededRandom } from "../../../../../engine/rng";

/** Wind wands: a grove of Len Lye kinetic rods in three staggered rows, each a cantilever bent by a closed-form tip load (a lean downwind, a gust band crossing the grove, a crosswind sway with a lurch). The GLSL in shaders.ts mirrors `wandTip` and `wandPoint` exactly; tests run the CPU copies. */

const TAU = Math.PI * 2;

export const GROVE = {
  /** Every motion term is a whole number of cycles in this loop. */
  loop: 120,
  floorY: -2.1,
  /** Row offsets from the First row radius, and their share of the wand count (the sketch's 20, 28 and 36 of 84). */
  rows: [
    { offset: 0, share: 20 },
    { offset: 8, share: 28 },
    { offset: 17, share: 36 },
  ],
  maxWands: 160,
  segments: 16,
  /** Gust band wavelength across the grove. */
  gustLength: 36,
  /** Wind heading (radians in xz from +x toward +z): a mean plus a veer of 26 degrees either way, once per loop. */
  windMean: 0.35,
  windVeer: 0.45,
  seed: 0x3a4d,
} as const;

export interface Wand {
  x: number;
  z: number;
  /** Height before the Height param scales it. */
  height: number;
  /** Whole sway cycles per loop (5 to 9 s periods). */
  cycles: number;
  phase: number;
  stiffness: number;
  row: number;
}

/** Wand counts per row for a total, proportional to the sketch's rows, summing exactly. */
export function rowCounts(total: number): number[] {
  const n = Math.max(GROVE.rows.length, Math.round(total));
  const sum = GROVE.rows.reduce((s, r) => s + r.share, 0);
  const counts = GROVE.rows.map((r) => Math.max(1, Math.round((n * r.share) / sum)));
  counts[counts.length - 1] = Math.max(1, n - counts.slice(0, -1).reduce((s, c) => s + c, 0));
  return counts;
}

/** The planted grove: concentric staggered rows (inner first), heights rolling round each row so tips never line up into a dotted line. */
export function groveWands(count: number, inner: number): Wand[] {
  const rand = createSeededRandom(GROVE.seed);
  const counts = rowCounts(count);
  const out: Wand[] = [];
  GROVE.rows.forEach((row, k) => {
    const r = inner + row.offset;
    const n = counts[k];
    const off = k % 2 ? 0.5 : 0.25;
    for (let i = 0; i < n; i++) {
      const a = ((i + off) / n) * TAU - Math.PI / 2;
      const crown = Math.sin(3 * a + k * 1.3) * 0.5 + Math.sin(5 * a + k) * 0.25;
      const height = (0.3 + 0.05 * crown + 0.02 * rand()) * (r + 5) + 0.5;
      out.push({
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        height,
        cycles: 14 + Math.floor(rand() * 9),
        phase: rand() * TAU,
        stiffness: 0.85 + 0.3 * rand(),
        row: k,
      });
    }
  });
  return out;
}

/** Gust period snapped so a whole number of gusts fills the loop. */
export function gustPeriod(every: number): number {
  return GROVE.loop / Math.max(1, Math.round(GROVE.loop / Math.max(every, 1e-3)));
}

export interface WindState {
  /** Look seconds inside the loop. */
  time: number;
  lean: number;
  sway: number;
  gustPeriod: number;
  heightScale: number;
}

/** Downwind unit vector (x, z). */
export function windDirection(time: number): [number, number] {
  const psi = GROVE.windMean + GROVE.windVeer * Math.sin((TAU * time) / GROVE.loop);
  return [Math.cos(psi), Math.sin(psi)];
}

/** Tip deflection (x, z) of a wand: downwind lean grown by the passing gust, plus a crosswind sway with a lurch. */
export function wandTip(w: Wand, s: WindState): [number, number] {
  const h = w.height * s.heightScale;
  const [wx, wz] = windDirection(s.time);
  const g0 =
    0.5 + 0.5 * Math.cos(TAU * ((w.x * wx + w.z * wz) / GROVE.gustLength - s.time / s.gustPeriod));
  const g = g0 * g0;
  const ph = (TAU * w.cycles * s.time) / GROVE.loop + w.phase;
  const sway = Math.sin(ph) + 0.22 * Math.sin(3 * ph);
  const amp = s.sway * h * w.stiffness * (0.55 + 0.9 * g);
  const lean = h * w.stiffness * (s.lean * (0.35 + g) + 0.25 * s.sway * Math.sin(2 * ph + 1.1));
  return [wx * lean - wz * amp * sway, wz * lean + wx * amp * sway];
}

/** A point `along` (0 foot, 1 tip) a bent wand: the cantilever deflection curve, the tip dropping as it swings so the rod keeps its length. */
export function wandPoint(
  w: Wand,
  tip: [number, number],
  along: number,
  heightScale: number,
): [number, number, number] {
  const h = w.height * heightScale;
  const bend = (along * along * (3 - along)) / 2;
  const drop = (0.6 * (tip[0] * tip[0] + tip[1] * tip[1]) * along * along * along) / h;
  return [w.x + tip[0] * bend, GROVE.floorY + h * along - drop, w.z + tip[1] * bend];
}

/** Haze window (tan of elevation from the stage) for the Haze param in degrees: rods dissolve below it so the text band stays quiet. */
export function hazeWindow(deg: number): [number, number] {
  const rad = Math.PI / 180;
  return [Math.tan(Math.max(0, deg - 5) * rad), Math.tan((deg + 6) * rad)];
}
