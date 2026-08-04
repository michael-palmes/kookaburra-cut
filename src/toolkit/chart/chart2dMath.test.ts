import { describe, expect, it } from "vitest";
import {
  areaShape,
  barSpan,
  CHART_2D_APPEARANCE,
  chart2dBands,
  chart2dInsets,
  chart2dMetrics,
  contrastPick,
  dashSegments,
  gridlineRects,
  markCornerRadius,
  packLegendRows,
  pieSliceShape,
  plotToWorldX,
  plotToWorldY,
  pointsKey,
  polylinePositions,
  rectsGeometry,
  revealedPoints,
} from "./chart2dMath";
import { computeChartLayout } from "./layout";
import { CHART_FULL_REVEAL, meanAlpha, revealAt } from "./reveal";
import type {
  ChartBarMark,
  ChartConfig,
  ChartData,
  ChartLayout,
  ChartLayoutConfig,
  ChartType,
} from "./types";

const size = { width: 4, height: 2 };

const data = (categories: string[], ...rows: number[][]): ChartData => ({
  categories,
  series: rows.map((values, i) => ({ id: `s${i + 1}`, name: `Series ${i + 1}`, values })),
});

const layoutOf = (
  type: ChartType,
  values: ChartData,
  parts: Omit<ChartLayoutConfig, "type"> = {},
): ChartLayout => computeChartLayout(values, { type, ...parts });

/** A chart block with only the fields the 2D furniture maths reads. */
const chartOf = (values: ChartData, parts: Partial<ChartConfig> = {}): ChartConfig =>
  ({
    type: "column",
    dimension: "2d",
    mount: "hero",
    data: values,
    style: {
      preset: "boardroom",
      depth: 0.5,
      gap: 1,
      cornerRadius: 0.25,
      rotation: [0, 0],
      innerRadius: 0,
    },
    axis: {
      value: {
        name: null,
        min: null,
        max: null,
        steps: 4,
        format: { decimals: null, separator: true, prefix: "", suffix: "", compact: false },
        gridlines: { visible: true, style: "hair" },
        labels: true,
      },
      category: { name: null, labels: true },
    },
    labels: {
      legend: { visible: false, position: "bottom" },
      values: {
        visible: true,
        location: "above",
        format: { decimals: 0, separator: true, prefix: "", suffix: "", compact: false },
        countUp: true,
      },
    },
    animation: {
      preset: "rise",
      delivery: "cascade",
      staggerMs: 60,
      durationMs: 900,
      from: "start",
    },
    ...parts,
  }) as ChartConfig;

describe("plot space", () => {
  it("centres the plot rect on the group origin", () => {
    expect(plotToWorldX(size, 0)).toBe(-2);
    expect(plotToWorldX(size, 1)).toBe(2);
    expect(plotToWorldY(size, 0.5)).toBe(0);
  });
});

describe("barSpan", () => {
  const mark = (parts: Partial<ChartBarMark>): ChartBarMark => ({
    seriesIndex: 0,
    categoryIndex: 0,
    x: 0,
    y: 0,
    width: 0.1,
    height: 0.6,
    value: 6,
    base: 0,
    stackBase: 0,
    labelAnchor: { x: 0, y: 0 },
    ...parts,
  });

  it("grows a positive column out of its base", () => {
    const bar = mark({ y: 0, height: 0.6, base: 0 });
    expect(barSpan(bar, "y", 1)).toMatchObject({ lo: 0, size: 0.6, end: 0.6, direction: 1 });
    expect(barSpan(bar, "y", 0.5)).toMatchObject({ lo: 0, size: 0.3, end: 0.3 });
    expect(barSpan(bar, "y", 0)).toMatchObject({ lo: 0, size: 0, end: 0 });
  });

  it("falls out of the base for a negative column", () => {
    const bar = mark({ y: 0.2, height: 0.4, base: 0.6 });
    const full = barSpan(bar, "y", 1);
    expect(full.lo).toBeCloseTo(0.2, 10);
    expect(full.size).toBeCloseTo(0.4, 10);
    expect(full.direction).toBe(-1);
    const half = barSpan(bar, "y", 0.5);
    expect(half.lo).toBeCloseTo(0.4, 10);
    expect(half.size).toBeCloseTo(0.2, 10);
  });

  it("reads width when the value axis is x", () => {
    const bar = mark({ x: 0, width: 0.5, height: 0.1, base: 0 });
    expect(barSpan(bar, "x", 1)).toMatchObject({ lo: 0, size: 0.5, direction: 1 });
  });

  it("settles a stacked segment on its own span", () => {
    const bar = mark({ y: 0.3, height: 0.2, base: 0.3 });
    expect(barSpan(bar, "y", 1)).toMatchObject({ lo: 0.3, size: 0.2, end: 0.5 });
  });
});

describe("dashSegments", () => {
  it("starts and ends on a dash", () => {
    const runs = dashSegments(10, 1, 0.5);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0][0]).toBe(0);
    const last = runs[runs.length - 1];
    expect(last[0] + last[1]).toBeCloseTo(10, 10);
  });

  it("degenerates to one solid run", () => {
    expect(dashSegments(5, 0, 1)).toEqual([[0, 5]]);
    expect(dashSegments(0.1, 10, 10)).toEqual([[0, 0.1]]);
    expect(dashSegments(0, 1, 1)).toEqual([]);
  });
});

describe("gridlines", () => {
  const layout = layoutOf("column", data(["a", "b"], [1, 2]));

  it("spans the plot width for a vertical chart", () => {
    const metrics = chart2dMetrics(size, CHART_2D_APPEARANCE);
    const rects = gridlineRects(layout.value.gridlines, "y", "hair", size, metrics);
    expect(rects).toHaveLength(layout.value.gridlines.length);
    expect(rects[0].width).toBe(size.width);
    expect(rects[0].height).toBe(metrics.grid);
    expect(rects[0].x).toBe(-size.width / 2);
  });

  it("segments a dashed style and skips lines outside the plot", () => {
    const metrics = chart2dMetrics(size, CHART_2D_APPEARANCE);
    const hair = gridlineRects([0, 0.5, 1], "y", "hair", size, metrics);
    const dashed = gridlineRects([0, 0.5, 1], "y", "dashed", size, metrics);
    expect(dashed.length).toBeGreaterThan(hair.length);
    expect(gridlineRects([-0.2, 1.4], "y", "hair", size, metrics)).toHaveLength(0);
    expect(gridlineRects([0.5], "y", "none", size, metrics)).toHaveLength(0);
  });

  it("builds one indexed quad per rect", () => {
    const geometry = rectsGeometry([{ x: 0, y: 0, width: 1, height: 2 }]);
    expect(geometry.getAttribute("position").count).toBe(4);
    expect(geometry.getIndex()?.count).toBe(6);
    geometry.dispose();
  });
});

describe("corner radius", () => {
  it("takes a fraction of half the thickness and never exceeds the mark", () => {
    expect(markCornerRadius(1, 0.4, 2)).toBeCloseTo(0.2, 10);
    expect(markCornerRadius(0.5, 0.4, 2)).toBeCloseTo(0.1, 10);
    expect(markCornerRadius(1, 0.4, 0.1)).toBeCloseTo(0.05, 10);
    expect(markCornerRadius(-3, 0.4, 2)).toBe(0);
  });
});

describe("line and area geometry", () => {
  const layout = layoutOf("area", data(["a", "b", "c"], [1, 2, 3]));

  it("rides each point from its baseline to its value", () => {
    const series = layout.series[0];
    const zeroed = revealedPoints(series.points, series.baseline, [0, 0, 0]);
    expect(zeroed.map((p) => p.y)).toEqual(series.baseline.map((p) => p.y));
    const full = revealedPoints(series.points, series.baseline, [1, 1, 1]);
    expect(full.map((p) => p.y)).toEqual(series.points.map((p) => p.y));
  });

  it("emits xyz triples for the stroke", () => {
    const xyz = polylinePositions(layout.series[0].points, size, 0.5);
    expect(xyz).toHaveLength(9);
    expect(xyz[2]).toBe(0.5);
  });

  it("closes the fill polygon and refuses a single point", () => {
    const shape = areaShape(layout.series[0].points, layout.series[0].baseline, size);
    expect(shape).not.toBeNull();
    expect(shape?.getPoints(1).length).toBeGreaterThan(5);
    expect(areaShape([{ x: 0, y: 0 }], [{ x: 0, y: 0 }], size)).toBeNull();
  });

  it("keys a point run on its values, not its identity", () => {
    const a = [{ x: 0, y: 0.5 }];
    const b = [{ x: 0, y: 0.5 }];
    expect(pointsKey(a)).toBe(pointsKey(b));
    expect(pointsKey(a)).not.toBe(pointsKey([{ x: 0, y: 0.6 }]));
  });
});

describe("pie wedges", () => {
  it("builds a wedge and a donut segment, and refuses an empty span", () => {
    expect(pieSliceShape(0, Math.PI / 2, 0, 1, 0.01)).not.toBeNull();
    expect(pieSliceShape(0, Math.PI / 2, 0.5, 1, 0.01)).not.toBeNull();
    expect(pieSliceShape(1, 1, 0, 1, 0.01)).toBeNull();
    expect(pieSliceShape(0, 1, 0, 0, 0.01)).toBeNull();
  });

  it("starts a slice at 12 o'clock", () => {
    const shape = pieSliceShape(0, Math.PI / 2, 0, 1, 0);
    const first = shape?.getPoints(4)[0];
    expect(first?.x).toBeCloseTo(0, 6);
    expect(first?.y).toBeCloseTo(1, 6);
  });
});

describe("furniture bands", () => {
  const values = data(["Q1", "Q2"], [10, 20]);

  it("reserves the value axis on the left of a column chart", () => {
    const layout = layoutOf("column", values);
    const insets = chart2dInsets(chartOf(values), layout, size);
    expect(insets.left).toBeGreaterThan(0);
    expect(insets.bottom).toBeGreaterThan(0);
    expect(insets.top).toBe(0);
    expect(insets.right).toBe(0);
  });

  it("swaps the sides for a bar chart", () => {
    const layout = layoutOf("bar", values);
    const bands = chart2dBands(chartOf(values), layout, size);
    const metrics = chart2dMetrics(size, CHART_2D_APPEARANCE);
    expect(bands.tick).toBeCloseTo(metrics.tick * 1.25, 10);
    expect(bands.category).toBeGreaterThan(0);
  });

  it("drops a band the block turned off", () => {
    const layout = layoutOf("column", values, {
      axis: { value: { labels: false }, category: { labels: false } },
    });
    const bands = chart2dBands(chartOf(values), layout, size);
    expect(bands.tick).toBe(0);
    expect(bands.category).toBe(0);
  });

  it("reserves an axis name band only when named", () => {
    const named = layoutOf("column", values, { axis: { value: { name: "Revenue" } } });
    expect(chart2dBands(chartOf(values), named, size).valueName).toBeGreaterThan(0);
    expect(chart2dBands(chartOf(values), layoutOf("column", values), size).valueName).toBe(0);
  });

  it("puts the legend where the block asked", () => {
    const layout = layoutOf("column", values);
    const top = chartOf(values, {
      labels: { legend: { visible: true, position: "top" } } as never,
    });
    const trailing = chartOf(values, {
      labels: { legend: { visible: true, position: "trailing" } } as never,
    });
    expect(chart2dInsets(top, layout, size).top).toBeGreaterThan(0);
    expect(chart2dInsets(trailing, layout, size).right).toBeGreaterThan(0);
  });

  it("pads a pie evenly and reserves no axis bands", () => {
    const layout = layoutOf("pie", values);
    const insets = chart2dInsets(chartOf(values), layout, size);
    expect(insets.left).toBe(insets.right);
    expect(insets.top).toBe(insets.bottom);
    expect(chart2dBands(chartOf(values), layout, size).tick).toBe(0);
  });
});

describe("legend packing", () => {
  it("keeps at least one entry per row", () => {
    const entries = [{ width: 10 }, { width: 10 }, { width: 10 }];
    expect(packLegendRows(entries, 0, 1)).toHaveLength(3);
    expect(packLegendRows(entries, 100, 1)).toHaveLength(1);
    expect(packLegendRows(entries, 21, 1)).toHaveLength(2);
  });
});

describe("contrast", () => {
  it("picks the label that reads on the fill", () => {
    expect(contrastPick("#ffffff", "light", "dark")).toBe("dark");
    expect(contrastPick("#101010", "light", "dark")).toBe("light");
  });
});

describe("reveal", () => {
  it("defaults to the settled state", () => {
    expect(revealAt(undefined, 0, 0)).toEqual(CHART_FULL_REVEAL);
    expect(meanAlpha(undefined, 0, 4)).toBe(1);
  });

  it("clamps a preset overshoot", () => {
    const over = () => ({ grow: 1.4, alpha: -0.2 });
    expect(revealAt(over, 0, 0)).toEqual({ grow: 1, alpha: 0 });
  });

  it("averages a cascade into one stroke alpha", () => {
    const stagger = (_s: number, c: number) => ({ grow: 1, alpha: c === 0 ? 1 : 0 });
    expect(meanAlpha(stagger, 0, 2)).toBe(0.5);
  });
});
