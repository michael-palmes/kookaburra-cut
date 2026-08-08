/** Pure chart layout maths: a deterministic function of (data, config) with no clock, randomness or history, so preview and export cannot drift. Output is normalised to a 0..1 plot rect (x right, y UP) and already orientation-resolved, so renderers place marks without knowing the chart type. Marks are also already cut to that band: bars clamp, and lines and areas take the axis trim (`axis.value.trim`), which splits a curve at every bound crossing rather than flattening it along the edge. Degenerate data (no series, one category, all zeroes) must never throw. */

import { ticks as d3Ticks } from "d3-array";
import { scaleLinear } from "d3-scale";
import { pie as d3Pie } from "d3-shape";
import type {
  ChartBarMark,
  ChartCategoryBand,
  ChartData,
  ChartLayout,
  ChartLayoutConfig,
  ChartLinePoint,
  ChartOrientation,
  ChartPieLayout,
  ChartPoint,
  ChartSeriesLayout,
  ChartTick,
  ChartType,
  ChartValueAxisLayout,
  ChartValueLabelLocation,
} from "./types";

/** Space between category groups, in bar widths (the Keynote "gap between sets" default). */
export const CHART_DEFAULT_GAP = 1;
/** Space between bars inside one category group, in bar widths. Not authorable: one gap control is enough at our chart sizes. */
export const CHART_SERIES_GAP = 0.2;
export const CHART_DEFAULT_STEPS = 4;

const GAP_MAX = 4;
const STEPS_MIN = 1;
const STEPS_MAX = 20;
const INNER_RADIUS_MAX = 0.95;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const num = (v: number | null | undefined, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** A manual axis bound only counts when it is a finite number; anything else is auto. */
const bound = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const isStacked = (type: ChartType): boolean =>
  type === "stackedColumn" || type === "stackedBar" || type === "stackedArea";

const isBarFamily = (type: ChartType): boolean =>
  type === "column" || type === "bar" || type === "stackedColumn" || type === "stackedBar";

const isLineFamily = (type: ChartType): boolean =>
  type === "line" || type === "area" || type === "stackedArea";

const orientationOf = (type: ChartType): ChartOrientation =>
  type === "bar" || type === "stackedBar" ? "horizontal" : "vertical";

/** [series][category], missing and non-finite cells read as 0. */
function readMatrix(data: ChartData, seriesCount: number, categoryCount: number): number[][] {
  const rows: number[][] = [];
  for (let s = 0; s < seriesCount; s++) {
    const values = data.series[s]?.values ?? [];
    const row: number[] = [];
    for (let c = 0; c < categoryCount; c++) row.push(num(values[c], 0));
    rows.push(row);
  }
  return rows;
}

/** Stacked types clamp negatives to 0 (negative stacking is out of scope); plain types keep them and the axis extends below zero. */
function domainOf(matrix: number[][], stacked: boolean): [number, number] {
  let lo = 0;
  let hi = 0;
  if (stacked) {
    const categoryCount = matrix[0]?.length ?? 0;
    for (let c = 0; c < categoryCount; c++) {
      let sum = 0;
      for (const row of matrix) sum += Math.max(0, row[c]);
      hi = Math.max(hi, sum);
    }
  } else {
    for (const row of matrix) {
      for (const v of row) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  return hi > lo ? [lo, hi] : [0, 1];
}

const evenTicks = (min: number, max: number, steps: number): number[] =>
  Array.from({ length: steps + 1 }, (_, i) => min + ((max - min) * i) / steps);

function resolveValueAxis(
  matrix: number[][],
  stacked: boolean,
  config: ChartLayoutConfig,
): ChartValueAxisLayout {
  const cfg = config.axis?.value;
  const steps = Math.round(clamp(num(cfg?.steps, CHART_DEFAULT_STEPS), STEPS_MIN, STEPS_MAX));
  const manualMin = bound(cfg?.min);
  const manualMax = bound(cfg?.max);
  const [lo, hi] = domainOf(matrix, stacked);

  let min = manualMin;
  let max = manualMax;
  if (min === null || max === null) {
    const [niceMin, niceMax] = scaleLinear().domain([lo, hi]).nice(steps).domain();
    if (min === null) min = niceMin;
    if (max === null) max = niceMax;
  }
  if (!(max > min)) max = min + 1;

  const both = manualMin !== null && manualMax !== null;
  const values = both ? evenTicks(min, max, steps) : d3Ticks(min, max, steps);
  const span = max - min;
  const ticks: ChartTick[] = (values.length >= 2 ? values : evenTicks(min, max, steps)).map(
    (value) => ({ value, position: (value - min) / span }),
  );

  const gridlines = cfg?.gridlines;
  const gridlineStyle = gridlines?.style ?? "hair";
  const showGrid = gridlines?.visible !== false && gridlineStyle !== "none";

  return {
    min,
    max,
    ticks,
    gridlines: showGrid ? ticks.map((t) => t.position) : [],
    gridlineStyle,
    zero: (0 - min) / span,
    name: cfg?.name ?? null,
    labels: cfg?.labels !== false,
  };
}

function pieLayout(matrix: number[][], config: ChartLayoutConfig): ChartPieLayout {
  const values = (matrix[0] ?? []).map((v) => Math.max(0, v));
  const total = values.reduce((a, v) => a + v, 0);
  const arcs = d3Pie<number>()
    .sort(null)
    .sortValues(null)
    .value((d) => d)(values);
  return {
    slices: arcs.map((arc, i) => ({
      seriesIndex: 0,
      categoryIndex: i,
      startAngle: arc.startAngle,
      endAngle: arc.endAngle,
      midAngle: (arc.startAngle + arc.endAngle) / 2,
      value: values[i],
      fraction: total > 0 ? values[i] / total : 0,
    })),
    innerRadius: clamp(num(config.style?.innerRadius, 0), 0, INNER_RADIUS_MAX),
    outerRadius: 1,
    total,
  };
}

/** The two edges of the plot band a line or area is trimmed against. */
const AXIS_BOUNDS = [0, 1] as const;

/** Where a segment crosses an axis bound, as the parameter along it; an end point sitting exactly on the bound is not a crossing, so nothing is ever inserted twice. */
function crossingAt(a: number, b: number, bound: number): number | null {
  if ((a < bound && b > bound) || (a > bound && b < bound)) return (bound - a) / (b - a);
  return null;
}

/** Every cut one segment takes, in order: the bound the value curve crosses there, the bound its fill boundary crosses, or both at once. */
interface TrimCut {
  t: number;
  top: number | null;
  base: number | null;
}

function segmentCuts(
  p0: ChartLinePoint,
  p1: ChartLinePoint,
  b0: ChartLinePoint,
  b1: ChartLinePoint,
): TrimCut[] {
  const cuts = new Map<number, TrimCut>();
  const add = (t: number | null, key: "top" | "base", bound: number): void => {
    if (t === null) return;
    const cut = cuts.get(t) ?? { t, top: null, base: null };
    cut[key] = bound;
    cuts.set(t, cut);
  };
  for (const bound of AXIS_BOUNDS) {
    add(crossingAt(p0.y, p1.y, bound), "top", bound);
    add(crossingAt(b0.y, b1.y, bound), "base", bound);
  }
  return [...cuts.values()].sort((a, b) => a.t - b.t);
}

/** An inserted vertex: interpolated along the segment, but pinned EXACTLY to the bound it crosses so a run boundary can never drift by a rounding step. */
function cutVertex(
  a: ChartLinePoint,
  b: ChartLinePoint,
  t: number,
  bound: number | null,
): ChartLinePoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: bound ?? a.y + (b.y - a.y) * t,
    categoryIndex: a.categoryIndex,
    value: a.value + (b.value - a.value) * t,
    datum: false,
    inside: true,
  };
}

const outsideBand = (p: ChartPoint): boolean => p.y < 0 || p.y > 1;

/** Cut a series to the plot band: a vertex at every bound crossing, coordinates clamped, and the vertices the true curve left the band on marked so the stroke breaks there rather than flattening along the edge. Hands back the input untouched when neither the curve nor its boundary leaves the band, and the cut path is a value-preserving identity when nothing actually crosses (a manual min above zero pushes a plain series' boundary off-plot on its own), so a chart inside its scale is exactly what it always was either way. */
function trimSeries(
  seriesIndex: number,
  points: ChartLinePoint[],
  baseline: ChartLinePoint[],
): ChartSeriesLayout {
  if (!points.some(outsideBand) && !baseline.some(outsideBand)) {
    return { seriesIndex, points, baseline, fillBaseline: baseline };
  }
  const cutPoints: ChartLinePoint[] = [];
  const cutBaseline: ChartLinePoint[] = [];
  const fillBaseline: ChartPoint[] = [];
  const add = (top: ChartLinePoint, base: ChartLinePoint): void => {
    const inside = top.y >= 0 && top.y <= 1;
    cutPoints.push({ ...top, y: clamp(top.y, 0, 1), inside });
    cutBaseline.push({ ...base, inside });
    fillBaseline.push({ x: base.x, y: clamp(base.y, 0, 1) });
  };
  for (let i = 0; i < points.length; i++) {
    add(points[i], baseline[i]);
    const next = i + 1;
    if (next >= points.length) break;
    for (const cut of segmentCuts(points[i], points[next], baseline[i], baseline[next])) {
      add(
        cutVertex(points[i], points[next], cut.t, cut.top),
        cutVertex(baseline[i], baseline[next], cut.t, cut.base),
      );
    }
  }
  return { seriesIndex, points: cutPoints, baseline: cutBaseline, fillBaseline };
}

/** The half-open index ranges of a trimmed curve that are genuinely inside the plot band: what a stroke draws and a 3D ribbon sweeps. One range covering everything when nothing was trimmed, and a lone vertex is never a range, since neither renderer can draw a run of one. */
export function chartTrimRuns(points: readonly ChartLinePoint[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  const close = (end: number): void => {
    if (start >= 0 && end - start >= 2) runs.push([start, end]);
    start = -1;
  };
  for (let i = 0; i < points.length; i++) {
    if (points[i].inside) {
      if (start < 0) start = i;
    } else close(i);
  }
  close(points.length);
  return runs;
}

/** Where a value label sits along the value axis: outside the growing end, mid mark, or at the base. */
function labelPosition(location: ChartValueLabelLocation, basePos: number, topPos: number): number {
  if (location === "below") return basePos;
  if (location === "inside") return (basePos + topPos) / 2;
  return topPos;
}

export function computeChartLayout(data: ChartData, config: ChartLayoutConfig): ChartLayout {
  const { type } = config;
  const stacked = isStacked(type);
  const orientation = orientationOf(type);
  const vertical = orientation === "vertical";
  const seriesCount = data.series.length;
  const longest = data.series.reduce((n, s) => Math.max(n, s.values.length), 0);
  const categoryCount = data.categories.length || longest;
  const matrix = readMatrix(data, seriesCount, categoryCount);

  const value = resolveValueAxis(matrix, stacked, config);
  const span = value.max - value.min;
  const pos = (v: number): number => (v - value.min) / span;
  const point = (categoryPos: number, valuePos: number): ChartPoint =>
    vertical ? { x: categoryPos, y: valuePos } : { x: valuePos, y: categoryPos };

  const bandWidth = categoryCount > 0 ? 1 / categoryCount : 0;
  const bands: ChartCategoryBand[] = Array.from({ length: categoryCount }, (_, i) => ({
    index: i,
    label: data.categories[i] ?? "",
    start: i * bandWidth,
    centre: (i + 0.5) * bandWidth,
    end: (i + 1) * bandWidth,
  }));

  // Bar width falls out of the band budget: every band holds one group (its bars plus their inner gaps) and one inter-group gap, all measured in bar widths.
  const gap = clamp(num(config.style?.gap, CHART_DEFAULT_GAP), 0, GAP_MAX);
  const slots = stacked || !isBarFamily(type) ? 1 : Math.max(1, seriesCount);
  const groupUnits = slots + (slots - 1) * CHART_SERIES_GAP;
  const barWidth = categoryCount > 0 ? 1 / (categoryCount * (groupUnits + gap)) : 0;
  const groupWidth = groupUnits * barWidth;
  const location = config.labels?.values?.location ?? "above";

  const bars: ChartBarMark[] = [];
  const series: ChartSeriesLayout[] = [];
  let pie: ChartPieLayout | null = null;

  if (type === "pie") {
    pie = pieLayout(matrix, config);
  } else if (isBarFamily(type)) {
    const stackBase = new Array<number>(categoryCount).fill(0);
    for (let s = 0; s < seriesCount; s++) {
      for (let c = 0; c < categoryCount; c++) {
        const raw = matrix[s][c];
        const datum = stacked ? Math.max(0, raw) : raw;
        const base = stacked ? stackBase[c] : 0;
        if (stacked) stackBase[c] = base + datum;
        const basePos = clamp(pos(base), 0, 1);
        const topPos = clamp(pos(base + datum), 0, 1);
        const lo = Math.min(basePos, topPos);
        const hi = Math.max(basePos, topPos);
        const slot = stacked ? 0 : s;
        const start =
          bands[c].start + (bandWidth - groupWidth) / 2 + slot * (1 + CHART_SERIES_GAP) * barWidth;
        const across = point(start, lo);
        bars.push({
          seriesIndex: s,
          categoryIndex: c,
          x: across.x,
          y: across.y,
          width: vertical ? barWidth : hi - lo,
          height: vertical ? hi - lo : barWidth,
          value: datum,
          base: basePos,
          stackBase: base,
          labelAnchor: point(start + barWidth / 2, labelPosition(location, basePos, topPos)),
        });
      }
    }
  } else if (isLineFamily(type)) {
    const trim = config.axis?.value?.trim !== false;
    const stackBase = new Array<number>(categoryCount).fill(0);
    for (let s = 0; s < seriesCount; s++) {
      const points: ChartLinePoint[] = [];
      const baseline: ChartLinePoint[] = [];
      for (let c = 0; c < categoryCount; c++) {
        const raw = matrix[s][c];
        const datum = stacked ? Math.max(0, raw) : raw;
        const base = stacked ? stackBase[c] : 0;
        if (stacked) stackBase[c] = base + datum;
        const centre = bands[c].centre;
        const top = point(centre, pos(base + datum));
        const bottom = point(centre, pos(base));
        points.push({ ...top, categoryIndex: c, value: datum, datum: true, inside: true });
        baseline.push({ ...bottom, categoryIndex: c, value: base, datum: true, inside: true });
      }
      series.push(
        trim
          ? trimSeries(s, points, baseline)
          : { seriesIndex: s, points, baseline, fillBaseline: baseline },
      );
    }
  }

  return {
    type,
    orientation,
    valueAxis: vertical ? "y" : "x",
    categoryAxis: vertical ? "x" : "y",
    stacked,
    seriesCount,
    categoryCount,
    bars,
    series,
    pie,
    value: type === "pie" ? { ...value, ticks: [], gridlines: [] } : value,
    category: {
      bands,
      name: config.axis?.category?.name ?? null,
      labels: config.axis?.category?.labels !== false,
    },
    bandWidth,
    barWidth,
  };
}
