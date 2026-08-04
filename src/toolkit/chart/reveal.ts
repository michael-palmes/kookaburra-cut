/** The chart build-state seam shared by the 2D and 3D renderers: a renderer asks for one element's `ChartReveal` and applies it, so the animation phase can thread real sampling through `ChartRendererProps.reveal` without either renderer changing shape. Pure: no clock, no state. */

import type { ChartReveal, ChartRevealFn } from "./types";

/** The default every renderer falls back to: final state, fully opaque. */
export const CHART_FULL_REVEAL: ChartReveal = { grow: 1, alpha: 1 };

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

/** One element's build state, clamped to 0..1 so a preset overshoot can never invert a mark or push alpha past opaque. */
export function revealAt(
  reveal: ChartRevealFn | undefined,
  seriesIndex: number,
  categoryIndex: number,
): ChartReveal {
  if (!reveal) return CHART_FULL_REVEAL;
  const r = reveal(seriesIndex, categoryIndex);
  return { grow: clamp01(r.grow), alpha: clamp01(r.alpha) };
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
