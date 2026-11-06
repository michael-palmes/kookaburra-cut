/** The dot field's maths: every dot's position, size, opacity and tint for one frame, as a pure function of the authored fields (themselves pure functions of the scene clock). `DotField` uploads the result to one instanced mesh; nothing here reads a clock or `Math.random`, and the seeded orders come from `createSeededRandom`, so a field is byte-identical run to run. Dots index in reading order (row 0 is the TOP row) and positions are world units from the field centre, y up. */

import { ease } from "../../engine/ease";
import { createSeededRandom } from "../../engine/rng";
import { clamp01, lerp } from "../motion/math";

/** Which dot goes first: `reading` (left to right, top row down), `rows-up` (left to right, bottom row up, the waffle-chart fill), `columns` (top to bottom, left column first), `centre` (nearest the middle first) or `random` (seeded). */
export type DotOrder = "reading" | "rows-up" | "columns" | "centre" | "random";

export const DOT_ORDERS: readonly DotOrder[] = [
  "reading",
  "rows-up",
  "columns",
  "centre",
  "random",
];

/** A travelling wave of dot sizes (the halftone wave). */
export interface DotWave {
  /** 0..1: how far the wave reshapes the sizes (default 1). */
  amount?: number;
  /** The direction the crests travel, degrees anticlockwise from +x (default -45, the reading diagonal). */
  angleDeg?: number;
  /** Crest to crest, in dots (default 6). */
  wavelength?: number;
  /** Cycles travelled: drive it from the clock, e.g. `localMs / 1000` (default 0). */
  phase?: number;
  /** Size at a trough, as a fraction of the full dot (default 0.15). */
  min?: number;
}

/** A clearing that opens from a point: the dots there shrink away, the nearest first, leaving a window for a hero number. */
export interface DotWindow {
  /** 0..1: closed to fully open. */
  open: number;
  /** Radius of the cleared middle, in dots (default 2). */
  radius?: number;
  /** Width of the fall-off ring beyond it, in dots (default 1.5). */
  softness?: number;
  /** Centre in dots from the field centre, x right and y up (default [0, 0]). */
  centre?: readonly [number, number];
  /** Shape of the clearing: 2 is round, higher is squarer (default 2). */
  roundness?: number;
  /** 0..1: how far the opening ripples outward from the centre rather than shrinking all at once (default 0.6). */
  ripple?: number;
}

/** Dots popping in one after another. */
export interface DotReveal {
  /** 0..1 through the whole reveal. */
  progress: number;
  /** Default `random`. */
  order?: DotOrder;
  /** Seed for the `random` order (default 1). */
  seed?: number;
  /** Fraction of the reveal each dot takes to pop (default 0.3). */
  span?: number;
  /** The pop's `outBack` overshoot (default 1.70158; 0 lands without one). */
  overshoot?: number;
}

/** A run of dots recoloured in order: `value` dots (fractional values blend the next one) take `color`. Several runs stack one after another. */
export interface DotCount {
  value: number;
  /** Theme token or hex (default `muted`). */
  color?: string;
  /** Read from the first run (default `reading`). */
  order?: DotOrder;
  /** Read from the first run, for `random` (default 1). */
  seed?: number;
}

/** Columns narrowing into an arrow: each column keeps fewer slots than the one before and the extra dots stack onto them. */
export interface DotFunnel {
  /** 0..1 through the narrowing. */
  progress: number;
  /** Dots left in the last column (default 1). */
  to?: number;
  /** 0..1: how far the columns follow one another rather than moving together (default 0.5). */
  stagger?: number;
}

/** Every dot drawn to one point, merging into one dot. */
export interface DotGather {
  /** 0..1 (an eased value past 1 swells the final dot past its size). */
  progress: number;
  /** World units from the field centre (default [0, 0]). */
  to?: readonly [number, number];
  /** The final dot's diameter in world units (default one dot's). */
  size?: number;
}

/** What the per-dot callback sees: the dot after the reveal, wave, window and funnel. */
export interface DotInfo {
  index: number;
  col: number;
  row: number;
  x: number;
  y: number;
  /** Half the dot's size, world units. */
  radius: number;
  alpha: number;
}

/** What the per-dot callback may change. */
export interface DotAdjust {
  /** World units added to the position. */
  offset?: readonly [number, number];
  /** Multiplies the size. */
  scale?: number;
  /** Multiplies the opacity. */
  alpha?: number;
}

/** A count run with its colour resolved to linear RGB. */
export interface DotCountRun {
  value: number;
  rgb: readonly [number, number, number];
}

export interface DotFieldInput {
  columns: number;
  rows: number;
  pitchX: number;
  pitchY: number;
  /** Dot diameter as a fraction of the shorter pitch. */
  size: number;
  reveal?: DotReveal;
  wave?: DotWave;
  window?: DotWindow;
  counts?: readonly DotCountRun[];
  countOrder?: DotOrder;
  countSeed?: number;
  funnel?: DotFunnel;
  gather?: DotGather;
  merge?: number;
  dot?: (info: DotInfo) => DotAdjust | undefined;
}

/** One frame of the field: per dot `dots` holds (x, y, radius, alpha) and `tints` (linear r, g, b, weight). */
export interface DotFieldFrame {
  count: number;
  dots: Float32Array;
  tints: Float32Array;
}

/** The most dots one field draws; larger grids clamp their rows. */
export const DOT_FIELD_MAX = 10000;

const WAVE_DEFAULTS = { amount: 1, angleDeg: -45, wavelength: 6, phase: 0, min: 0.15 };
const WINDOW_DEFAULTS = { radius: 2, softness: 1.5, roundness: 2, ripple: 0.6 };
const REVEAL_DEFAULTS = { order: "random" as DotOrder, seed: 1, span: 0.3, overshoot: 1.70158 };
const FUNNEL_DEFAULTS = { to: 1, stagger: 0.5 };
/** Gathered dots fade out over the last stretch, leaving the one nearest the point to carry the final dot's edge. */
const GATHER_FADE_FROM = 0.92;
/** The funnel's per-column move. */
const FUNNEL_EASE = "inOutCubic";

const finite = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Grid dimensions as whole numbers, at least 1 each and at most DOT_FIELD_MAX dots. */
export function dotGrid(columns: number, rows: number): { columns: number; rows: number } {
  const c = Math.max(1, Math.min(DOT_FIELD_MAX, Math.floor(finite(columns, 1))));
  const r = Math.max(1, Math.min(Math.floor(DOT_FIELD_MAX / c), Math.floor(finite(rows, 1))));
  return { columns: c, rows: r };
}

/** Rank of every dot (by index) in an order: rank 0 goes first. Ties in `centre` break by reading index. */
export function dotRanks(columns: number, rows: number, order: DotOrder, seed = 1): Uint32Array {
  const n = columns * rows;
  const ranks = new Uint32Array(n);
  const sequence = new Uint32Array(n);
  for (let i = 0; i < n; i++) sequence[i] = i;
  if (order === "rows-up") {
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / columns);
      sequence[(rows - 1 - row) * columns + (i % columns)] = i;
    }
  } else if (order === "columns") {
    for (let i = 0; i < n; i++) sequence[(i % columns) * rows + Math.floor(i / columns)] = i;
  } else if (order === "centre") {
    const cx = (columns - 1) / 2;
    const cy = (rows - 1) / 2;
    const dist = (i: number) => (Math.floor(i / columns) - cy) ** 2 + ((i % columns) - cx) ** 2;
    sequence.sort((a, b) => dist(a) - dist(b) || a - b);
  } else if (order === "random") {
    const rand = createSeededRandom(seed);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = sequence[i];
      sequence[i] = sequence[j];
      sequence[j] = t;
    }
  }
  for (let k = 0; k < n; k++) ranks[sequence[k]] = k;
  return ranks;
}

const rankCache = new Map<string, Uint32Array>();
const RANK_CACHE_MAX = 32;

/** `dotRanks`, shared across frames (never mutate the result). */
export function cachedDotRanks(
  columns: number,
  rows: number,
  order: DotOrder,
  seed = 1,
): Uint32Array {
  const key = `${columns}x${rows}:${order}:${seed}`;
  let ranks = rankCache.get(key);
  if (!ranks) {
    ranks = dotRanks(columns, rows, order, seed);
    if (rankCache.size >= RANK_CACHE_MAX) {
      const oldest = rankCache.keys().next().value;
      if (oldest !== undefined) rankCache.delete(oldest);
    }
    rankCache.set(key, ranks);
  }
  return ranks;
}

/** The wave's size multiplier for a dot `cx`, `cy` dots from the centre (y up). */
export function waveScale(wave: DotWave, cx: number, cy: number): number {
  const amount = clamp01(finite(wave.amount, WAVE_DEFAULTS.amount));
  const a = (finite(wave.angleDeg, WAVE_DEFAULTS.angleDeg) * Math.PI) / 180;
  const wavelength = Math.max(1e-3, finite(wave.wavelength, WAVE_DEFAULTS.wavelength));
  const min = clamp01(finite(wave.min, WAVE_DEFAULTS.min));
  const along = cx * Math.cos(a) + cy * Math.sin(a);
  const phase = finite(wave.phase, WAVE_DEFAULTS.phase);
  const level = 0.5 + 0.5 * Math.cos(2 * Math.PI * (along / wavelength - phase));
  return lerp(1, min + (1 - min) * level, amount);
}

/** The window's size multiplier for a dot `cx`, `cy` dots from the field centre: 1 untouched, 0 cleared. */
export function windowScale(win: DotWindow, cx: number, cy: number): number {
  const open = Math.max(0, finite(win.open, 0));
  if (open === 0) return 1;
  const radius = Math.max(0, finite(win.radius, WINDOW_DEFAULTS.radius));
  const softness = Math.max(0, finite(win.softness, WINDOW_DEFAULTS.softness));
  const n = Math.max(1, finite(win.roundness, WINDOW_DEFAULTS.roundness));
  const ripple = clamp01(finite(win.ripple, WINDOW_DEFAULTS.ripple));
  const dx = Math.abs(cx - finite(win.centre?.[0], 0));
  const dy = Math.abs(cy - finite(win.centre?.[1], 0));
  const dist = (dx ** n + dy ** n) ** (1 / n);
  const edge = radius + softness;
  const kept = softness > 0 ? smoothstep(radius, edge, dist) : dist >= radius ? 1 : 0;
  const reach = edge > 0 ? dist / edge : 0;
  const shrink = clamp01(open * (1 + ripple) - ripple * reach);
  return 1 - (1 - kept) * shrink;
}

/** A dot's pop at `progress` through the reveal, by its rank among `n`. */
export function revealScale(reveal: DotReveal, rank: number, n: number): number {
  const p = finite(reveal.progress, 1);
  const span = clamp01(finite(reveal.span, REVEAL_DEFAULTS.span));
  const start = (n > 1 ? rank / (n - 1) : 0) * (1 - span);
  const local = span > 0 ? (p - start) / span : p >= start ? 1 : 0;
  if (local <= 0) return 0;
  if (local >= 1) return 1;
  const overshoot = Math.max(0, finite(reveal.overshoot, REVEAL_DEFAULTS.overshoot));
  return ease("outBack", local, { overshoot });
}

/** Where a funnel sends a dot: its column's eased progress and the slot y it settles on (world units, y up). */
export function funnelTarget(
  funnel: DotFunnel,
  col: number,
  row: number,
  columns: number,
  rows: number,
  pitchY: number,
): { t: number; y: number } {
  const p = finite(funnel.progress, 0);
  const stagger = Math.min(0.95, clamp01(finite(funnel.stagger, FUNNEL_DEFAULTS.stagger)));
  const at = columns > 1 ? col / (columns - 1) : 1;
  const local = clamp01((p - stagger * at) / (1 - stagger));
  const to = Math.min(rows, Math.max(1, finite(funnel.to, FUNNEL_DEFAULTS.to)));
  const slots = Math.max(1, Math.round(lerp(rows, to, at)));
  const slot = Math.floor((row * slots) / rows);
  return { t: ease(FUNNEL_EASE, local), y: ((slots - 1) / 2 - slot) * pitchY };
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** One frame of the field. Reuses `out` when it already holds the right count. */
export function dotFieldFrame(input: DotFieldInput, out?: DotFieldFrame): DotFieldFrame {
  const { columns, rows } = dotGrid(input.columns, input.rows);
  const n = columns * rows;
  const frame =
    out && out.count === n
      ? out
      : { count: n, dots: new Float32Array(n * 4), tints: new Float32Array(n * 4) };
  const { dots, tints } = frame;
  const pitchX = finite(input.pitchX, 0);
  const pitchY = finite(input.pitchY, 0);
  const r0 =
    0.5 * Math.max(0, finite(input.size, 0)) * Math.min(Math.abs(pitchX), Math.abs(pitchY));
  const halfC = (columns - 1) / 2;
  const halfR = (rows - 1) / 2;

  const reveal = input.reveal;
  const revealRanks = reveal
    ? cachedDotRanks(
        columns,
        rows,
        reveal.order ?? REVEAL_DEFAULTS.order,
        finite(reveal.seed, REVEAL_DEFAULTS.seed),
      )
    : null;
  const counts = input.counts?.filter((c) => Number.isFinite(c.value) && c.value > 0) ?? [];
  const countRanks =
    counts.length > 0
      ? cachedDotRanks(columns, rows, input.countOrder ?? "reading", finite(input.countSeed, 1))
      : null;

  const gather = input.gather;
  const g = gather ? finite(gather.progress, 0) : 0;
  const gx = finite(gather?.to?.[0], 0);
  const gy = finite(gather?.to?.[1], 0);
  const gr = gather?.size === undefined ? r0 : Math.max(0, finite(gather.size, 0)) / 2;
  let keeper = -1;
  if (gather && g > 0) {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const d = ((i % columns) - halfC) * pitchX - gx;
      const e = (halfR - Math.floor(i / columns)) * pitchY - gy;
      const dist = d * d + e * e;
      if (dist < best) {
        best = dist;
        keeper = i;
      }
    }
  }
  const merge = clamp01(finite(input.merge, 0));
  const home = clamp01(merge * 2);

  for (let i = 0; i < n; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const cx = col - halfC;
    const cy = halfR - row;
    const hx = cx * pitchX;
    const hy = cy * pitchY;
    let x = hx;
    let y = hy;
    let radius = r0;
    let alpha = 1;
    if (revealRanks && reveal) radius *= revealScale(reveal, revealRanks[i], n);
    if (input.wave) radius *= waveScale(input.wave, cx, cy);
    if (input.window) radius *= windowScale(input.window, cx, cy);
    if (input.funnel) {
      const f = funnelTarget(input.funnel, col, row, columns, rows, pitchY);
      y = lerp(y, f.y, f.t);
    }
    if (input.dot) {
      const adjust = input.dot({ index: i, col, row, x, y, radius, alpha });
      if (adjust) {
        x += finite(adjust.offset?.[0], 0);
        y += finite(adjust.offset?.[1], 0);
        radius *= Math.max(0, finite(adjust.scale, 1));
        alpha *= Math.max(0, finite(adjust.alpha, 1));
      }
    }
    if (gather && g !== 0) {
      const move = clamp01(g);
      x = lerp(x, gx, move);
      y = lerp(y, gy, move);
      radius = Math.max(0, lerp(radius, gr, g));
      if (i !== keeper) alpha *= 1 - clamp01((g - GATHER_FADE_FROM) / (1 - GATHER_FADE_FROM));
    }
    if (home > 0) {
      x = home >= 1 ? hx : lerp(x, hx, home);
      y = home >= 1 ? hy : lerp(y, hy, home);
    }
    const o = i * 4;
    dots[o] = x;
    dots[o + 1] = y;
    dots[o + 2] = radius;
    dots[o + 3] = clamp01(alpha);

    let r = 0;
    let gg = 0;
    let b = 0;
    let w = 0;
    if (countRanks) {
      const k = countRanks[i];
      let start = 0;
      for (const run of counts) {
        const end = start + run.value;
        const amount = clamp01(Math.min(k + 1, end) - Math.max(k, start));
        if (amount > 0) {
          r += amount * run.rgb[0];
          gg += amount * run.rgb[1];
          b += amount * run.rgb[2];
          w += amount;
        }
        start = end;
        if (start >= k + 1) break;
      }
    }
    tints[o] = w > 0 ? r / w : 0;
    tints[o + 1] = w > 0 ? gg / w : 0;
    tints[o + 2] = w > 0 ? b / w : 0;
    tints[o + 3] = clamp01(w);
  }
  return frame;
}
