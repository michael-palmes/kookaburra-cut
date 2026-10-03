import { createSeededRandom } from "../../../../../engine/rng";
import { smoothstep } from "../../kit/math";

/** Engraved hills terrain: four ranges of downs ringing the stage on one static polar heightfield (columns by angle, rows by radius), built once and cached. Heights and crests are integer harmonics of the angle, so every ring is seamless. */

export const HILLS_FLOOR_Y = -2;
export const HILLS_COLUMNS = 640;
export const HILLS_ROWS = 160;
export const HILLS_OUTER = 110;
/** Everything loops over this many seconds of look time (clouds once round, the sun four swings). */
export const HILLS_PERIOD = 240;
export const HILLS_SUN = { azimuthDeg: 90, elevationDeg: 20, periodS: 60 } as const;

const TAU = Math.PI * 2;
const SEED = 0x4e11;

export interface HillRange {
  radius: number;
  /** Gaussian half-width toward the stage; 1.35 times it outward. */
  width: number;
  height: number;
  /** Crest radius wobble. */
  wobble: number;
  /** Aerial depth: paler, finer ink. */
  aerial: number;
  /** Crest outline width in reference px. */
  px: number;
  /** Units below the crest over which the hill body fades to mist. */
  fade: number;
  heightHarmonics: readonly number[];
  wobbleHarmonics: readonly number[];
}

export const HILL_RANGES: readonly HillRange[] = [
  {
    radius: 11.5,
    width: 3.2,
    height: 4.6,
    wobble: 1.1,
    aerial: 0,
    px: 4,
    fade: 5,
    heightHarmonics: [3, 5, 8, 12],
    wobbleHarmonics: [2, 4, 7],
  },
  {
    radius: 18,
    width: 3.8,
    height: 7,
    wobble: 1.5,
    aerial: 0.3,
    px: 3.2,
    fade: 4.2,
    heightHarmonics: [4, 6, 9, 14],
    wobbleHarmonics: [3, 5, 8],
  },
  {
    radius: 27,
    width: 5,
    height: 11,
    wobble: 2,
    aerial: 0.55,
    px: 2.6,
    fade: 5.5,
    heightHarmonics: [3, 5, 7, 11],
    wobbleHarmonics: [2, 5, 7],
  },
  {
    radius: 58,
    width: 9,
    height: 19,
    wobble: 4,
    aerial: 0.85,
    px: 2.1,
    fade: 9,
    heightHarmonics: [2, 4, 6, 9],
    wobbleHarmonics: [3, 4, 6],
  },
];

/** A seamless angular profile in -1..1: integer harmonics with falling weights and seeded phases. */
function harmonics(ns: readonly number[], rand: () => number): (th: number) => number {
  const hs = ns.map((n, i) => ({ n, a: 1 / (1 + i * 0.7), p: rand() * TAU }));
  const raw = (th: number) => hs.reduce((s, h) => s + h.a * Math.sin(h.n * th + h.p), 0);
  let peak = 0;
  for (let j = 0; j < 720; j++) peak = Math.max(peak, Math.abs(raw((j / 720) * TAU)));
  return (th) => raw(th) / peak;
}

/** 0 inside the content footprint (x +-4, z -6 to 9), rising to 1 four units out: hills stand down near the stage. */
export function hillsClearance(x: number, z: number): number {
  const dx = Math.max(Math.abs(x) - 4, 0);
  const dz = Math.max(z - 9, -6 - z, 0);
  return smoothstep(0.5, 4, Math.hypot(dx, dz));
}

interface Column {
  c: number;
  s: number;
  crestR: number[];
  amp: number[];
}

/** The terrain field: height at (radius, column), each range's share left in `contrib` and `gauss` for the soft range weights. */
function terrain() {
  const rand = createSeededRandom(SEED);
  const ranges = HILL_RANGES.map((g) => {
    const perH = harmonics(g.heightHarmonics, rand);
    const perW = harmonics(g.wobbleHarmonics, rand);
    return { ...g, perH, perW };
  });
  const swells = Array.from({ length: 5 }, () => {
    const a = rand() * TAU;
    const f = 0.22 + rand() * 0.3;
    return { kx: Math.cos(a) * f, kz: Math.sin(a) * f, p: rand() * TAU };
  });
  const columns: Column[] = Array.from({ length: HILLS_COLUMNS }, (_, j) => {
    const th = (j / HILLS_COLUMNS) * TAU;
    return {
      c: Math.cos(th),
      s: Math.sin(th),
      crestR: ranges.map((g) => g.radius + g.wobble * g.perW(th)),
      amp: ranges.map((g) => g.height * (0.775 + 0.225 * g.perH(th))),
    };
  });
  const contrib = new Float64Array(ranges.length);
  const gauss = new Float64Array(ranges.length);
  const height = (r: number, col: Column) => {
    const x = col.c * r;
    const z = col.s * r;
    const m = hillsClearance(x, z);
    let h = HILLS_FLOOR_Y + 0.3 * smoothstep(5, 13, r) * m;
    let sw = 0;
    for (const s of swells) sw += Math.sin(s.kx * x + s.kz * z + s.p);
    h += 0.03 * sw * m * (1 - smoothstep(30, 60, r));
    for (let k = 0; k < ranges.length; k++) {
      const g = ranges[k];
      const rc = col.crestR[k];
      const u = (r - rc) / (r < rc ? g.width : g.width * 1.35);
      const e = Math.exp(-u * u);
      h += col.amp[k] * e * m;
      contrib[k] = col.amp[k] * e * m;
      gauss[k] = e * m;
    }
    return h;
  };
  return { columns, height, contrib, gauss };
}

export interface HillsData {
  /** (rows + 1) x columns vertices, row-major from the centre out. */
  positions: Float32Array;
  /** Per vertex: hill body (1 at a crest, mist a few units below), aerial depth, valley floor. */
  hill: Float32Array;
  index: Uint32Array;
  /** Per range, a closed crest loop of (x, y, z, clearance) points, one per column. */
  crests: Float32Array[];
}

let cache: HillsData | null = null;

/** The terrain, built once per session (pure and seeded, so every build is identical). */
export function hillsData(): HillsData {
  cache ??= buildHills();
  return cache;
}

/** Radius of heightfield row `i`: rows bunch toward the stage, where the ranges sit nearest. */
export function hillsRowRadius(i: number): number {
  return HILLS_OUTER * (i / HILLS_ROWS) ** 1.35;
}

export function buildHills(): HillsData {
  const { columns, height, contrib, gauss } = terrain();
  const nr = HILL_RANGES.length;
  // Each range's crest per column, searched round its own peak so the outline stays continuous.
  const crests = HILL_RANGES.map((g, k) => {
    const out = new Float32Array(HILLS_COLUMNS * 4);
    columns.forEach((col, j) => {
      const rc = col.crestR[k];
      let best = rc;
      let bestH = Number.NEGATIVE_INFINITY;
      for (let r = rc - 0.2 * g.width; r <= rc + 0.2 * g.width; r += 0.02) {
        const h = height(r, col);
        if (h > bestH) {
          bestH = h;
          best = r;
        }
      }
      const x = col.c * best;
      const z = col.s * best;
      out.set([x, bestH + 0.02, z, hillsClearance(x, z)], j * 4);
    });
    return out;
  });
  const count = (HILLS_ROWS + 1) * HILLS_COLUMNS;
  const positions = new Float32Array(count * 3);
  const hill = new Float32Array(count * 3);
  let o = 0;
  for (let i = 0; i <= HILLS_ROWS; i++) {
    const r = hillsRowRadius(i);
    for (let j = 0; j < HILLS_COLUMNS; j++) {
      const col = columns[j];
      const y = height(r, col);
      // Soft range weights (squared shares), so body and aerial depth never jump between columns.
      let wSum = 1e-6;
      let body = 0;
      let aer = 0;
      let gMax = 0;
      for (let k = 0; k < nr; k++) {
        const w = contrib[k] * contrib[k];
        wSum += w;
        body += w * (1 - smoothstep(0, HILL_RANGES[k].fade, crests[k][j * 4 + 1] - y));
        aer += w * HILL_RANGES[k].aerial;
        gMax = Math.max(gMax, gauss[k]);
      }
      hill[o] = body / wSum;
      hill[o + 1] = aer / wSum;
      hill[o + 2] = 1 - smoothstep(0.04, 0.3, gMax);
      positions[o++] = col.c * r;
      positions[o++] = y;
      positions[o++] = col.s * r;
    }
  }
  const index = new Uint32Array(HILLS_ROWS * HILLS_COLUMNS * 6);
  let q = 0;
  for (let i = 0; i < HILLS_ROWS; i++) {
    for (let j = 0; j < HILLS_COLUMNS; j++) {
      const a = i * HILLS_COLUMNS + j;
      const b = i * HILLS_COLUMNS + ((j + 1) % HILLS_COLUMNS);
      index.set([a, b, a + HILLS_COLUMNS, b, b + HILLS_COLUMNS, a + HILLS_COLUMNS], q);
      q += 6;
    }
  }
  return { positions, hill, index, crests };
}
