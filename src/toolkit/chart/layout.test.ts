import { describe, expect, it } from "vitest";
import { CHART_SERIES_GAP, chartTrimRuns, computeChartLayout } from "./layout";
import type { ChartData, ChartLayoutConfig, ChartSeriesLayout, ChartType } from "./types";

const data = (categories: string[], ...rows: number[][]): ChartData => ({
  categories,
  series: rows.map((values, i) => ({ id: `s${i + 1}`, name: `Series ${i + 1}`, values })),
});

const config = (
  type: ChartType,
  parts: Omit<ChartLayoutConfig, "type"> = {},
): ChartLayoutConfig => ({
  type,
  ...parts,
});

const quarters = ["Q1", "Q2", "Q3", "Q4"];

describe("value axis", () => {
  it("auto-nices the domain and lands on round ticks", () => {
    const { value } = computeChartLayout(data(quarters, [17, 26, 53, 96]), config("column"));
    expect(value.min).toBe(0);
    expect(value.max).toBe(100);
    expect(value.ticks.map((t) => t.value)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(value.ticks[0].position).toBe(0);
    expect(value.ticks[5].position).toBe(1);
    expect(value.zero).toBe(0);
  });

  it("manual min and max divide into exactly `steps` intervals", () => {
    const { value } = computeChartLayout(
      data(quarters, [17, 26, 53, 96]),
      config("column", { axis: { value: { min: 0, max: 120, steps: 3 } } }),
    );
    expect(value.max).toBe(120);
    expect(value.ticks.map((t) => t.value)).toEqual([0, 40, 80, 120]);
    expect(value.ticks.map((t) => t.position)).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it("a manual bound survives the nice pass on the other end", () => {
    const { value } = computeChartLayout(
      data(quarters, [17, 26, 53, 96]),
      config("column", { axis: { value: { min: 10 } } }),
    );
    expect(value.min).toBe(10);
    expect(value.max).toBe(100);
  });

  it("steps drives tick density in auto mode", () => {
    const dense = computeChartLayout(
      data(quarters, [17, 26, 53, 96]),
      config("column", { axis: { value: { steps: 10 } } }),
    );
    expect(dense.value.ticks.length).toBeGreaterThan(6);
  });

  it("gridlines follow the ticks and drop when switched off or styled none", () => {
    const on = computeChartLayout(data(quarters, [1, 2, 3, 4]), config("column"));
    expect(on.value.gridlines).toEqual(on.value.ticks.map((t) => t.position));
    expect(on.value.gridlineStyle).toBe("hair");
    const off = computeChartLayout(
      data(quarters, [1, 2, 3, 4]),
      config("column", { axis: { value: { gridlines: { visible: false, style: "hair" } } } }),
    );
    expect(off.value.gridlines).toEqual([]);
    const none = computeChartLayout(
      data(quarters, [1, 2, 3, 4]),
      config("column", { axis: { value: { gridlines: { visible: true, style: "none" } } } }),
    );
    expect(none.value.gridlines).toEqual([]);
  });

  it("passes axis names and label flags through", () => {
    const layout = computeChartLayout(
      data(quarters, [1, 2, 3, 4]),
      config("column", {
        axis: { value: { name: "Revenue", labels: false }, category: { name: "Quarter" } },
      }),
    );
    expect(layout.value.name).toBe("Revenue");
    expect(layout.value.labels).toBe(false);
    expect(layout.category.name).toBe("Quarter");
    expect(layout.category.labels).toBe(true);
  });
});

describe("category bands", () => {
  it("splits the plot evenly and centres each band", () => {
    const { category, bandWidth } = computeChartLayout(
      data(quarters, [1, 2, 3, 4]),
      config("column"),
    );
    expect(bandWidth).toBe(0.25);
    expect(category.bands.map((b) => b.centre)).toEqual([0.125, 0.375, 0.625, 0.875]);
    expect(category.bands[0].start).toBe(0);
    expect(category.bands[3].end).toBe(1);
    expect(category.bands.map((b) => b.label)).toEqual(quarters);
  });

  it("a single category owns the whole band", () => {
    const { category, bandWidth } = computeChartLayout(data(["only"], [7]), config("column"));
    expect(bandWidth).toBe(1);
    expect(category.bands).toHaveLength(1);
    expect(category.bands[0].centre).toBe(0.5);
  });
});

describe("gap maths", () => {
  it("gap is measured in bar widths between category groups", () => {
    const { barWidth, bars, category } = computeChartLayout(
      data(["a", "b", "c"], [1, 2, 3]),
      config("column", { style: { gap: 1 } }),
    );
    expect(barWidth).toBeCloseTo(1 / 6);
    // One bar, gap 1: half the band is bar, half is gap, and the bar sits centred.
    expect(bars[0].x + barWidth / 2).toBeCloseTo(category.bands[0].centre);
    expect(bars[1].x - (bars[0].x + barWidth)).toBeCloseTo(barWidth);
  });

  it("gap 0 fills the band edge to edge", () => {
    const { barWidth, bars, bandWidth } = computeChartLayout(
      data(["a", "b", "c"], [1, 2, 3]),
      config("column", { style: { gap: 0 } }),
    );
    expect(barWidth).toBeCloseTo(bandWidth);
    expect(bars[0].x).toBeCloseTo(0);
    expect(bars[1].x).toBeCloseTo(bandWidth);
  });

  it("multiple series share the group with the fixed inner gap", () => {
    const { barWidth, bars, category } = computeChartLayout(
      data(["a", "b"], [1, 2], [3, 4]),
      config("column", { style: { gap: 0 } }),
    );
    const groupWidth = (2 + CHART_SERIES_GAP) * barWidth;
    expect(groupWidth).toBeCloseTo(0.5);
    const first = bars.find((b) => b.seriesIndex === 0 && b.categoryIndex === 0);
    const second = bars.find((b) => b.seriesIndex === 1 && b.categoryIndex === 0);
    expect(second?.x).toBeCloseTo((first?.x ?? 0) + barWidth * (1 + CHART_SERIES_GAP));
    const groupCentre = ((first?.x ?? 0) + (second?.x ?? 0) + barWidth) / 2;
    expect(groupCentre).toBeCloseTo(category.bands[0].centre);
  });

  it("clamps a silly gap", () => {
    const { barWidth } = computeChartLayout(
      data(["a"], [1]),
      config("column", { style: { gap: 99 } }),
    );
    expect(barWidth).toBeCloseTo(1 / 5);
  });
});

describe("bars", () => {
  it("grows a column from the zero baseline", () => {
    const { bars, value } = computeChartLayout(data(["a"], [50]), config("column"));
    expect(value.max).toBe(50);
    expect(bars[0].y).toBe(0);
    expect(bars[0].height).toBe(1);
    expect(bars[0].base).toBe(value.zero);
    expect(bars[0].stackBase).toBe(0);
  });

  it("plain types keep negatives: the axis drops below zero and the bar grows down", () => {
    const { bars, value } = computeChartLayout(data(["up", "down"], [40, -20]), config("column"));
    expect(value.min).toBeLessThan(0);
    expect(value.zero).toBeGreaterThan(0);
    const down = bars[1];
    expect(down.value).toBe(-20);
    expect(down.base).toBeCloseTo(value.zero);
    expect(down.y + down.height).toBeCloseTo(value.zero);
    expect(down.y).toBeLessThan(value.zero);
  });

  it("stacks segments on their running base", () => {
    const { bars, value } = computeChartLayout(
      data(["a"], [30], [20], [50]),
      config("stackedColumn"),
    );
    expect(value.min).toBe(0);
    expect(value.max).toBe(100);
    expect(bars.map((b) => b.stackBase)).toEqual([0, 30, 50]);
    expect(bars.map((b) => b.y)).toEqual([0, 0.3, 0.5]);
    expect(bars.map((b) => b.height)).toEqual([0.3, 0.2, 0.5]);
    expect(bars.every((b) => b.base === b.y)).toBe(true);
  });

  it("stacked types clamp negatives to zero without eating the stack", () => {
    const { bars } = computeChartLayout(data(["a"], [30], [-20], [50]), config("stackedColumn"));
    expect(bars[1].value).toBe(0);
    expect(bars[1].height).toBe(0);
    expect(bars[2].stackBase).toBe(30);
  });

  it("stacked bars share one slot per category, unstacked ones split the group", () => {
    const stacked = computeChartLayout(data(["a"], [1], [1]), config("stackedColumn"));
    expect(stacked.bars[0].x).toBe(stacked.bars[1].x);
    const grouped = computeChartLayout(data(["a"], [1], [1]), config("column"));
    expect(grouped.bars[0].x).not.toBe(grouped.bars[1].x);
  });

  it("clips marks that fall outside a manual domain", () => {
    const { bars } = computeChartLayout(
      data(["a"], [500]),
      config("column", { axis: { value: { min: 0, max: 100 } } }),
    );
    expect(bars[0].height).toBe(1);
    expect(bars[0].y).toBe(0);
  });
});

describe("orientation", () => {
  it("bar charts swap the axes in layout, not in the renderer", () => {
    const column = computeChartLayout(data(["a"], [50]), config("column"));
    const bar = computeChartLayout(data(["a"], [50]), config("bar"));
    expect(column.orientation).toBe("vertical");
    expect(column.valueAxis).toBe("y");
    expect(column.categoryAxis).toBe("x");
    expect(bar.orientation).toBe("horizontal");
    expect(bar.valueAxis).toBe("x");
    expect(bar.categoryAxis).toBe("y");

    expect(column.bars[0].x).toBeCloseTo(0.25);
    expect(column.bars[0].width).toBeCloseTo(0.5);
    expect(column.bars[0].y).toBe(0);
    expect(column.bars[0].height).toBe(1);

    expect(bar.bars[0].y).toBeCloseTo(0.25);
    expect(bar.bars[0].height).toBeCloseTo(0.5);
    expect(bar.bars[0].x).toBe(0);
    expect(bar.bars[0].width).toBe(1);
  });

  it("stackedBar stacks along x", () => {
    const { bars } = computeChartLayout(data(["a"], [30], [70]), config("stackedBar"));
    expect(bars.map((b) => b.x)).toEqual([0, 0.3]);
    expect(bars.map((b) => b.width)).toEqual([0.3, 0.7]);
    expect(bars[0].y).toBe(bars[1].y);
  });
});

describe("value label anchors", () => {
  it("resolves location against the growing end", () => {
    const above = computeChartLayout(data(["a"], [50]), config("column"));
    expect(above.bars[0].labelAnchor.y).toBe(1);
    expect(above.bars[0].labelAnchor.x).toBeCloseTo(0.5);
    const inside = computeChartLayout(
      data(["a"], [50]),
      config("column", { labels: { values: { location: "inside" } } }),
    );
    expect(inside.bars[0].labelAnchor.y).toBe(0.5);
    const below = computeChartLayout(
      data(["a"], [50]),
      config("column", { labels: { values: { location: "below" } } }),
    );
    expect(below.bars[0].labelAnchor.y).toBe(0);
  });

  it("follows the value axis for bar charts", () => {
    const { bars } = computeChartLayout(data(["a"], [50]), config("bar"));
    expect(bars[0].labelAnchor.x).toBe(1);
    expect(bars[0].labelAnchor.y).toBeCloseTo(0.5);
  });
});

describe("lines and areas", () => {
  it("plots points at band centres over a zero baseline", () => {
    const { series, value } = computeChartLayout(data(["a", "b"], [0, 100]), config("line"));
    expect(series).toHaveLength(1);
    expect(series[0].points.map((p) => p.x)).toEqual([0.25, 0.75]);
    expect(series[0].points.map((p) => p.y)).toEqual([0, 1]);
    expect(series[0].points.map((p) => p.categoryIndex)).toEqual([0, 1]);
    expect(series[0].baseline.every((p) => p.y === value.zero)).toBe(true);
    expect(series[0].baseline.every((p) => p.value === 0)).toBe(true);
  });

  it("stacked areas ride the layer below", () => {
    const { series, value } = computeChartLayout(data(["a"], [40], [60]), config("stackedArea"));
    expect(value.max).toBe(100);
    expect(series[0].baseline[0].y).toBe(0);
    expect(series[0].points[0].y).toBe(0.4);
    expect(series[1].baseline[0].y).toBe(0.4);
    expect(series[1].points[0].y).toBe(1);
  });

  it("plain areas keep negatives below the baseline", () => {
    const { series, value } = computeChartLayout(data(["a", "b"], [-50, 50]), config("area"));
    expect(value.min).toBeLessThan(0);
    expect(series[0].points[0].y).toBeLessThan(value.zero);
    expect(series[0].points[0].value).toBe(-50);
  });

  it("leaves the bar family empty and vice versa", () => {
    const line = computeChartLayout(data(["a"], [1]), config("line"));
    expect(line.bars).toEqual([]);
    expect(line.pie).toBeNull();
    const column = computeChartLayout(data(["a"], [1]), config("column"));
    expect(column.series).toEqual([]);
  });
});

describe("axis trim", () => {
  const scaled = (type: ChartType, min: number, max: number, trim?: boolean): ChartLayoutConfig =>
    config(type, { axis: { value: { min, max, ...(trim === undefined ? {} : { trim }) } } });

  const seriesOf = (rows: number[][], parts: ChartLayoutConfig): ChartSeriesLayout => {
    const categories = rows[0].map((_, i) => `c${i + 1}`);
    return computeChartLayout(data(categories, ...rows), parts).series[0];
  };

  it("leaves a curve inside the band exactly where it was", () => {
    const inside = seriesOf([[2, 5, 8]], scaled("line", 0, 10));
    expect(inside.points.map((p) => p.y)).toEqual([0.2, 0.5, 0.8]);
    expect(inside.points.every((p) => p.datum && p.inside)).toBe(true);
    expect(inside.fillBaseline).toBe(inside.baseline);
    expect(chartTrimRuns(inside.points)).toEqual([[0, 3]]);
  });

  it("cuts a segment at the top bound", () => {
    const over = seriesOf([[5, 15]], scaled("line", 0, 10));
    expect(over.points.map((p) => p.x)).toEqual([0.25, 0.5, 0.75]);
    expect(over.points.map((p) => p.y)).toEqual([0.5, 1, 1]);
    expect(over.points.map((p) => p.datum)).toEqual([true, false, true]);
    expect(over.points.map((p) => p.inside)).toEqual([true, true, false]);
    expect(over.points[1].value).toBeCloseTo(10, 10);
    expect(chartTrimRuns(over.points)).toEqual([[0, 2]]);
  });

  it("cuts a segment at the bottom bound", () => {
    const under = seriesOf([[5, -5]], scaled("line", 0, 10));
    expect(under.points.map((p) => p.x)).toEqual([0.25, 0.5, 0.75]);
    expect(under.points.map((p) => p.y)).toEqual([0.5, 0, 0]);
    expect(under.points.map((p) => p.inside)).toEqual([true, true, false]);
    expect(chartTrimRuns(under.points)).toEqual([[0, 2]]);
  });

  it("draws nothing for a curve wholly outside the band", () => {
    const away = seriesOf([[15, 20]], scaled("line", 0, 10));
    expect(away.points.map((p) => p.y)).toEqual([1, 1]);
    expect(away.points.every((p) => p.inside)).toBe(false);
    expect(chartTrimRuns(away.points)).toEqual([]);
  });

  it("splits a series that leaves and re-enters", () => {
    const peak = seriesOf([[5, 15, 5]], scaled("line", 0, 10));
    for (const [i, x] of [1 / 6, 1 / 3, 1 / 2, 2 / 3, 5 / 6].entries()) {
      expect(peak.points[i].x).toBeCloseTo(x, 10);
    }
    expect(peak.points.map((p) => p.y)).toEqual([0.5, 1, 1, 1, 0.5]);
    expect(peak.points.map((p) => p.inside)).toEqual([true, true, false, true, true]);
    expect(chartTrimRuns(peak.points)).toEqual([
      [0, 2],
      [3, 5],
    ]);
  });

  it("clamps the fill boundary without moving what the build grows out of", () => {
    const lifted = seriesOf([[15, 25]], scaled("area", 10, 30));
    expect(lifted.points.map((p) => p.y)).toEqual([0.25, 0.75]);
    expect(lifted.baseline.map((p) => p.y)).toEqual([-0.5, -0.5]);
    expect(lifted.fillBaseline.map((p) => p.y)).toEqual([0, 0]);
  });

  it("leaves the curve alone when only its zero-line boundary is off-plot", () => {
    const rows = [[16400, 18200, 27600]];
    const lifted = seriesOf(rows, scaled("line", 15000, 30000));
    const bare = seriesOf(rows, scaled("line", 15000, 30000, false));
    expect(lifted.points).toEqual(bare.points);
    expect(lifted.baseline).toEqual(bare.baseline);
    expect(lifted.fillBaseline.map((p) => p.y)).toEqual([0, 0, 0]);
    expect(bare.baseline.map((p) => p.y)).toEqual([-1, -1, -1]);
    expect(chartTrimRuns(lifted.points)).toEqual([[0, 3]]);
  });

  it("cuts a segment that leaves through both bounds at once", () => {
    const swing = seriesOf([[-5, 15]], scaled("line", 0, 10));
    expect(swing.points.map((p) => p.x)).toEqual([0.25, 0.375, 0.625, 0.75]);
    expect(swing.points.map((p) => p.y)).toEqual([0, 0, 1, 1]);
    expect(swing.points.map((p) => p.value)).toEqual([-5, 0, 10, 15]);
    expect(swing.points.map((p) => p.inside)).toEqual([false, true, true, false]);
    expect(chartTrimRuns(swing.points)).toEqual([[1, 3]]);
  });

  it("cuts the fill boundary where the layer below it leaves the band", () => {
    const stacked = computeChartLayout(
      data(["c1", "c2"], [4, 12], [1, 1]),
      scaled("stackedArea", 0, 10),
    ).series[1];
    expect(stacked.points.map((p) => p.x)).toEqual([0.25, 0.5625, 0.625, 0.75]);
    expect(stacked.points.map((p) => p.y)).toEqual([0.5, 1, 1, 1]);
    expect(stacked.points.map((p) => p.inside)).toEqual([true, true, false, false]);
    for (const [i, y] of [0.4, 0.9, 1, 1.2].entries()) {
      expect(stacked.baseline[i].y).toBeCloseTo(y, 10);
      expect(stacked.fillBaseline[i].y).toBeCloseTo(Math.min(1, y), 10);
    }
    expect(chartTrimRuns(stacked.points)).toEqual([[0, 2]]);
  });

  it("draws no run for a lone vertex left standing on the bound", () => {
    const spike = seriesOf([[15, 10, 15]], scaled("line", 0, 10));
    expect(spike.points.map((p) => p.inside)).toEqual([false, true, false]);
    expect(chartTrimRuns(spike.points)).toEqual([]);
  });

  it("leaves everything outside the band when the toggle is off", () => {
    const raw = seriesOf([[5, 15, 5]], scaled("line", 0, 10, false));
    expect(raw.points.map((p) => p.y)).toEqual([0.5, 1.5, 0.5]);
    expect(raw.points.every((p) => p.datum && p.inside)).toBe(true);
    expect(chartTrimRuns(raw.points)).toEqual([[0, 3]]);
  });
});

describe("pie", () => {
  it("slices the circle in category order", () => {
    const { pie } = computeChartLayout(data(["a", "b", "c", "d"], [1, 2, 3, 4]), config("pie"));
    expect(pie?.total).toBe(10);
    expect(pie?.slices.map((s) => s.fraction)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(pie?.slices[0].startAngle).toBe(0);
    expect(pie?.slices[3].endAngle).toBeCloseTo(Math.PI * 2);
    const sum = (pie?.slices ?? []).reduce((a, s) => a + (s.endAngle - s.startAngle), 0);
    expect(sum).toBeCloseTo(Math.PI * 2);
    expect(
      pie?.slices.every((s, i) => i === 0 || s.startAngle === pie.slices[i - 1].endAngle),
    ).toBe(true);
    expect(pie?.slices[0].midAngle).toBeCloseTo(Math.PI * 0.1);
  });

  it("keeps the authored order rather than sorting by value", () => {
    const { pie } = computeChartLayout(data(["a", "b", "c"], [5, 1, 9]), config("pie"));
    expect(pie?.slices[0].value).toBe(5);
    expect(pie?.slices[0].startAngle).toBe(0);
    expect(pie?.slices[2].value).toBe(9);
  });

  it("uses the first series only, clamps negatives and passes inner radius through", () => {
    const { pie } = computeChartLayout(
      data(["a", "b"], [3, -1], [99, 99]),
      config("pie", { style: { innerRadius: 0.4 } }),
    );
    expect(pie?.total).toBe(3);
    expect(pie?.slices).toHaveLength(2);
    expect(pie?.slices[1].value).toBe(0);
    expect(pie?.slices[1].startAngle).toBeCloseTo(Math.PI * 2);
    expect(pie?.innerRadius).toBe(0.4);
    expect(pie?.outerRadius).toBe(1);
  });

  it("clamps a runaway inner radius and draws no axis furniture", () => {
    const layout = computeChartLayout(
      data(["a"], [1]),
      config("pie", { style: { innerRadius: 4 } }),
    );
    expect(layout.pie?.innerRadius).toBe(0.95);
    expect(layout.value.ticks).toEqual([]);
    expect(layout.value.gridlines).toEqual([]);
  });

  it("all-zero data produces zero-width slices, not NaN", () => {
    const { pie } = computeChartLayout(data(["a", "b"], [0, 0]), config("pie"));
    expect(pie?.total).toBe(0);
    expect(pie?.slices.map((s) => s.fraction)).toEqual([0, 0]);
    expect(pie?.slices.every((s) => s.startAngle === 0 && s.endAngle === 0)).toBe(true);
  });
});

describe("degenerate input", () => {
  const finite = (n: number | undefined): boolean => typeof n === "number" && Number.isFinite(n);

  it("survives no series at all", () => {
    const layout = computeChartLayout({ categories: [], series: [] }, config("column"));
    expect(layout.bars).toEqual([]);
    expect(layout.category.bands).toEqual([]);
    expect(layout.categoryCount).toBe(0);
    expect(layout.bandWidth).toBe(0);
    expect(layout.barWidth).toBe(0);
    expect(finite(layout.value.min)).toBe(true);
    expect(finite(layout.value.max)).toBe(true);
    expect(layout.value.ticks.every((t) => finite(t.value) && finite(t.position))).toBe(true);
  });

  it("survives an empty pie", () => {
    const layout = computeChartLayout({ categories: [], series: [] }, config("pie"));
    expect(layout.pie?.slices).toEqual([]);
    expect(layout.pie?.total).toBe(0);
  });

  it("all-zero values still give a usable axis and flat marks", () => {
    const layout = computeChartLayout(data(["a", "b"], [0, 0]), config("column"));
    expect(layout.value.min).toBe(0);
    expect(layout.value.max).toBe(1);
    expect(layout.bars.every((b) => b.height === 0 && b.y === 0)).toBe(true);
  });

  it("ragged and non-finite cells read as zero", () => {
    const layout = computeChartLayout(
      { categories: ["a", "b", "c"], series: [{ id: "s1", name: "S", values: [10, Number.NaN] }] },
      config("column"),
    );
    expect(layout.bars).toHaveLength(3);
    expect(layout.bars.map((b) => b.value)).toEqual([10, 0, 0]);
  });

  it("falls back to the longest series when categories are missing", () => {
    const layout = computeChartLayout(
      { categories: [], series: [{ id: "s1", name: "S", values: [1, 2] }] },
      config("column"),
    );
    expect(layout.categoryCount).toBe(2);
    expect(layout.category.bands.map((b) => b.label)).toEqual(["", ""]);
  });

  it("a collapsed manual domain cannot divide by zero", () => {
    const layout = computeChartLayout(
      data(["a"], [5]),
      config("column", { axis: { value: { min: 10, max: 10 } } }),
    );
    expect(layout.value.max).toBe(11);
    expect(layout.value.ticks.every((t) => finite(t.position))).toBe(true);
  });

  it("is a pure function: the same input twice is deeply equal", () => {
    const input = data(quarters, [17, 26, 53, 96], [55, 43, 70, 58]);
    const a = computeChartLayout(input, config("stackedColumn"));
    const b = computeChartLayout(input, config("stackedColumn"));
    expect(a).toEqual(b);
  });
});
