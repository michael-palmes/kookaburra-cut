import { Matrix4, Quaternion, ShaderLib, Vector3 } from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { describe, expect, it } from "vitest";
import {
  AXIS_LINE_WEIGHT,
  areaShape,
  axisLineRect,
  barLabelSpot,
  barSpan,
  CHART_2D_APPEARANCE,
  CHART_PULSE_LIFT,
  CHART_PULSE_POP,
  CHART_RAMP_ROWS,
  chart2dBands,
  chart2dInsets,
  chart2dLook,
  chart2dMetrics,
  chartBillboardMatrix,
  chartRampTexture,
  chartShineAmount,
  contrastPick,
  dashSegments,
  drawEdgeX,
  estimateTextWidth,
  gridlineRects,
  LABEL_PILL,
  labelPillRect,
  legendChipRect,
  makeChartFillMaterial,
  makeChartRectMaterial,
  markCornerRadius,
  PILL_ALPHA,
  packLegendRows,
  patchChartLineMaterial,
  pieSliceShape,
  pieSweepEnd,
  pieSweepKey,
  pieSweepScale,
  plotToWorldX,
  plotToWorldY,
  pointsKey,
  polylinePositions,
  polylineYAt,
  pulseColour,
  pulseGain,
  pulseScale,
  rectsGeometry,
  revealedPoint,
  revealedPoints,
  valueLabelPill,
} from "./chart2dMath";
import { computeChartLayout } from "./layout";
import { CHART_FULL_REVEAL, CHART_GROW_MAX, meanAlpha, revealAt } from "./reveal";
import { CHART_STYLE_PRESETS } from "./stylePresets";
import type {
  ChartBarMark,
  ChartConfig,
  ChartData,
  ChartLayout,
  ChartLayoutConfig,
  ChartPieSlice,
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
        offsetY: 0,
        background: null,
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

describe("barLabelSpot", () => {
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
    labelAnchor: { x: 0.05, y: 0.6 },
    ...parts,
  });

  it("rides the growing end and nudges outward", () => {
    const bar = mark({});
    expect(barLabelSpot(bar, "y", "above", 0.5, 0.1)).toMatchObject({
      along: 0.3,
      across: 0.05,
      nudge: 0.1,
      direction: 1,
    });
    expect(barLabelSpot(bar, "y", "above", 1, 0.1).along).toBeCloseTo(0.6, 10);
  });

  it("parks at the base and at the midpoint", () => {
    const bar = mark({});
    expect(barLabelSpot(bar, "y", "below", 0.5, 0.1)).toMatchObject({ along: 0, nudge: 0 });
    expect(barLabelSpot(bar, "y", "inside", 0.5, 0.1).along).toBeCloseTo(0.15, 10);
  });

  it("flips the nudge on a negative mark and reads the other anchor axis", () => {
    const falling = mark({ y: 0.2, height: 0.4, base: 0.6 });
    expect(barLabelSpot(falling, "y", "above", 1, 0.1).nudge).toBeCloseTo(-0.1, 10);
    const horizontal = mark({ x: 0, width: 0.5, height: 0.1, base: 0 });
    expect(barLabelSpot(horizontal, "x", "above", 1, 0).across).toBe(0.6);
  });

  it("carries a falling mark's label with it, wherever it is parked", () => {
    const bar = mark({});
    for (const spot of ["above", "inside", "below"] as const) {
      const home = barLabelSpot(bar, "y", spot, 1, 0.1);
      const dropped = barLabelSpot(bar, "y", spot, 1, 0.1, 0.45);
      expect(dropped.along).toBeCloseTo(home.along + 0.45, 10);
      expect(dropped.direction).toBe(home.direction);
      expect(dropped.nudge).toBe(home.nudge);
    }
  });
});

describe("the fall entrance", () => {
  const bar: ChartBarMark = {
    seriesIndex: 0,
    categoryIndex: 0,
    x: 0,
    y: 0,
    width: 0.1,
    height: 0.6,
    value: 6,
    base: 0,
    stackBase: 0,
    labelAnchor: { x: 0.05, y: 0.6 },
  };

  it("translates a bar span rigidly, keeping its size and direction", () => {
    const home = barSpan(bar, "y", 1);
    const dropped = barSpan(bar, "y", 1, 0.45);
    expect(dropped.size).toBeCloseTo(home.size, 10);
    expect(dropped.direction).toBe(home.direction);
    expect(dropped.lo).toBeCloseTo(home.lo + 0.45, 10);
    expect(dropped.end).toBeCloseTo(home.end + 0.45, 10);
  });

  it("translates a negative bar the same way, never inverting it", () => {
    const falling: ChartBarMark = { ...bar, y: 0.2, height: 0.4, base: 0.6 };
    const home = barSpan(falling, "y", 1);
    const dropped = barSpan(falling, "y", 1, 0.45);
    expect(dropped.size).toBeCloseTo(home.size, 10);
    expect(dropped.direction).toBe(-1);
    expect(dropped.lo).toBeCloseTo(home.lo + 0.45, 10);
  });

  it("rides a point and its fill boundary by the same offset", () => {
    const point = { x: 0.5, y: 0.8 };
    const base = { x: 0.5, y: 0.1 };
    expect(revealedPoint(point, base, 1, 0.45).y).toBeCloseTo(1.25, 10);
    expect(revealedPoint(point, base, 0, 0.45).y).toBeCloseTo(0.55, 10);
    const boundary = revealedPoints([base, base], [base, base], [1, 1], [0.45, 0.45]);
    expect(boundary.map((p) => p.y)).toEqual([0.55, 0.55]);
  });

  it("leaves an untrimmed fill boundary exactly on the baseline", () => {
    const boundary = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    expect(revealedPoints(boundary, boundary, [0.4, 0.4])).toEqual(boundary);
    expect(revealedPoints(boundary, boundary, [])).toEqual(boundary);
  });

  it("keeps a settled series exactly where the layout put it", () => {
    const layout = layoutOf("area", data(["a", "b", "c"], [1, 2, 3]));
    const series = layout.series[0];
    const settled = revealedPoints(series.points, series.baseline, [1, 1, 1], [0, 0, 0]);
    expect(settled.map((p) => p.y)).toEqual(series.points.map((p) => p.y));
  });
});

describe("draw-on geometry", () => {
  const points = [
    { x: 0.125, y: 0.2 },
    { x: 0.375, y: 0.4 },
    { x: 0.625, y: 0.3 },
    { x: 0.875, y: 0.9 },
  ];

  it("walks the edge from the first band centre to the last", () => {
    expect(drawEdgeX(points, 0)).toBeCloseTo(0.125, 10);
    expect(drawEdgeX(points, 1)).toBeCloseTo(0.875, 10);
    expect(drawEdgeX([], 0.5)).toBe(1);
  });

  it("lands on the sampler's own head position", () => {
    const categories = points.length;
    for (const draw of [0.2, 0.5, 0.75]) {
      const headX = (0.5 + draw * (categories - 1)) / categories;
      expect(drawEdgeX(points, draw)).toBeCloseTo(headX, 12);
    }
  });

  it("rides the head on the line, clamped to the ends", () => {
    expect(polylineYAt(points, 0.125)).toBeCloseTo(0.2, 10);
    expect(polylineYAt(points, 0.25)).toBeCloseTo(0.3, 10);
    expect(polylineYAt(points, 0)).toBeCloseTo(0.2, 10);
    expect(polylineYAt(points, 2)).toBeCloseTo(0.9, 10);
    expect(polylineYAt([], 0.5)).toBe(0);
  });

  it("rides one point out of its baseline", () => {
    const point = { x: 0.5, y: 0.8 };
    const base = { x: 0.5, y: 0.1 };
    expect(revealedPoint(point, base, 0)).toEqual(base);
    expect(revealedPoint(point, base, 1)).toEqual(point);
    expect(revealedPoint(point, base, 0.5).y).toBeCloseTo(0.45, 10);
    expect(revealedPoint(point, undefined, 0)).toEqual(point);
  });
});

describe("emphasis channels", () => {
  it("gains brightness and scale with the pulse envelope", () => {
    expect(pulseGain(0)).toBe(1);
    expect(pulseGain(1)).toBeCloseTo(1 + CHART_PULSE_LIFT, 10);
    expect(pulseGain(2)).toBeCloseTo(1 + CHART_PULSE_LIFT, 10);
    expect(pulseScale(0)).toBe(1);
    expect(pulseScale(1)).toBeCloseTo(1 + CHART_PULSE_POP, 10);
    expect(CHART_PULSE_POP).toBeLessThanOrEqual(0.06);
  });

  it("holds a colour at rest and lifts it under a pulse", () => {
    expect(pulseColour("#3366cc", 0)).toBe("#3366cc");
    expect(pulseColour("#3366cc", 1)).not.toBe("#3366cc");
  });

  it("sweeps the shine band across a mark and rests off it", () => {
    expect(chartShineAmount(0, 1, -1)).toBe(0);
    expect(chartShineAmount(0, 0, 0.5)).toBe(0);
    // The band centre crosses the mark's own centre exactly halfway through the sweep.
    expect(chartShineAmount(0, 1, 0.5)).toBeCloseTo(1, 10);
    expect(chartShineAmount(0, 1, 0)).toBe(0);
    expect(chartShineAmount(0, 1, 1)).toBe(0);
    expect(chartShineAmount(0.9, 1, 0.5)).toBeLessThan(chartShineAmount(0.2, 1, 0.5));
  });
});

/** The three source these patches splice into is an upstream contract: a version bump that renames an anchor would silently drop a channel, so every injection is asserted here rather than discovered on a stage. */
describe("patched materials", () => {
  const compile = (material: {
    onBeforeCompile: (shader: never, renderer: never) => void;
    vertexShader?: string;
    fragmentShader?: string;
  }): { vertexShader: string; fragmentShader: string } => {
    const shader = {
      uniforms: {},
      vertexShader: material.vertexShader ?? ShaderLib.basic.vertexShader,
      fragmentShader: material.fragmentShader ?? ShaderLib.basic.fragmentShader,
    };
    material.onBeforeCompile(shader as never, undefined as never);
    return shader;
  };

  it("gives every bar its own build state through instanced attributes", () => {
    const rect = makeChartRectMaterial();
    const shader = compile(rect.material);
    expect(shader.vertexShader).toContain("vRectShine = iShine;");
    expect(shader.fragmentShader).toContain("chartShineAmount(dot(vRectP, rectAxis)");
    expect(shader.fragmentShader).toContain("diffuseColor *= vRectColour;");
    rect.material.dispose();
  });

  it("clips an area fill on its stroke's edge", () => {
    const fill = makeChartFillMaterial();
    const shader = compile(fill.material);
    expect(shader.vertexShader).toContain("vChartX = transformed.x;");
    expect(shader.fragmentShader).toContain("gl_FragColor.a *= 1.0 - smoothstep(");
    fill.material.dispose();
  });

  it("clips a stroke and lights its head off the segment's own x", () => {
    const material = new LineMaterial();
    patchChartLineMaterial(material);
    const shader = compile(material);
    expect(shader.vertexShader).toContain(
      "vChartX = ( position.y < 0.5 ) ? instanceStart.x : instanceEnd.x;",
    );
    expect(shader.vertexShader).toContain("float aspect = resolution.x / resolution.y;");
    expect(shader.fragmentShader).toContain("uChartHeadColour");
    expect(shader.fragmentShader).toContain("gl_FragColor = vec4( chartRgb, alpha );");
    material.dispose();
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

  it("clamps a preset overshoot to the grow ceiling and its channels", () => {
    const over = () => ({ grow: 1.4, alpha: -0.2, count: 1.4, pulse: 2, shine: 1.4, drop: 3 });
    expect(revealAt(over, 0, 0)).toEqual({
      grow: CHART_GROW_MAX,
      alpha: 0,
      count: 1,
      pulse: 1,
      shine: 1,
      drop: 1,
    });
    expect(revealAt(() => ({ ...CHART_FULL_REVEAL, drop: -3 }), 0, 0).drop).toBe(-1);
    expect(revealAt(() => ({ ...CHART_FULL_REVEAL, drop: Number.NaN }), 0, 0).drop).toBe(0);
  });

  it("averages a cascade into one stroke alpha", () => {
    const stagger = (_s: number, c: number) => ({
      ...CHART_FULL_REVEAL,
      alpha: c === 0 ? 1 : 0,
    });
    expect(meanAlpha(stagger, 0, 2)).toBe(0.5);
  });
});

describe("appearance surface", () => {
  const boardroom = CHART_STYLE_PRESETS.boardroom.surface;

  it("merges the scene's own overrides over the preset's flat facet", () => {
    const look = chart2dLook(boardroom, { areaOpacity: 0.1, points: true });
    expect(look.areaOpacity).toBe(0.1);
    expect(look.points).toBe(true);
    expect(look.labelFraction).toBe(boardroom.twod.labelFraction);
    // Never the catalogue's own object.
    expect(look).not.toBe(boardroom.twod);
    expect(boardroom.twod.areaOpacity).not.toBe(0.1);
  });

  it("folds the preset's pie gap scale into the gap both dimensions cut with", () => {
    const terminal = CHART_STYLE_PRESETS.terminal.surface;
    expect(chart2dLook(terminal).pieGap).toBeCloseTo(
      terminal.twod.pieGap * terminal.pieGapScale,
      12,
    );
  });

  it("multiplies stroke THICKNESSES by the preset's weight, and nothing else", () => {
    const plain = chart2dMetrics(size, CHART_2D_APPEARANCE);
    const heavy = chart2dMetrics(size, { ...CHART_2D_APPEARANCE, strokeWidthScale: 2 });
    expect(heavy.stroke).toBeCloseTo(plain.stroke * 2, 12);
    expect(heavy.grid).toBeCloseTo(plain.grid * 2, 12);
    expect(heavy.point).toBeCloseTo(plain.point * 2, 12);
    expect(heavy.dash).toBe(plain.dash);
    expect(heavy.tick).toBe(plain.tick);
    expect(heavy.pieOuter).toBe(plain.pieOuter);
  });
});

describe("axis line", () => {
  const values = data(["a", "b"], [10, 20]);

  it("rules the category axis at value zero, heavier than a gridline", () => {
    const layout = layoutOf("column", values);
    const metrics = chart2dMetrics(size, CHART_2D_APPEARANCE);
    const rect = axisLineRect(layout, size, metrics);
    expect(rect?.width).toBe(size.width);
    expect(rect?.height).toBeCloseTo(metrics.grid * AXIS_LINE_WEIGHT, 12);
    expect(rect?.y).toBeCloseTo(
      plotToWorldY(size, layout.value.zero) - (rect?.height ?? 0) / 2,
      12,
    );
  });

  it("runs up the side for a bar chart and never draws on a pie", () => {
    const metrics = chart2dMetrics(size, CHART_2D_APPEARANCE);
    const bar = axisLineRect(layoutOf("bar", values), size, metrics);
    expect(bar?.height).toBe(size.height);
    expect(bar?.width).toBeCloseTo(metrics.grid * AXIS_LINE_WEIGHT, 12);
    expect(axisLineRect(layoutOf("pie", values), size, metrics)).toBeNull();
  });

  it("clamps into the plot when the domain excludes zero", () => {
    const layout = layoutOf("column", data(["a", "b"], [100, 200]), {
      axis: { value: { min: 100, max: 200 } },
    });
    const metrics = chart2dMetrics(size, CHART_2D_APPEARANCE);
    const rect = axisLineRect(layout, size, metrics);
    // The rule centres on the plot's own bottom edge rather than floating off it.
    expect((rect?.y ?? 0) + (rect?.height ?? 0) / 2).toBeCloseTo(-size.height / 2, 12);
  });
});

describe("label pills", () => {
  it("hugs the estimated text box, anchored the same way the label is", () => {
    const centred = labelPillRect("12.5", 1, 0, 0, "center", "middle");
    expect(centred.width).toBeCloseTo(estimateTextWidth("12.5", 1) + 2 * LABEL_PILL.padX, 12);
    expect(centred.height).toBeCloseTo(1 + 2 * LABEL_PILL.padY, 12);
    expect(centred.x + centred.width / 2).toBeCloseTo(0, 12);
    expect(centred.y + centred.height / 2).toBeCloseTo(0, 12);

    const left = labelPillRect("12.5", 1, 0, 0, "left", "middle");
    expect(left.x).toBeCloseTo(-LABEL_PILL.padX, 12);
    const right = labelPillRect("12.5", 1, 0, 0, "right", "middle");
    expect(right.x + right.width).toBeCloseTo(LABEL_PILL.padX, 12);
  });

  it("centres on the text box a top or bottom anchor implies", () => {
    const above = labelPillRect("9", 2, 0, 0, "center", "bottom");
    expect(above.y + above.height / 2).toBeCloseTo(1, 12);
    const below = labelPillRect("9", 2, 0, 0, "center", "top");
    expect(below.y + below.height / 2).toBeCloseTo(-1, 12);
  });

  it("pads a legend chip around its whole entry", () => {
    const chip = legendChipRect(4, 1, 0, 0);
    expect(chip.width).toBeCloseTo(4 + 2 * 0.5, 12);
    expect(chip.x).toBeCloseTo(-0.5, 12);
    expect(chip.y + chip.height / 2).toBeCloseTo(0, 12);
  });

  it("takes the preset's own pill when no background is authored, and nothing at all without either", () => {
    expect(valueLabelPill(true, "#101418", null)).toEqual({
      colour: "#101418",
      opacity: PILL_ALPHA,
      radius: LABEL_PILL.radius,
    });
    expect(valueLabelPill(false, "#101418", null)).toBeNull();
  });

  it("lets an authored background force the chip on and override the derived pill", () => {
    const off = valueLabelPill(false, "#101418", { colour: null, opacity: 0.85, radius: 0.4 });
    expect(off).toEqual({ colour: "#101418", opacity: 0.85, radius: 0.4 });
    const overridden = valueLabelPill(true, "#101418", {
      colour: "#1b2733",
      opacity: 0.5,
      radius: 0,
    });
    expect(overridden).toEqual({ colour: "#1b2733", opacity: 0.5, radius: 0 });
  });

  it("caps the authored radius at the capsule and the opacity at solid", () => {
    expect(valueLabelPill(false, "#101418", { colour: null, opacity: 3, radius: 2 })).toEqual({
      colour: "#101418",
      opacity: 1,
      radius: LABEL_PILL.radius,
    });
    expect(valueLabelPill(false, "#101418", { colour: null, opacity: -1, radius: -1 })).toEqual({
      colour: "#101418",
      opacity: 0,
      radius: 0,
    });
  });
});

describe("pie sweep", () => {
  const slice = (start: number, end: number): ChartPieSlice => ({
    seriesIndex: 0,
    categoryIndex: 0,
    startAngle: start,
    endAngle: end,
    midAngle: (start + end) / 2,
    value: 1,
    fraction: 1,
  });

  it("sweeps the arc out of its own start angle", () => {
    const s = slice(1, 3);
    expect(pieSweepEnd(s, 0)).toBe(1);
    expect(pieSweepEnd(s, 0.5)).toBeCloseTo(2, 12);
    expect(pieSweepEnd(s, 1)).toBe(3);
  });

  it("never overdraws its neighbour on an overshoot, and pops instead", () => {
    const s = slice(1, 3);
    expect(pieSweepEnd(s, 1.05)).toBe(3);
    expect(pieSweepScale(1.05, 0)).toBeCloseTo(1.05, 12);
    expect(pieSweepScale(0.4, 0)).toBe(1);
    expect(pieSweepScale(1, 1)).toBeCloseTo(pulseScale(1), 12);
  });

  it("keys the drawn arcs, so a settled pie holds its buffers", () => {
    expect(pieSweepKey([[0, 1]])).toBe(pieSweepKey([[0, 1]]));
    expect(pieSweepKey([[0, 1]])).not.toBe(pieSweepKey([[0, 0.5]]));
  });
});

describe("gradient ramp", () => {
  const stops: [string, number][] = [
    ["#000000", 0],
    ["#804020", 0.5],
    ["#ffffff", 1],
  ];

  it("rasters the stops into a one-pixel column, base at v 0", () => {
    const texture = chartRampTexture(stops);
    const data = texture.image.data as Uint8Array;
    expect(texture.image.width).toBe(1);
    expect(texture.image.height).toBe(CHART_RAMP_ROWS);
    expect(data.length).toBe(CHART_RAMP_ROWS * 4);
    expect([data[0], data[1], data[2], data[3]]).toEqual([0, 0, 0, 255]);
    const last = (CHART_RAMP_ROWS - 1) * 4;
    expect([data[last], data[last + 1], data[last + 2]]).toEqual([255, 255, 255]);
    texture.dispose();
  });

  it("is a pure function of its stops", () => {
    const a = chartRampTexture(stops);
    const b = chartRampTexture([...stops].reverse());
    expect(Array.from(a.image.data as Uint8Array)).toEqual(Array.from(b.image.data as Uint8Array));
    a.dispose();
    b.dispose();
  });
});

describe("chartBillboardMatrix", () => {
  it("keeps the anchor's world position and uniform scale while facing the camera", () => {
    const anchor = new Matrix4().compose(
      new Vector3(2, 1.5, -3),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4),
      new Vector3(0.95, 0.95, 0.95),
    );
    const cam = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.3);
    const out = chartBillboardMatrix(anchor, cam, 0, new Matrix4());
    const pos = new Vector3().setFromMatrixPosition(out);
    const scl = new Vector3().setFromMatrixScale(out);
    expect(pos.x).toBeCloseTo(2, 6);
    expect(pos.y).toBeCloseTo(1.5, 6);
    expect(pos.z).toBeCloseTo(-3, 6);
    expect(scl.x).toBeCloseTo(0.95, 6);
    const zBasis = new Vector3(0, 0, 1).applyMatrix4(out).sub(pos).normalize();
    const camZ = new Vector3(0, 0, 1).applyQuaternion(cam);
    expect(zBasis.dot(camZ)).toBeCloseTo(1, 6);
  });
  it("composes the z rotation without moving the anchor and is identical across calls", () => {
    const anchor = new Matrix4().makeTranslation(-1, 0.5, 2);
    const cam = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.1);
    const a = chartBillboardMatrix(anchor, cam, Math.PI / 2, new Matrix4());
    const b = chartBillboardMatrix(anchor, cam, Math.PI / 2, new Matrix4());
    expect(a.equals(b)).toBe(true);
    const pos = new Vector3().setFromMatrixPosition(a);
    expect(pos.x).toBeCloseTo(-1, 6);
  });
});
