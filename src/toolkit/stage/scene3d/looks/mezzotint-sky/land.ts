import { BufferAttribute, BufferGeometry } from "three";
import { createSeededRandom } from "../../../../../engine/rng";
import { smoothstep } from "../../kit/math";

/** Mezzotint sky land: low rolling ridges ringing the stage on one static polar heightfield that runs out to meet the dome, and thin mist strata lying in the valleys between them. Heights are stored at Land relief 1 above the floor; the vertex stage scales them. */

const TAU = Math.PI * 2;
const SEED = 0x6d2e;

export const MEZZO_LAND = {
  floorY: -2.5,
  /** The dome's radius: the land's rim lies on the dome sphere, so the two meet from any pose. */
  domeRadius: 300,
  rings: 240,
  columns: 512,
  inner: 0.75,
  /** Rolling swell over the floor between the ridges. */
  roll: 0.3,
  /** The stage-courtesy clearing: flat inside the first radius, swelling in by the second. */
  clearing: [5, 11],
  /** Relief fades out over this span, so the rim meets the dome flat. */
  flatten: [150, 220],
  reliefMax: 1.5,
  /** Inside the camera reach the land saturates under this height (relief 1), lifting over `reach`, so a dolly out at eye level never meets it. */
  reachCap: 1.4,
  reach: [55, 75],
} as const;

/** The land disc's radius: the floor plane's circle on the dome sphere. */
export const MEZZO_LAND_RADIUS = Math.sqrt(MEZZO_LAND.domeRadius ** 2 - MEZZO_LAND.floorY ** 2);

/** One ridge ring: crest `radius` out at its nearest, wandering out by up to `wobble`; `height` above the floor at relief 1; Gaussian widths toward the stage (`inner`) and outward (`outer`); the integer `turns` of its height profile. */
export interface MezzoRidge {
  radius: number;
  height: number;
  inner: number;
  outer: number;
  wobble: number;
  turns: readonly number[];
}

/** Near ridges stay low (the camera reach is 50), far ones rise to stand against the haze. */
export const MEZZO_RIDGES: readonly MezzoRidge[] = [
  { radius: 12, height: 0.95, inner: 1.4, outer: 2.4, wobble: 4, turns: [3, 5, 8, 13, 21] },
  { radius: 19, height: 1.15, inner: 2, outer: 3.4, wobble: 7, turns: [3, 6, 10, 17, 27] },
  { radius: 29, height: 1.3, inner: 3, outer: 5, wobble: 11, turns: [4, 7, 11, 19, 31] },
  { radius: 45, height: 1.4, inner: 4.4, outer: 7.5, wobble: 17, turns: [4, 8, 13, 23, 37] },
  { radius: 72, height: 3.6, inner: 7, outer: 11, wobble: 26, turns: [5, 9, 15, 26, 43] },
  { radius: 120, height: 7, inner: 10, outer: 17, wobble: 40, turns: [6, 11, 18, 31, 53] },
];

/** Scattered knolls between the ridges, so the rings break into country: count, the radius span they sit in and their height above the floor at relief 1 (scaled down inside the camera reach). */
export const MEZZO_KNOLLS = { count: 64, from: 15, to: 140, height: [0.35, 1.1] } as const;

/** One mist stratum: a thin sheet `height` above the floor (relief 1) over the annulus `from` to `to`, its wisps turning `turns` whole times per Drift period. */
export interface MezzoStratum {
  from: number;
  to: number;
  height: number;
  turns: number;
}

/** One stratum in each valley, rising gently with distance like the land. */
export const MEZZO_STRATA: readonly MezzoStratum[] = [
  { from: 11, to: 22, height: 0.45, turns: 2 },
  { from: 18, to: 33, height: 0.6, turns: 2 },
  { from: 27, to: 50, height: 0.72, turns: 1 },
  { from: 42, to: 78, height: 0.95, turns: 1 },
  { from: 68, to: 128, height: 1.6, turns: 1 },
];

export const MEZZO_STRATUM_GRID = { rows: 12, columns: 256 } as const;

/** A seamless angular profile in -1..1: integer harmonics with falling weights and seeded phases. */
function profile(turns: readonly number[], rand: () => number): (th: number) => number {
  const hs = turns.map((n, i) => ({ n, a: 1 / (1 + i * 0.8), p: rand() * TAU }));
  const raw = (th: number) => hs.reduce((s, h) => s + h.a * Math.sin(h.n * th + h.p), 0);
  let peak = 1e-6;
  for (let j = 0; j < 720; j++) peak = Math.max(peak, Math.abs(raw((j / 720) * TAU)));
  return (th) => raw(th) / peak;
}

/** One direction round the stage: each ridge's crest radius and height share there. */
interface Column {
  c: number;
  s: number;
  crestR: Float64Array;
  share: Float64Array;
}

interface Field {
  column: (th: number) => Column;
  /** Height above the floor at relief 1 and the crest weight at radius `r` along `col`. */
  sample: (r: number, col: Column) => { height: number; crest: number };
}

function buildField(): Field {
  const rand = createSeededRandom(SEED);
  const ridges = MEZZO_RIDGES.map((g) => ({
    ...g,
    amp: profile(g.turns, rand),
    wander: profile([1, 2, 3], rand),
  }));
  const swells = Array.from({ length: 5 }, () => {
    const a = rand() * TAU;
    const f = 0.2 + rand() * 0.25;
    return { kx: Math.cos(a) * f, kz: Math.sin(a) * f, p: rand() * TAU };
  });
  const knolls = Array.from({ length: MEZZO_KNOLLS.count }, () => {
    const th = rand() * TAU;
    const r = MEZZO_KNOLLS.from * (MEZZO_KNOLLS.to / MEZZO_KNOLLS.from) ** rand();
    const [lo, hi] = MEZZO_KNOLLS.height;
    const size = r * (0.07 + 0.06 * rand());
    return {
      x: Math.cos(th) * r,
      z: Math.sin(th) * r,
      inv: 1 / (size * size),
      height: (lo + (hi - lo) * rand()) * (0.6 + 1.4 * smoothstep(40, 70, r)) * (r / 40) ** 0.3,
    };
  });
  const [c0, c1] = MEZZO_LAND.clearing;
  const [f0, f1] = MEZZO_LAND.flatten;
  const [r0, r1] = MEZZO_LAND.reach;
  const out = { height: 0, crest: 0 };
  return {
    column(th) {
      return {
        c: Math.cos(th),
        s: Math.sin(th),
        crestR: Float64Array.from(ridges, (g) => g.radius + g.wobble * (0.5 + 0.5 * g.wander(th))),
        share: Float64Array.from(ridges, (g) => smoothstep(-0.25, 0.85, g.amp(th))),
      };
    },
    sample(r, col) {
      const x = col.c * r;
      const z = col.s * r;
      let sw = 0;
      for (const w of swells) sw += Math.sin(w.kx * x + w.kz * z + w.p);
      let h = MEZZO_LAND.roll * (0.5 + 0.1 * sw);
      let crest = 0;
      for (let k = 0; k < ridges.length; k++) {
        const g = ridges[k];
        const d = r - col.crestR[k];
        const u = d / (d < 0 ? g.inner : g.outer);
        const e = Math.exp(-0.5 * u * u);
        h += g.height * col.share[k] * e;
        crest = Math.max(crest, e ** 4 * col.share[k]);
      }
      for (const n of knolls) {
        const u2 = ((x - n.x) ** 2 + (z - n.z) ** 2) * n.inv;
        if (u2 < 9) h += n.height * Math.exp(-0.5 * u2);
      }
      const keep = smoothstep(c0, c1, r) * (1 - smoothstep(f0, f1, r));
      const cap = MEZZO_LAND.reachCap + 50 * smoothstep(r0, r1, r);
      out.height = cap * (1 - Math.exp(-(h * keep) / cap));
      out.crest = crest * keep;
      return out;
    },
  };
}

let field: Field | null = null;
const landField = (): Field => {
  field ??= buildField();
  return field;
};

/** Land height above the floor at relief 1: 0 in the stage clearing and at the rim. */
export function mezzoLandHeight(x: number, z: number): number {
  const f = landField();
  return f.sample(Math.hypot(x, z), f.column(Math.atan2(z, x))).height;
}

/** How near (x, z) sits to a full-height crest: 1 on the crest line, 0 in the valleys and on low stretches. */
export function mezzoLandCrest(x: number, z: number): number {
  const f = landField();
  return f.sample(Math.hypot(x, z), f.column(Math.atan2(z, x))).crest;
}

/** Radius of land ring `i`: geometric, so ring spacing tracks distance (finer near the stage). */
export function mezzoLandRingRadius(i: number): number {
  const { inner, rings } = MEZZO_LAND;
  return inner * (MEZZO_LAND_RADIUS / inner) ** (i / rings);
}

interface LandData {
  position: Float32Array;
  land: Float32Array;
  index: Uint32Array;
}

let landCache: LandData | null = null;

function buildLand(): LandData {
  const { rings, columns } = MEZZO_LAND;
  const f = landField();
  const count = 1 + (rings + 1) * columns;
  const position = new Float32Array(count * 3);
  const land = new Float32Array(count * 3);
  const heights = new Float64Array((rings + 1) * columns);
  const radii = Array.from({ length: rings + 1 }, (_, i) => mezzoLandRingRadius(i));
  const cols = Array.from({ length: columns }, (_, j) => f.column((j / columns) * TAU));
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j < columns; j++) {
      const { height, crest } = f.sample(radii[i], cols[j]);
      const v = 1 + i * columns + j;
      heights[i * columns + j] = height;
      position[v * 3] = cols[j].c * radii[i];
      position[v * 3 + 1] = height;
      position[v * 3 + 2] = cols[j].s * radii[i];
      land[v * 3 + 2] = crest;
    }
  }
  const dTh = TAU / columns;
  for (let i = 0; i <= rings; i++) {
    const iLo = Math.max(0, i - 1);
    const iHi = Math.min(rings, i + 1);
    for (let j = 0; j < columns; j++) {
      const at = (ii: number, jj: number) => heights[ii * columns + ((jj + columns) % columns)];
      const dr = (at(iHi, j) - at(iLo, j)) / (radii[iHi] - radii[iLo]);
      const dt = (at(i, j + 1) - at(i, j - 1)) / (2 * dTh * radii[i]);
      const { c, s } = cols[j];
      const v = 1 + i * columns + j;
      land[v * 3] = dr * c - dt * s;
      land[v * 3 + 1] = dr * s + dt * c;
    }
  }
  const index = new Uint32Array((columns + rings * columns * 2) * 3);
  let q = 0;
  for (let j = 0; j < columns; j++) {
    index.set([0, 1 + ((j + 1) % columns), 1 + j], q);
    q += 3;
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < columns; j++) {
      const a = 1 + i * columns + j;
      const b = 1 + i * columns + ((j + 1) % columns);
      index.set([a, b, a + columns, b, b + columns, a + columns], q);
      q += 6;
    }
  }
  return { position, land, index };
}

/** The land heightfield: a centre vertex then `rings + 1` rings of `columns`, faces up, built once per session (pure and seeded). `position` holds (x, height at relief 1, z); `aLand` the height's slope (d/dx, d/dz) and the crest weight. */
export function createMezzoLandGeometry(): BufferGeometry {
  landCache ??= buildLand();
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(landCache.position, 3));
  g.setAttribute("aLand", new BufferAttribute(landCache.land, 3));
  g.setIndex(new BufferAttribute(landCache.index, 1));
  return g;
}

/** Every mist stratum in one mesh, far to near (the fixed draw order). `position` holds (x, sheet height at relief 1, z); `aMist` the land height under the vertex, the stratum's turns, and its inner and outer radius. */
export function createMezzoMistGeometry(): BufferGeometry {
  const { rows, columns } = MEZZO_STRATUM_GRID;
  const strata = [...MEZZO_STRATA].sort((a, b) => b.from - a.from);
  const per = (rows + 1) * columns;
  const position = new Float32Array(strata.length * per * 3);
  const mist = new Float32Array(strata.length * per * 4);
  const index = new Uint32Array(strata.length * rows * columns * 6);
  const f = landField();
  const cols = Array.from({ length: columns }, (_, j) => f.column((j / columns) * TAU));
  let v = 0;
  let q = 0;
  for (const st of strata) {
    const base = v;
    for (let i = 0; i <= rows; i++) {
      const r = st.from + ((st.to - st.from) * i) / rows;
      for (const col of cols) {
        position.set([col.c * r, st.height, col.s * r], v * 3);
        mist.set([f.sample(r, col).height, st.turns, st.from, st.to], v * 4);
        v++;
      }
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < columns; j++) {
        const a = base + i * columns + j;
        const b = base + i * columns + ((j + 1) % columns);
        index.set([a, b, a + columns, b, b + columns, a + columns], q);
        q += 6;
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(position, 3));
  g.setAttribute("aMist", new BufferAttribute(mist, 4));
  g.setIndex(new BufferAttribute(index, 1));
  return g;
}
