/** The chart build-state seam shared by the 2D and 3D renderers: a renderer asks for one element's `ChartReveal` (or one series' `ChartSeriesReveal`) and applies it, so `animation.ts` can thread real sampling through `ChartRendererProps.reveal` without either renderer changing shape. Pure: no clock, no state. */

import type { ChartReveal, ChartRevealFn, ChartSeriesReveal, ChartSeriesRevealFn } from "./types";

/** The default every renderer falls back to: final state, fully opaque, nothing counting, pulsing or shining, and nothing displaced. */
export const CHART_FULL_REVEAL: ChartReveal = {
  grow: 1,
  alpha: 1,
  count: 1,
  pulse: 0,
  shine: -1,
  drop: 0,
};

/** The per-series default: fully drawn, no head, fully opaque. */
export const CHART_FULL_SERIES_REVEAL: ChartSeriesReveal = { draw: 1, headX: -1, alpha: 1 };

/** The most a preset overshoot may push `grow` past a mark's final extent (the 2 to 6 percent house rule, clamped one place). */
export const CHART_GROW_MAX = 1.06;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

/** Channels that are off at 0 (pulse) rather than on at 1: a non-finite sample reads as off. */
const clampOff = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** The shine band: -1 (no band) or a 0..1 sweep position. */
const clampBand = (v: number): number => (Number.isFinite(v) && v >= 0 ? Math.min(1, v) : -1);

/** The entrance displacement: a signed plot-space offset, capped at one whole plot so a preset can never fling an element out of the world. */
const clampDrop = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0);

/** One element's build state, clamped so a preset overshoot can never invert a mark, push alpha past opaque, print a counting label past its true value, or displace an element off the plot. */
export function revealAt(
  reveal: ChartRevealFn | undefined,
  seriesIndex: number,
  categoryIndex: number,
): ChartReveal {
  if (!reveal) return CHART_FULL_REVEAL;
  const r = reveal(seriesIndex, categoryIndex);
  return {
    grow: Number.isFinite(r.grow) ? Math.min(CHART_GROW_MAX, Math.max(0, r.grow)) : 1,
    alpha: clamp01(r.alpha),
    count: clamp01(r.count),
    pulse: clampOff(r.pulse),
    shine: clampBand(r.shine),
    drop: clampDrop(r.drop),
  };
}

/** One series' build state, clamped the same way; `headX` stays -1 or a plot-space 0..1. */
export function seriesRevealAt(
  series: ChartSeriesRevealFn | undefined,
  seriesIndex: number,
): ChartSeriesReveal {
  if (!series) return CHART_FULL_SERIES_REVEAL;
  const r = series(seriesIndex);
  return { draw: clamp01(r.draw), headX: clampBand(r.headX), alpha: clamp01(r.alpha) };
}

/** The alpha a whole stroke or fill takes when its points reveal individually: the mean of its per-point alphas, so `delivery: "all"` is exactly the shared alpha and a cascade fades in smoothly. */
export function meanAlpha(
  reveal: ChartRevealFn | undefined,
  seriesIndex: number,
  categoryCount: number,
): number {
  if (!reveal || categoryCount <= 0) return 1;
  let total = 0;
  for (let c = 0; c < categoryCount; c++) total += revealAt(reveal, seriesIndex, c).alpha;
  return total / categoryCount;
}
