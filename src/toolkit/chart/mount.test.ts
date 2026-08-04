import { describe, expect, it } from "vitest";
import { computeFormat, FORMATS } from "../../engine/format";
import { type ResolvedChart, resolveChart } from "../../engine/sceneChart";
import type { SceneDoc, SceneDocChart } from "../../engine/sceneDocSchema";
import { builtinThemes } from "../../theme/registry";
import { chart2dInsets } from "./chart2dMath";
import { computeChartLayout } from "./layout";
import {
  CHART_STAGED_SIZE,
  chartColours,
  chartGroundY,
  chartLayoutAt,
  chartPose,
  chartSafeRect,
  chartScaleBounds,
  fitChart2d,
  fitChart3d,
} from "./mount";
import type { ChartLayout } from "./types";

const theme = builtinThemes["kookaburra-default"];

const resolve = (chart: SceneDocChart): ResolvedChart => {
  const out = resolveChart({ chart } as SceneDoc);
  if (!out) throw new Error("chart did not resolve");
  return out;
};

const columns = (): ResolvedChart =>
  resolve({
    type: "column",
    data: {
      categories: ["Q1", "Q2", "Q3"],
      series: [
        { id: "a", name: "Revenue", values: [10, 20, 30] },
        { id: "b", name: "Costs", values: [5, 8, 12] },
      ],
    },
  });

const keyframed = (): ResolvedChart =>
  resolve({
    type: "column",
    data: {
      categories: ["Q1", "Q2"],
      series: [{ id: "a", name: "Revenue", values: [10, 20] }],
    },
    track: {
      keys: [
        { id: "k1", tMs: 0, pose: { values: [[10, 20]] } },
        { id: "k2", tMs: 1000, pose: { values: [[90, 40]] } },
      ],
      segments: [{ from: "k1", to: "k2", ease: "linear" }],
    },
  });

const layoutOf = (chart: ResolvedChart): ChartLayout => chartLayoutAt(chart, 0, null);

describe("chartSafeRect", () => {
  it("is the frame minus its safe insets, centred", () => {
    const format = computeFormat(FORMATS["16:9"]);
    const rect = chartSafeRect(format);
    expect(rect.width).toBeCloseTo(format.frame.width - format.safe.left - format.safe.right, 10);
    expect(rect.height).toBeCloseTo(format.frame.height - format.safe.top - format.safe.bottom, 10);
    expect(rect.x).toBeCloseTo(0, 10);
    expect(rect.y).toBeCloseTo(0, 10);
  });

  it("offsets its centre by an asymmetric inset", () => {
    const format = computeFormat(FORMATS["1:1"]);
    const rect = chartSafeRect({ ...format, safe: { top: 0, right: 0, bottom: 0, left: 1 } });
    expect(rect.width).toBeCloseTo(format.frame.width - 1, 10);
    expect(rect.x).toBeCloseTo(0.5, 10);
  });
});

describe("chartColours", () => {
  it("takes one colour per series, an authored override winning", () => {
    const chart = columns();
    chart.data.series[1].colour = "#ff0000";
    const colours = chartColours(chart, theme);
    expect(colours).toHaveLength(2);
    expect(colours[1]).toBe("#ff0000");
    expect(colours[0]).not.toBe(colours[1]);
  });

  it("keys on CATEGORY for pie", () => {
    const chart = resolve({
      type: "pie",
      data: {
        categories: ["a", "b", "c", "d"],
        series: [{ id: "s", name: "Share", values: [1, 2, 3, 4] }],
      },
    });
    expect(chartColours(chart, theme)).toHaveLength(4);
  });
});

describe("chartScaleBounds", () => {
  it("is null for a static chart, which keeps its natural ticks", () => {
    expect(chartScaleBounds(columns())).toBeNull();
  });

  it("covers the whole track, so a morph never clips a mark", () => {
    const chart = keyframed();
    const bounds = chartScaleBounds(chart);
    expect(bounds).not.toBeNull();
    if (!bounds) return;
    expect(bounds.max).toBeGreaterThanOrEqual(90);
    for (const tMs of [0, 250, 500, 1000, 2000]) {
      for (const mark of chartLayoutAt(chart, tMs, bounds).bars) {
        expect(mark.y + mark.height).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("holds the value axis still across a morph", () => {
    const chart = keyframed();
    const bounds = chartScaleBounds(chart);
    const ticks = (tMs: number) =>
      chartLayoutAt(chart, tMs, bounds).value.ticks.map((t) => t.value);
    expect(ticks(500)).toEqual(ticks(0));
    expect(ticks(1000)).toEqual(ticks(0));
  });

  it("samples the eased data between keys", () => {
    const chart = keyframed();
    const bounds = chartScaleBounds(chart);
    const first = (tMs: number) => chartLayoutAt(chart, tMs, bounds).bars[0].value;
    expect(first(0)).toBeCloseTo(10, 10);
    expect(first(500)).toBeCloseTo(50, 10);
    expect(first(1000)).toBeCloseTo(90, 10);
  });
});

describe("fitChart2d", () => {
  const available = { x: 0, y: 0, width: 7.3, height: 4.1 };

  it("leaves the plot inside the available rect, with room for the furniture", () => {
    const chart = columns();
    const layout = layoutOf(chart);
    const fit = fitChart2d(chart, layout, available);
    expect(fit.size.width).toBeGreaterThan(0);
    expect(fit.size.width).toBeLessThan(available.width);
    expect(fit.size.height).toBeLessThan(available.height);
    const insets = chart2dInsets(chart, layout, fit.size);
    expect(fit.size.width + insets.left + insets.right).toBeLessThanOrEqual(available.width + 1e-9);
    expect(fit.size.height + insets.top + insets.bottom).toBeLessThanOrEqual(
      available.height + 1e-9,
    );
  });

  it("pushes the plot centre away from the reserved side", () => {
    const chart = columns();
    const fit = fitChart2d(chart, layoutOf(chart), available);
    // Ticks and the bottom legend reserve the left and bottom, so the plot sits right of and above centre.
    expect(fit.centre[0]).toBeGreaterThan(0);
    expect(fit.centre[1]).toBeGreaterThan(0);
  });

  it("keeps every edge of the plot inside the available rect", () => {
    const chart = columns();
    const fit = fitChart2d(chart, layoutOf(chart), available);
    expect(fit.centre[0] - fit.size.width / 2).toBeGreaterThanOrEqual(-available.width / 2 - 1e-9);
    expect(fit.centre[0] + fit.size.width / 2).toBeLessThanOrEqual(available.width / 2 + 1e-9);
    expect(fit.centre[1] - fit.size.height / 2).toBeGreaterThanOrEqual(
      -available.height / 2 - 1e-9,
    );
    expect(fit.centre[1] + fit.size.height / 2).toBeLessThanOrEqual(available.height / 2 + 1e-9);
  });

  it("is a pure function of its inputs", () => {
    const chart = columns();
    const layout = layoutOf(chart);
    expect(fitChart2d(chart, layout, available)).toEqual(fitChart2d(chart, layout, available));
  });

  it("survives a degenerate rect", () => {
    const chart = columns();
    const fit = fitChart2d(chart, layoutOf(chart), { x: 0, y: 0, width: 0, height: 0 });
    expect(Number.isFinite(fit.size.width)).toBe(true);
    expect(fit.size.width).toBeGreaterThan(0);
  });
});

describe("fitChart3d", () => {
  const available = { x: 0, y: 0, width: 7.3, height: 4.1 };
  const style = columns().style;

  it("scales the tilted footprint back inside the frame", () => {
    const fit = fitChart3d(style, available);
    expect(fit.scale).toBeGreaterThan(0);
    expect(fit.scale).toBeLessThanOrEqual(1);
    const [rx, ry] = fit.rotation;
    const half = [
      (fit.size.width / 2) * fit.scale,
      (fit.size.height / 2) * fit.scale,
      0.2 * fit.scale,
    ];
    const width = Math.abs(Math.cos(ry)) * half[0] + Math.abs(Math.sin(ry)) * half[2];
    const height =
      Math.abs(Math.sin(rx) * Math.sin(ry)) * half[0] +
      Math.abs(Math.cos(rx)) * half[1] +
      Math.abs(Math.sin(rx) * Math.cos(ry)) * half[2];
    expect(2 * width).toBeLessThanOrEqual(available.width + 1e-9);
    expect(2 * height).toBeLessThanOrEqual(available.height + 1e-9);
  });

  it("converts the presentation tilt to radians", () => {
    const fit = fitChart3d({ ...style, rotation: [90, -45] }, available);
    expect(fit.rotation[0]).toBeCloseTo(Math.PI / 2, 10);
    expect(fit.rotation[1]).toBeCloseTo(-Math.PI / 4, 10);
  });

  it("shrinks further as the tilt grows", () => {
    const flat = fitChart3d({ ...style, rotation: [0, 0] }, available);
    const tilted = fitChart3d({ ...style, rotation: [35, -35] }, available);
    expect(tilted.scale).toBeLessThan(flat.scale);
  });
});

describe("chartPose", () => {
  it("defaults to the origin, unrotated and unscaled", () => {
    const pose = chartPose(undefined);
    expect(pose.position).toEqual([0, 0, 0]);
    expect(pose.rotation).toEqual([0, 0, 0]);
    expect(pose.scale).toBe(1);
    expect(pose.ground).toBe(false);
  });

  it("reads degrees and prefers the layout stamp", () => {
    const pose = chartPose({
      position: [1, 2, 3],
      rotationDeg: [0, 180, 0],
      scale: 2,
      resolvedLayout: { position: [9, 9, 9], rotationDeg: [0, 0, 90], scale: 3 },
    });
    expect(pose.position).toEqual([9, 9, 9]);
    expect(pose.rotation[2]).toBeCloseTo(Math.PI / 2, 10);
    expect(pose.scale).toBe(3);
  });
});

describe("chartGroundY", () => {
  const pose = chartPose({ position: [0, 1.5, 0], scale: 2, ground: true });

  it("rests the plot's base on the staged floor", () => {
    expect(chartGroundY(pose, -1)).toBeCloseTo(-1 + CHART_STAGED_SIZE.height, 10);
  });

  it("keeps the authored y with no floor or no grounding", () => {
    expect(chartGroundY(pose, null)).toBe(1.5);
    expect(chartGroundY(chartPose({ position: [0, 1.5, 0] }), -1)).toBe(1.5);
  });
});

describe("degenerate data", () => {
  it("lays out an empty chart without throwing", () => {
    const chart = resolve({ type: "line", data: { categories: [], series: [] } });
    const layout = chartLayoutAt(chart, 0, null);
    expect(layout.series).toEqual([]);
    expect(chartColours(chart, theme)).toEqual([]);
    expect(
      fitChart2d(chart, layout, { x: 0, y: 0, width: 4, height: 3 }).size.width,
    ).toBeGreaterThan(0);
  });

  it("matches a plain layout when nothing is pinned", () => {
    const chart = columns();
    expect(chartLayoutAt(chart, 0, null)).toEqual(computeChartLayout(chart.data, chart));
  });
});
