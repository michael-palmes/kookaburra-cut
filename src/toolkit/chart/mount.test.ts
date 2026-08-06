import { describe, expect, it } from "vitest";
import { computeFormat, FORMATS } from "../../engine/format";
import { type ResolvedChart, resolveChart } from "../../engine/sceneChart";
import type { SceneDoc, SceneDocChart } from "../../engine/sceneDocSchema";
import { builtinThemes } from "../../theme/registry";
import { buildChartRevealSampler, CHART_ENTER_LIFT, type ChartRevealDims } from "./animation";
import { chart3dBelowStack } from "./axes3d";
import { chart2dInsets } from "./chart2dMath";
import { computeChartLayout } from "./layout";
import {
  CHART_3D_PLOT_HEIGHT,
  CHART_STAGED_SIZE,
  chartColours,
  chartEnterOffset,
  chartGroundY,
  chartHeroPose,
  chartHeroRect,
  chartLayoutAt,
  chartPose,
  chartSafeRect,
  chartScaleBounds,
  chartSettleMs,
  chartTitleBand,
  chartTitleMetrics,
  fitChart2d,
  fitChart3d,
} from "./mount";
import { CHART_PALETTE_SCHEMES } from "./paletteSchemes";
import { chart3dSpace } from "./space3d";
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

  it("paints a named scheme where the block asks for one, series overrides aside", () => {
    const chart = columns();
    chart.palette = "reef";
    expect(chartColours(chart, theme)).toEqual([
      CHART_PALETTE_SCHEMES.reef.swatches[0],
      CHART_PALETTE_SCHEMES.reef.swatches[1],
    ]);
    chart.data.series[1].colour = "#ff0000";
    expect(chartColours(chart, theme)[1]).toBe("#ff0000");
  });

  it("keys a scheme on CATEGORY for pie, like the theme palette", () => {
    const chart = resolve({
      type: "pie",
      palette: "harbour",
      data: {
        categories: ["a", "b", "c"],
        series: [{ id: "s", name: "Share", values: [1, 2, 3] }],
      },
    });
    expect(chartColours(chart, theme)).toEqual(CHART_PALETTE_SCHEMES.harbour.swatches.slice(0, 3));
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

describe("chartTitleBand", () => {
  const landscape = computeFormat(FORMATS["16:9"]);
  const portrait = computeFormat(FORMATS["9:16"]);

  it("reserves nothing without a title", () => {
    expect(chartTitleBand("", landscape, theme)).toBe(0);
    expect(chartTitleBand("   ", landscape, theme)).toBe(0);
    expect(chartTitleBand(undefined, landscape, theme)).toBe(0);
    expect(chartTitleBand(null, portrait, theme)).toBe(0);
  });

  it("clears the title the template draws, in both dimensions", () => {
    for (const format of [landscape, portrait]) {
      const band = chartTitleBand("Revenue by quarter", format, theme);
      const metrics = chartTitleMetrics(format);
      const safeTop = format.frame.height / 2 - format.safe.top;
      expect(band).toBeGreaterThan(0);
      expect(safeTop - band).toBeLessThan(metrics.y - metrics.size / 2);
    }
  });

  it("grows with the gap the theme's type scale asks for", () => {
    const tight = { ...theme, typography: { ...theme.typography, scale: 2 } };
    expect(chartTitleBand("Revenue", landscape, tight)).toBeLessThan(
      chartTitleBand("Revenue", landscape, theme),
    );
  });

  it("never goes negative, and never eats the whole frame", () => {
    const crushed = { ...landscape, safe: { top: 2, right: 0, bottom: 0, left: 0 } };
    expect(chartTitleBand("Revenue", crushed, theme)).toBe(0);
    const squat = { ...landscape, safe: { top: 0, right: 0, bottom: 3.4, left: 0 } };
    const safe = chartSafeRect(squat);
    expect(chartTitleBand("Revenue", squat, theme)).toBeLessThan(safe.height / 2);
    expect(chartHeroRect(squat, theme, "Revenue").height).toBeGreaterThan(safe.height / 2);
  });
});

describe("chartHeroRect", () => {
  const landscape = computeFormat(FORMATS["16:9"]);
  const portrait = computeFormat(FORMATS["9:16"]);
  const title = "Revenue by quarter";

  it("is the safe rect untouched without a title", () => {
    expect(chartHeroRect(landscape, theme, "")).toEqual(chartSafeRect(landscape));
    expect(chartHeroRect(portrait, theme, undefined)).toEqual(chartSafeRect(portrait));
  });

  it("takes the band off the TOP only, keeping the width and the bottom edge", () => {
    for (const format of [landscape, portrait]) {
      const safe = chartSafeRect(format);
      const rect = chartHeroRect(format, theme, title);
      const band = chartTitleBand(title, format, theme);
      expect(rect.width).toBeCloseTo(safe.width, 10);
      expect(rect.height).toBeCloseTo(safe.height - band, 10);
      expect(rect.y - rect.height / 2).toBeCloseTo(safe.y - safe.height / 2, 10);
      expect(rect.y + rect.height / 2).toBeCloseTo(safe.y + safe.height / 2 - band, 10);
    }
  });

  it("leaves a portrait frame most of its height", () => {
    const safe = chartSafeRect(portrait);
    expect(chartHeroRect(portrait, theme, title).height).toBeGreaterThan(0.8 * safe.height);
  });

  it("keeps a flat plot clear of the title", () => {
    const chart = columns();
    const layout = layoutOf(chart);
    for (const format of [landscape, portrait]) {
      const rect = chartHeroRect(format, theme, title);
      const fit = fitChart2d(chart, layout, rect);
      const metrics = chartTitleMetrics(format);
      expect(fit.centre[1] + fit.size.height / 2).toBeLessThan(metrics.y - metrics.size / 2);
    }
  });

  it("keeps a tilted 3D plot clear of the title", () => {
    const chart = columns();
    for (const format of [landscape, portrait]) {
      const rect = chartHeroRect(format, theme, title);
      const fit = fitChart3d(chart.style, rect);
      const metrics = chartTitleMetrics(format);
      expect(fit.size.height).toBeCloseTo(rect.height * CHART_3D_PLOT_HEIGHT, 10);
      expect(rect.y + (fit.size.height / 2) * fit.scale).toBeLessThan(metrics.y - metrics.size / 2);
    }
  });
});

describe("chartSettleMs", () => {
  const dims = (chart: ResolvedChart): ChartRevealDims => ({
    seriesCount: chart.data.series.length,
    categoryCount: chart.data.categories.length,
    type: chart.type,
  });

  it("lands after the last element's window", () => {
    const chart = columns();
    // rise, cascade, 60ms stagger over 6 elements, 900ms windows.
    expect(chartSettleMs(chart, dims(chart))).toBeCloseTo(1200, 10);
  });

  it("never settles while a data track can still move the marks", () => {
    const chart = keyframed();
    expect(chartSettleMs(chart, dims(chart))).toBe(Number.POSITIVE_INFINITY);
  });

  it("hands over to the full-reveal default with nothing left to say", () => {
    const chart = columns();
    const d = dims(chart);
    const sampler = buildChartRevealSampler(chart.animation, d, chartSettleMs(chart, d));
    for (let s = 0; s < d.seriesCount; s++) {
      for (let c = 0; c < d.categoryCount; c++) {
        const at = sampler.at(s, c);
        expect(at.grow).toBeCloseTo(1, 10);
        expect(at.alpha).toBeCloseTo(1, 10);
        // The label prints value * count, so the settle must hand over on exactly the true value.
        expect(at.count).toBe(1);
        expect(at.pulse).toBe(0);
      }
      expect(sampler.series(s).draw).toBe(1);
    }
  });
});

describe("chartEnterOffset", () => {
  const dims: ChartRevealDims = { seriesCount: 2, categoryCount: 3, type: "column" };
  const lifted = (): ResolvedChart =>
    resolve({
      type: "column",
      data: {
        categories: ["Q1", "Q2", "Q3"],
        series: [
          { id: "a", name: "Revenue", values: [10, 20, 30] },
          { id: "b", name: "Costs", values: [5, 8, 12] },
        ],
      },
      animation: { preset: "fadeUp", delivery: "all" },
    });

  it("is nothing once the build has settled", () => {
    expect(chartEnterOffset(lifted(), dims, null)).toBe(0);
  });

  it("starts a lifting preset a fraction of the plot low and rises to nothing", () => {
    const chart = lifted();
    const at = (localMs: number) =>
      chartEnterOffset(chart, dims, buildChartRevealSampler(chart.animation, dims, localMs));
    expect(at(0)).toBeCloseTo(-CHART_ENTER_LIFT, 10);
    expect(at(450)).toBeGreaterThan(-CHART_ENTER_LIFT);
    expect(at(450)).toBeLessThan(0);
    expect(at(900)).toBeCloseTo(0, 10);
  });

  it("leaves every other preset alone", () => {
    const chart = columns();
    const sampler = buildChartRevealSampler(chart.animation, dims, 0);
    expect(chartEnterOffset(chart, dims, sampler)).toBe(0);
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

describe("chartHeroPose", () => {
  const rect = { x: 0, y: 0, width: 5.9, height: 2.9 };
  const chart = resolveChart({
    version: 1,
    chart: {
      type: "column",
      dimension: "3d",
      data: {
        categories: ["a", "b", "c"],
        series: [{ id: "s1", values: [1, 2, 3] }],
      },
    },
  } as SceneDoc);
  if (!chart) throw new Error("chart resolves");
  const layout = chartLayoutAt(chart, 0, null);
  const space = chart3dSpace(chart.style.depth, rect.width, rect.height);
  const stack = chart3dBelowStack(chart, layout, space);
  const fit = fitChart3d(chart.style, rect, { below: stack.depth, top: stack.top });
  it("centres the full content block in the rect", () => {
    const pose = chartHeroPose(fit, 1, rect);
    const top = pose.y + (fit.plotHalfHeight + fit.top) * pose.scale;
    const bottom = pose.y - (fit.plotHalfHeight + fit.below) * pose.scale;
    expect((top + bottom) / 2).toBeCloseTo(rect.y, 6);
    expect(bottom).toBeGreaterThanOrEqual(rect.y - rect.height / 2 - 1e-6);
  });
});
