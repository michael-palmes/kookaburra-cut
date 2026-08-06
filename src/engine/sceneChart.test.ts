import { describe, expect, it } from "vitest";
import {
  CHART_ANIMATION_DEFAULTS,
  CHART_AXIS_FORMAT_DEFAULTS,
  CHART_STYLE_DEFAULTS,
  CHART_VALUE_FORMAT_DEFAULTS,
  chartDataWithValues,
  chartValuesAt,
  maxAcrossTrack,
  resolveChart,
} from "./sceneChart";
import type { SceneDoc, SceneDocChart } from "./sceneDocSchema";

const chartDoc = (chart: SceneDocChart): SceneDoc => ({ version: 1, chart });

/** Two series over three categories, the shape most of these tests morph. */
const data = (): SceneDocChart["data"] => ({
  categories: ["April", "May", "June"],
  series: [
    { id: "s1", name: "Region 1", values: [10, 20, 30] },
    { id: "s2", name: "Region 2", values: [5, 15, 25] },
  ],
});

const resolved = (chart: SceneDocChart) => {
  const out = resolveChart(chartDoc(chart));
  if (!out) throw new Error("expected a resolved chart");
  return out;
};

describe("resolveChart", () => {
  it("null for docs without a chart block", () => {
    expect(resolveChart(undefined)).toBeNull();
    expect(resolveChart({ version: 1 })).toBeNull();
  });

  it("bakes every default so renderers never null-check", () => {
    const chart = resolved({ type: "column", data: data() });
    expect(chart.dimension).toBe("2d");
    expect(chart.mount).toBe("hero");
    expect(chart.placement).toBeUndefined();
    expect(chart.style).toEqual(CHART_STYLE_DEFAULTS);
    expect(chart.style.rotation).not.toBe(CHART_STYLE_DEFAULTS.rotation);
    expect(chart.axis.value).toEqual({
      name: null,
      min: null,
      max: null,
      steps: 4,
      format: CHART_AXIS_FORMAT_DEFAULTS,
      gridlines: { visible: true, style: "hair" },
      labels: true,
    });
    expect(chart.axis.category).toEqual({ name: null, labels: true });
    expect(chart.labels.legend).toEqual({ visible: true, position: "bottom" });
    expect(chart.labels.values).toEqual({
      visible: true,
      location: "above",
      format: CHART_VALUE_FORMAT_DEFAULTS,
      countUp: true,
    });
    expect(chart.animation).toEqual(CHART_ANIMATION_DEFAULTS);
    expect(chart.track).toEqual({ keys: [], segments: [] });
  });

  it("keeps authored fields and clamps the ranges layout does not own", () => {
    const chart = resolved({
      type: "pie",
      data: data(),
      style: { preset: "neon-ledger", depth: 4, cornerRadius: -1, gap: 2.5, innerRadius: 0.6 },
      axis: { value: { name: "Revenue", min: 0, max: 120, steps: 6, format: { decimals: 9 } } },
      labels: { values: { visible: false, location: "inside", format: { decimals: -3 } } },
      animation: { preset: "sweep", staggerMs: -40, durationMs: 1200 },
    });
    expect(chart.style.preset).toBe("neon-ledger");
    expect(chart.style.depth).toBe(1);
    expect(chart.style.cornerRadius).toBe(0);
    expect(chart.style.gap).toBe(2.5);
    expect(chart.style.innerRadius).toBe(0.6);
    expect(chart.axis.value.name).toBe("Revenue");
    expect(chart.axis.value.min).toBe(0);
    expect(chart.axis.value.max).toBe(120);
    expect(chart.axis.value.steps).toBe(6);
    expect(chart.axis.value.format.decimals).toBe(4);
    expect(chart.labels.values.visible).toBe(false);
    expect(chart.labels.values.location).toBe("inside");
    expect(chart.labels.values.format.decimals).toBe(0);
    expect(chart.animation.preset).toBe("sweep");
    expect(chart.animation.staggerMs).toBe(0);
    expect(chart.animation.durationMs).toBe(1200);
  });

  it("keeps an explicitly null decimals as auto, and absence as the field default", () => {
    const auto = resolved({
      type: "column",
      data: data(),
      labels: { values: { format: { decimals: null } } },
    });
    expect(auto.labels.values.format.decimals).toBeNull();
    expect(auto.axis.value.format.decimals).toBeNull();
  });

  it("forces 2d on a panel mount and keeps placement for the staged mount only", () => {
    const placement = { position: [0, 0, 0] as [number, number, number], ground: true };
    const panel = resolved({ type: "line", mount: "panel", dimension: "3d", data: data() });
    expect(panel.dimension).toBe("2d");
    const staged = resolved({
      type: "line",
      mount: "staged",
      dimension: "3d",
      placement,
      data: data(),
    });
    expect(staged.dimension).toBe("3d");
    expect(staged.placement).toEqual(placement);
    const hero = resolved({ type: "line", mount: "hero", placement, data: data() });
    expect(hero.placement).toBeUndefined();
  });

  it("normalises data to one rectangular shape, naming series from their id", () => {
    const chart = resolved({
      type: "column",
      data: {
        categories: ["a", "b", "c"],
        series: [
          { id: "s1", values: [1] },
          { id: "s2", name: "Two", values: [1, 2, 3, 4], colour: "#ff0000" },
        ],
        source: "assets/q3.csv",
      },
    });
    expect(chart.data.series[0]).toEqual({ id: "s1", name: "s1", values: [1, 0, 0] });
    expect(chart.data.series[1]).toEqual({
      id: "s2",
      name: "Two",
      values: [1, 2, 3],
      colour: "#ff0000",
    });
    expect(chart.data.source).toBe("assets/q3.csv");
  });

  it("falls back to the longest series when a chart has no categories", () => {
    const chart = resolved({
      type: "column",
      data: { categories: [], series: [{ id: "s1", values: [1, 2, 3] }] },
    });
    expect(chart.data.categories).toEqual(["", "", ""]);
    expect(chart.data.series[0].values).toEqual([1, 2, 3]);
  });

  it("sorts track keys, resolves segments and stretches short poses onto the data", () => {
    const chart = resolved({
      type: "column",
      data: data(),
      track: {
        keys: [
          { id: "k2", tMs: 1000, pose: { values: [[40, 50, 60]] } },
          { id: "k1", tMs: 0, pose: { values: [[10, 20, 30]] } },
        ],
        segments: [
          { from: "k1", to: "k2", ease: "linear" },
          { from: "k1", to: "ghost", ease: "linear" },
        ],
      },
    });
    expect(chart.track.keys.map((k) => k.tMs)).toEqual([0, 1000]);
    // The pose defines series 0 only; series 1 holds its authored values.
    expect(chart.track.keys[1].values).toEqual([
      [40, 50, 60],
      [5, 15, 25],
    ]);
    expect(chart.track.segments).toHaveLength(1);
    expect(chart.track.segments[0]).toEqual({
      fromTMs: 0,
      fromValues: [
        [10, 20, 30],
        [5, 15, 25],
      ],
      toTMs: 1000,
      toValues: [
        [40, 50, 60],
        [5, 15, 25],
      ],
      ease: "linear",
    });
  });
});

describe("chartValuesAt", () => {
  const track = (ease: string): SceneDocChart["track"] => ({
    keys: [
      {
        id: "k1",
        tMs: 200,
        pose: {
          values: [
            [10, 20, 30],
            [5, 15, 25],
          ],
        },
      },
      {
        id: "k2",
        tMs: 1200,
        pose: {
          values: [
            [20, 40, 60],
            [5, 15, 25],
          ],
        },
      },
    ],
    segments: [{ from: "k1", to: "k2", ease }],
  });

  it("returns the static values when there is no track", () => {
    const chart = resolved({ type: "column", data: data() });
    expect(chartValuesAt(chart, 0)).toEqual([
      [10, 20, 30],
      [5, 15, 25],
    ]);
    expect(chartValuesAt(chart, 99999)).toEqual([
      [10, 20, 30],
      [5, 15, 25],
    ]);
  });

  it("lerps elementwise across a linear segment", () => {
    const chart = resolved({ type: "column", data: data(), track: track("linear") });
    expect(chartValuesAt(chart, 700)).toEqual([
      [15, 30, 45],
      [5, 15, 25],
    ]);
  });

  it("applies the segment ease", () => {
    const chart = resolved({ type: "column", data: data(), track: track("outQuad") });
    // outQuad(0.5) = 0.75, so the midpoint sits three quarters of the way.
    expect(chartValuesAt(chart, 700)[0]).toEqual([17.5, 35, 52.5]);
    const jump = resolved({ type: "column", data: data(), track: track("jump") });
    expect(chartValuesAt(jump, 700)[0]).toEqual([10, 20, 30]);
    expect(chartValuesAt(jump, 1200)[0]).toEqual([20, 40, 60]);
  });

  it("clamps before the first key and after the last", () => {
    const chart = resolved({ type: "column", data: data(), track: track("linear") });
    expect(chartValuesAt(chart, 0)[0]).toEqual([10, 20, 30]);
    expect(chartValuesAt(chart, -500)[0]).toEqual([10, 20, 30]);
    expect(chartValuesAt(chart, 1200)[0]).toEqual([20, 40, 60]);
    expect(chartValuesAt(chart, 60000)[0]).toEqual([20, 40, 60]);
  });

  it("holds the latest key between segments, and never hands back the track's own arrays", () => {
    const chart = resolved({
      type: "column",
      data: data(),
      track: {
        keys: [
          { id: "k1", tMs: 0, pose: { values: [[1, 1, 1]] } },
          { id: "k2", tMs: 100, pose: { values: [[2, 2, 2]] } },
          { id: "k3", tMs: 900, pose: { values: [[9, 9, 9]] } },
        ],
        segments: [{ from: "k1", to: "k2", ease: "linear" }],
      },
    });
    expect(chartValuesAt(chart, 400)[0]).toEqual([2, 2, 2]);
    const sample = chartValuesAt(chart, 400);
    sample[0][0] = 999;
    expect(chartValuesAt(chart, 400)[0][0]).toBe(2);
  });
});

describe("maxAcrossTrack", () => {
  it("is the elementwise envelope over the static values and every key", () => {
    const chart = resolved({
      type: "column",
      data: data(),
      track: {
        keys: [
          {
            id: "k1",
            tMs: 0,
            pose: {
              values: [
                [40, 5, 30],
                [5, 15, 25],
              ],
            },
          },
          {
            id: "k2",
            tMs: 900,
            pose: {
              values: [
                [12, 22, 32],
                [50, 15, 25],
              ],
            },
          },
        ],
        segments: [],
      },
    });
    expect(maxAcrossTrack(chart)).toEqual([
      [40, 22, 32],
      [50, 15, 25],
    ]);
  });

  it("is the static matrix for a chart with no track", () => {
    const chart = resolved({ type: "column", data: data() });
    expect(maxAcrossTrack(chart)).toEqual([
      [10, 20, 30],
      [5, 15, 25],
    ]);
  });
});

describe("chartDataWithValues", () => {
  it("substitutes a sampled matrix, leaving names, colours and categories alone", () => {
    const chart = resolved({ type: "column", data: data() });
    const swapped = chartDataWithValues(chart, [
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(swapped.categories).toEqual(["April", "May", "June"]);
    expect(swapped.series).toEqual([
      { id: "s1", name: "Region 1", values: [1, 2, 3] },
      { id: "s2", name: "Region 2", values: [4, 5, 6] },
    ]);
    // A short matrix keeps each unmatched series on its authored values.
    expect(chartDataWithValues(chart, [[7, 8, 9]]).series[1].values).toEqual([5, 15, 25]);
  });
});

describe("hero placement style", () => {
  it("defaults offset and scale and keeps rotation front on", () => {
    const chart = resolveChart(chartDoc({ type: "column", data: data() }));
    expect(chart?.style.rotation).toEqual([0, 0]);
    expect(chart?.style.offset).toEqual([0, 0]);
    expect(chart?.style.scale).toBe(1);
  });
  it("clamps authored offset and scale", () => {
    const chart = resolveChart(
      chartDoc({ type: "column", data: data(), style: { offset: [99, -99], scale: 9 } }),
    );
    expect(chart?.style.offset).toEqual([20, -20]);
    expect(chart?.style.scale).toBe(3);
  });
});
