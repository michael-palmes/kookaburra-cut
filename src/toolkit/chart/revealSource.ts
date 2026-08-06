/** The renderer-side reveal adapter: every renderer takes ONE `reveal` prop that is either the bare per-element function (the original seam, still what a scene may hand `<Chart />`) or the full `ChartRevealSampler` the build-in produces. Renderers never branch on which: they read elements through `revealAt` and series through `chartSeriesReveal`, and a bare function degrades to the pre-animation behaviour (no draw channel, no head, the mean of its point alphas). Pure: no clock, no state. */

import { CHART_FULL_SERIES_REVEAL, meanAlpha, seriesRevealAt } from "./reveal";
import type {
  ChartRevealFn,
  ChartRevealSource,
  ChartSeriesReveal,
  ChartSeriesRevealFn,
} from "./types";

export type { ChartRevealSource } from "./types";

/** The per-element lookup inside a source. */
export const chartRevealFn = (source: ChartRevealSource | undefined): ChartRevealFn | undefined =>
  typeof source === "function" ? source : source?.at;

/** The per-series lookup inside a source; absent for a bare function, which carries no series channels. */
export const chartSeriesFn = (
  source: ChartRevealSource | undefined,
): ChartSeriesRevealFn | undefined => (typeof source === "function" ? undefined : source?.series);

/** One series' build state from either source shape. A bare function has no draw channel, so it reads as fully drawn with no head and the mean of its per-point alphas, which is exactly what the strokes and fills did before the sampler existed. */
export function chartSeriesReveal(
  source: ChartRevealSource | undefined,
  seriesIndex: number,
  categoryCount: number,
): ChartSeriesReveal {
  if (!source) return CHART_FULL_SERIES_REVEAL;
  if (typeof source === "function") {
    return { draw: 1, headX: -1, alpha: meanAlpha(source, seriesIndex, categoryCount) };
  }
  return seriesRevealAt(source.series, seriesIndex);
}
