import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChartRevealSampler,
  CHART_ANIMATION_PRESET_IDS,
  CHART_ANIMATION_PRESETS,
  CHART_ENTER_FALL,
  type ChartRevealDims,
  chartAnimationEndMs,
  chartPresetFor,
} from "./animation";
import { CHART_GROW_MAX } from "./reveal";
import type { ChartAnimationConfig, ChartReveal, ChartType } from "./types";

const anim = (parts: Partial<ChartAnimationConfig> = {}): ChartAnimationConfig => ({
  preset: "rise",
  delivery: "cascade",
  staggerMs: 60,
  durationMs: 900,
  from: "start",
  ...parts,
});

const dims = (
  seriesCount: number,
  categoryCount: number,
  type: ChartType = "column",
): ChartRevealDims => ({ seriesCount, categoryCount, type });

const at = (a: ChartAnimationConfig, d: ChartRevealDims, ms: number, s: number, c: number) =>
  buildChartRevealSampler(a, d, ms).at(s, c);

const seriesAt = (a: ChartAnimationConfig, d: ChartRevealDims, ms: number, s: number) =>
  buildChartRevealSampler(a, d, ms).series(s);

/** The first whole millisecond at which an element has started building. */
function startMs(a: ChartAnimationConfig, d: ChartRevealDims, s: number, c: number): number {
  for (let ms = 0; ms <= 12000; ms++) {
    if (at(a, d, ms, s, c).count > 0) return ms;
  }
  return -1;
}

/** Every element's start, in category order, for a one-series chart. */
const starts = (a: ChartAnimationConfig, d: ChartRevealDims): number[] =>
  Array.from({ length: d.categoryCount }, (_, c) => startMs(a, d, 0, c));

function sweep(
  a: ChartAnimationConfig,
  d: ChartRevealDims,
  s: number,
  c: number,
  steps = 60,
): ChartReveal[] {
  const end = chartAnimationEndMs(a, d);
  return Array.from({ length: steps + 1 }, (_, i) => at(a, d, (end * i) / steps, s, c));
}

describe("catalogue", () => {
  it("ships every tier, keyed by id, in catalogue order", () => {
    expect(CHART_ANIMATION_PRESET_IDS).toEqual([
      "rise",
      "draw",
      "sweep",
      "fadeUp",
      "wipe",
      "pop",
      "ticker",
      "trace",
      "assemble",
      "bloom",
      "drop",
      "orbitBuild",
      "wave",
      "marketPulse",
      "surge",
      "momentum",
      "ledger",
      "allocation",
      "breakout",
    ]);
    for (const id of CHART_ANIMATION_PRESET_IDS) {
      expect(CHART_ANIMATION_PRESETS[id].id).toBe(id);
      expect(CHART_ANIMATION_PRESETS[id].types.length).toBeGreaterThan(0);
    }
  });

  it("keeps every overshoot inside the house range and the clamp", () => {
    for (const id of CHART_ANIMATION_PRESET_IDS) {
      const { overshoot, squash } = CHART_ANIMATION_PRESETS[id].channels;
      expect(overshoot).toBeLessThanOrEqual(CHART_GROW_MAX - 1);
      if (overshoot > 0) expect(overshoot).toBeGreaterThanOrEqual(0.02);
      expect(squash).toBeLessThanOrEqual(0.03);
    }
  });
});

describe("delivery and stagger", () => {
  const four = dims(2, 4);

  it("delivers `all` on one shared window", () => {
    const a = anim({ delivery: "all" });
    for (const ms of [0, 200, 450, 900]) {
      expect(at(a, four, ms, 1, 3)).toEqual(at(a, four, ms, 0, 0));
    }
  });

  it("delivers `series` one series at a time", () => {
    const a = anim({ delivery: "series" });
    expect(startMs(a, four, 0, 0)).toBe(startMs(a, four, 0, 3));
    expect(startMs(a, four, 1, 0) - startMs(a, four, 0, 0)).toBe(60);
  });

  it("delivers `cascade` category major, series ascending", () => {
    const a = anim({ delivery: "cascade" });
    // Two series per category, so the next category waits two stagger steps.
    expect(startMs(a, four, 1, 0) - startMs(a, four, 0, 0)).toBe(60);
    expect(startMs(a, four, 0, 1) - startMs(a, four, 0, 0)).toBe(120);
  });

  it("orders cascades by `from`", () => {
    const one = dims(1, 5);
    expect(starts(anim({ from: "start" }), one)).toEqual([1, 61, 121, 181, 241]);
    expect(starts(anim({ from: "end" }), one)).toEqual([241, 181, 121, 61, 1]);
    expect(starts(anim({ from: "centre" }), one)).toEqual([181, 61, 1, 121, 241]);
    expect(starts(anim({ from: "edges" }), one)).toEqual([1, 121, 241, 181, 61]);
  });

  it("shuffles on a seeded hash: same inputs, same order, every element once", () => {
    const one = dims(1, 6);
    const first = starts(anim({ from: "shuffle" }), one);
    const second = starts(anim({ from: "shuffle" }), one);
    expect(second).toEqual(first);
    expect([...first].sort((x, y) => x - y)).toEqual([1, 61, 121, 181, 241, 301]);
  });

  it("scales the authored stagger per preset", () => {
    const stacked = dims(1, 4, "stackedColumn");
    // assemble tightens the overlap to 0.6 of the authored stagger.
    expect(startMs(anim({ preset: "assemble" }), stacked, 0, 1)).toBe(37);
    expect(startMs(anim({ preset: "orbitBuild" }), stacked, 0, 1)).toBe(97);
  });

  it("ripples the wave stagger across the category axis", () => {
    const one = dims(1, 5);
    const plain = starts(anim(), one);
    const rippled = starts(anim({ preset: "wave" }), one);
    expect(rippled).not.toEqual(plain);
    for (let c = 0; c < rippled.length; c++) expect(rippled[c]).toBeGreaterThanOrEqual(plain[c]);
  });
});

describe("channels", () => {
  it("clamps the counting channel while ticker overshoots", () => {
    const a = anim({ preset: "ticker", delivery: "all" });
    const d = dims(1, 3);
    let peak = 0;
    for (let ms = 0; ms <= 900; ms += 5) {
      const r = at(a, d, ms, 0, 0);
      peak = Math.max(peak, r.grow);
      expect(r.count).toBeLessThanOrEqual(1);
      if (r.grow > 1) expect(r.count).toBe(1);
    }
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThanOrEqual(CHART_GROW_MAX);
    expect(at(a, d, 900, 0, 0).grow).toBe(1);
    expect(at(a, d, 900, 0, 0).count).toBe(1);
  });

  it("lands drop with a squash that never digs past 3 percent", () => {
    const a = anim({ preset: "drop", delivery: "all" });
    const d = dims(1, 3);
    let min = 1;
    for (let ms = 0; ms <= 900; ms += 2) {
      const { grow } = at(a, d, ms, 0, 0);
      expect(grow).toBeLessThanOrEqual(1);
      expect(grow).toBeGreaterThanOrEqual(0.97);
      min = Math.min(min, grow);
    }
    expect(min).toBeLessThan(1);
    expect(at(a, d, 900, 0, 0).grow).toBe(1);
    // The fall lands at three quarters of the window, then the tail squashes and releases.
    expect(at(a, d, 675, 0, 0).count).toBe(1);
  });

  it("draws a series on monotonically, left to right", () => {
    const a = anim({ preset: "draw", delivery: "all" });
    const d = dims(1, 5, "area");
    let last = -1;
    for (let ms = 0; ms <= 900; ms += 10) {
      const { draw } = seriesAt(a, d, ms, 0);
      expect(draw).toBeGreaterThanOrEqual(last);
      last = draw;
    }
    expect(seriesAt(a, d, 0, 0).draw).toBe(0);
    expect(seriesAt(a, d, 900, 0).draw).toBe(1);
    // The fill and its labels come up only once the line has finished.
    expect(at(a, d, 600, 0, 4).alpha).toBe(0);
    expect(at(a, d, 900, 0, 4).alpha).toBe(1);
  });

  it("tracks the glow head against draw, and parks it when nothing is drawing", () => {
    const a = anim({ preset: "trace", delivery: "all" });
    const d = dims(1, 4, "line");
    expect(seriesAt(a, d, 0, 0).headX).toBe(-1);
    expect(seriesAt(a, d, 900, 0).headX).toBe(-1);
    let last = -1;
    for (let ms = 10; ms < 900; ms += 10) {
      const { draw, headX } = seriesAt(a, d, ms, 0);
      if (headX < 0) continue;
      expect(headX).toBeCloseTo((0.5 + draw * 3) / 4, 10);
      expect(headX).toBeGreaterThan(last);
      last = headX;
    }
    // No draw channel means no head at all.
    expect(seriesAt(anim(), dims(1, 4), 400, 0).headX).toBe(-1);
  });

  it("surges the points up in category order once the flat line is drawn", () => {
    const a = anim({ preset: "surge", delivery: "all" });
    const d = dims(1, 4, "area");
    // Phase one: drawn flat on the baseline.
    expect(at(a, d, 300, 0, 0).grow).toBe(0);
    expect(seriesAt(a, d, 405, 0).draw).toBe(1);
    const mid = buildChartRevealSampler(a, d, 700);
    expect(mid.at(0, 0).grow).toBeGreaterThan(mid.at(0, 3).grow);
    expect(at(a, d, 900, 0, 3).grow).toBe(1);
  });

  it("counts the last market-pulse label with the whole draw", () => {
    const a = anim({ preset: "marketPulse", delivery: "all" });
    const d = dims(1, 4, "line");
    for (const ms of [120, 400, 700, 900]) {
      expect(at(a, d, ms, 0, 3).count).toBe(seriesAt(a, d, ms, 0).draw);
    }
  });

  it("sweeps a shine band to 1 for every element by the end of the build", () => {
    const a = anim({ preset: "momentum" });
    const d = dims(2, 4);
    const end = chartAnimationEndMs(a, d);
    expect(at(a, d, 0, 0, 0).shine).toBe(-1);
    for (let s = 0; s < 2; s++) {
      for (let c = 0; c < 4; c++) expect(at(a, d, end, s, c).shine).toBe(1);
    }
    // A preset without a shine never lights one.
    expect(at(anim(), d, 400, 0, 0).shine).toBe(-1);
  });

  it("settles every pulse envelope back to 0, in legend order for allocation", () => {
    const a = anim({ preset: "allocation", delivery: "all" });
    const d = dims(1, 4, "pie");
    const end = chartAnimationEndMs(a, d);
    const peaks = [0, 1, 2, 3].map((c) => {
      let peakMs = 0;
      let peak = 0;
      for (let ms = 0; ms <= end; ms += 5) {
        const { pulse } = at(a, d, ms, 0, c);
        if (pulse > peak) {
          peak = pulse;
          peakMs = ms;
        }
      }
      expect(peak).toBeGreaterThan(0.99);
      expect(at(a, d, end, 0, c).pulse).toBe(0);
      return peakMs;
    });
    expect(peaks[0]).toBeLessThan(peaks[1]);
    expect(peaks[1]).toBeLessThan(peaks[2]);
    expect(peaks[2]).toBeLessThan(peaks[3]);
  });

  it("holds breakout's final category back and keeps everything else additive", () => {
    const a = anim({ preset: "breakout", delivery: "all" });
    const d = dims(1, 4);
    expect(startMs(a, d, 0, 3)).toBeGreaterThan(startMs(a, d, 0, 0) + 250);
    // Nothing dims: the elements that built normally stay opaque through the breakout beat.
    const end = chartAnimationEndMs(a, d);
    for (let c = 0; c < 3; c++) {
      expect(at(a, d, end, 0, c).alpha).toBe(1);
      expect(at(a, d, end, 0, c).shine).toBe(-1);
    }
    expect(at(a, d, end, 0, 3).shine).toBe(1);
  });
});

describe("applicability", () => {
  it("degrades to the family's core default", () => {
    expect(chartPresetFor("column", "draw").id).toBe("rise");
    expect(chartPresetFor("pie", "ticker").id).toBe("sweep");
    expect(chartPresetFor("line", "ticker").id).toBe("draw");
    expect(chartPresetFor("column", "ledger").id).toBe("rise");
    expect(chartPresetFor("area", "allocation").id).toBe("draw");
    expect(chartPresetFor("stackedArea", "ledger").id).toBe("ledger");
    expect(chartPresetFor("stackedColumn", "rise").id).toBe("rise");
    expect(chartPresetFor("pie", "fadeUp").id).toBe("fadeUp");
  });

  it("resolves every preset on every type to something that covers the type", () => {
    const types: ChartType[] = [
      "column",
      "bar",
      "stackedColumn",
      "stackedBar",
      "line",
      "area",
      "stackedArea",
      "pie",
    ];
    for (const id of CHART_ANIMATION_PRESET_IDS) {
      for (const type of types) {
        expect(chartPresetFor(type, id).types).toContain(type);
      }
    }
  });

  it("degrades an unknown id to rise, then per family, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(chartPresetFor("column", "nope").id).toBe("rise");
    expect(chartPresetFor("pie", "nope").id).toBe("sweep");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe("the fall entrance", () => {
  const d = dims(2, 4, "stackedColumn");

  it("drops the elements of a fall preset in and settles them at zero", () => {
    for (const preset of ["assemble", "drop"]) {
      const a = anim({ preset });
      expect(chartPresetFor(d.type, preset).channels.enter).toBe("fall");
      expect(at(a, d, 0, 0, 0).drop).toBeCloseTo(CHART_ENTER_FALL, 10);
      expect(at(a, d, chartAnimationEndMs(a, d), 0, 0).drop).toBe(0);
    }
  });

  it("falls monotonically home, never past the plot, and tracks (1 - count)", () => {
    const a = anim({ preset: "assemble", delivery: "cascade" });
    const path = sweep(a, d, 1, 2);
    for (const r of path) {
      expect(r.drop).toBeGreaterThanOrEqual(0);
      expect(r.drop).toBeLessThanOrEqual(CHART_ENTER_FALL);
      expect(r.drop).toBeCloseTo((1 - r.count) * CHART_ENTER_FALL, 10);
    }
    for (let i = 1; i < path.length; i++) {
      expect(path[i].drop).toBeLessThanOrEqual(path[i - 1].drop + 1e-12);
    }
  });

  it("leaves every other preset undisplaced", () => {
    for (const id of CHART_ANIMATION_PRESET_IDS) {
      const preset = CHART_ANIMATION_PRESETS[id];
      if (preset.channels.enter === "fall") continue;
      const a = anim({ preset: id });
      for (const type of ["column", "line", "pie"] as ChartType[]) {
        const shape = dims(2, 4, type);
        if (chartPresetFor(type, id).channels.enter === "fall") continue;
        for (const r of sweep(a, shape, 0, 1)) expect(r.drop).toBe(0);
      }
    }
  });
});

describe("edges", () => {
  it("snaps a zero-duration build at each element's delay", () => {
    const a = anim({ durationMs: 0, delivery: "all" });
    const d = dims(1, 3);
    expect(at(a, d, 0, 0, 0)).toEqual({
      grow: 1,
      alpha: 1,
      count: 1,
      pulse: 0,
      shine: -1,
      drop: 0,
    });
    const cascade = anim({ durationMs: 0 });
    expect(at(cascade, d, 59, 0, 1).count).toBe(0);
    expect(at(cascade, d, 60, 0, 1).count).toBe(1);
  });

  it("survives a chart with no elements", () => {
    const d = dims(0, 0);
    for (const id of CHART_ANIMATION_PRESET_IDS) {
      const a = anim({ preset: id });
      const sampler = buildChartRevealSampler(a, d, 300);
      const element = sampler.at(0, 0);
      expect(Number.isFinite(element.grow)).toBe(true);
      expect(Number.isFinite(element.count)).toBe(true);
      expect(sampler.series(0).alpha).toBeGreaterThanOrEqual(0);
      expect(chartAnimationEndMs(a, d)).toBeGreaterThan(0);
    }
  });

  it("is a pure function of its inputs", () => {
    const a = anim({ preset: "ticker", from: "shuffle" });
    const d = dims(2, 5);
    for (let ms = 0; ms <= 1800; ms += 90) {
      expect(buildChartRevealSampler(a, d, ms).at(1, 3)).toEqual(
        buildChartRevealSampler(a, d, ms).at(1, 3),
      );
    }
  });

  it("lands every preset settled, in range and never dimming", () => {
    for (const id of CHART_ANIMATION_PRESET_IDS) {
      const preset = CHART_ANIMATION_PRESETS[id];
      const type = preset.types[0];
      const a = anim({ preset: id });
      const d = dims(2, 4, type);
      const frames = sweep(a, d, 1, 2, 80);
      let lastAlpha = 0;
      let lastCount = 0;
      for (const frame of frames) {
        expect(frame.grow).toBeGreaterThanOrEqual(0);
        expect(frame.grow).toBeLessThanOrEqual(CHART_GROW_MAX);
        expect(frame.alpha).toBeGreaterThanOrEqual(lastAlpha - 1e-9);
        expect(frame.count).toBeGreaterThanOrEqual(lastCount - 1e-9);
        expect(frame.count).toBeLessThanOrEqual(1);
        expect(frame.pulse).toBeGreaterThanOrEqual(0);
        expect(frame.pulse).toBeLessThanOrEqual(1);
        lastAlpha = frame.alpha;
        lastCount = frame.count;
      }
      const settled = frames[frames.length - 1];
      expect(settled.grow).toBeCloseTo(1, 10);
      expect(settled.alpha).toBe(1);
      expect(settled.count).toBe(1);
      expect(settled.pulse).toBe(0);
      expect(buildChartRevealSampler(a, d, chartAnimationEndMs(a, d)).series(1).draw).toBe(1);
    }
  });
});
