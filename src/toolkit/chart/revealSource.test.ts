import { describe, expect, it } from "vitest";
import { CHART_FULL_REVEAL, CHART_FULL_SERIES_REVEAL } from "./reveal";
import { chartRevealFn, chartSeriesFn, chartSeriesReveal } from "./revealSource";
import type { ChartReveal, ChartRevealSampler } from "./types";

const at = (_s: number, c: number): ChartReveal => ({
  ...CHART_FULL_REVEAL,
  alpha: c === 0 ? 1 : 0,
});

const sampler: ChartRevealSampler = {
  at,
  series: (s) => ({ draw: 0.5, headX: 0.25, alpha: s === 0 ? 0.4 : 1 }),
};

describe("reveal source", () => {
  it("reads the element lookup out of either shape", () => {
    expect(chartRevealFn(undefined)).toBeUndefined();
    expect(chartRevealFn(at)).toBe(at);
    expect(chartRevealFn(sampler)).toBe(at);
  });

  it("only a sampler carries series channels", () => {
    expect(chartSeriesFn(at)).toBeUndefined();
    expect(chartSeriesFn(sampler)).toBe(sampler.series);
  });

  it("defaults to a fully drawn series", () => {
    expect(chartSeriesReveal(undefined, 0, 4)).toEqual(CHART_FULL_SERIES_REVEAL);
  });

  it("degrades a bare function to the mean of its point alphas", () => {
    expect(chartSeriesReveal(at, 0, 2)).toEqual({ draw: 1, headX: -1, alpha: 0.5 });
  });

  it("takes a sampler's own series channels, clamped", () => {
    expect(chartSeriesReveal(sampler, 0, 4)).toEqual({ draw: 0.5, headX: 0.25, alpha: 0.4 });
    const wild: ChartRevealSampler = {
      at,
      series: () => ({ draw: 2, headX: -3, alpha: -1 }),
    };
    expect(chartSeriesReveal(wild, 0, 4)).toEqual({ draw: 1, headX: -1, alpha: 0 });
  });
});
