/** The chart vocabulary: the authored config (mirroring the sidecar `chart` block) and the RESOLVED layout the renderers consume. Layout is normalised to a 0..1 plot rect with x right and y UP, and is already orientation-resolved (bar charts swap axes here), so the 2D and 3D renderers share one contract and never re-derive orientation from the chart type. */

import type { DevicePlacement } from "../device/Device";

export type ChartType =
  | "column"
  | "stackedColumn"
  | "bar"
  | "stackedBar"
  | "line"
  | "area"
  | "stackedArea"
  | "pie";

export type ChartDimension = "2d" | "3d";

/** `hero` is the chart scene kind, `staged` places it among devices/text, `panel` renders it inside an overlay panel column. */
export type ChartMount = "hero" | "staged" | "panel";

/** Which way the marks grow: columns and lines run vertically, bars horizontally. Resolved from the type, never re-derived downstream. */
export type ChartOrientation = "vertical" | "horizontal";

export type ChartAxisKey = "x" | "y";

export type ChartGridlineStyle = "hair" | "dashed" | "none";

export type ChartLegendPosition = "top" | "bottom" | "trailing";

/** Where a value label sits relative to its mark, along the value axis: outside the growing end, centred in the mark, or at the base. */
export type ChartValueLabelLocation = "above" | "inside" | "below";

export type ChartAnimationDelivery = "all" | "series" | "cascade";

export type ChartAnimationFrom = "start" | "end" | "centre" | "edges" | "shuffle";

export interface ChartSeries {
  id: string;
  name: string;
  values: number[];
  /** Hex override; absent or null takes the theme palette swatch for this series index. */
  colour?: string | null;
}

export interface ChartData {
  categories: string[];
  series: ChartSeries[];
  /** Project-relative CSV the values were imported from; informational, nothing reads it at render time. */
  source?: string;
}

/** Number presentation shared by axis labels, value labels and the counter tick-up, so a counting label settles on exactly the printed static value. */
export interface ChartValueFormat {
  /** null is auto (trailing zeros trimmed, at most 2 places). */
  decimals: number | null;
  separator: boolean;
  prefix: string;
  suffix: string;
  /** 1.2k / 3.4M / 1.2B; always explicit, never auto-enabled. */
  compact: boolean;
}

export interface ChartGridlines {
  visible: boolean;
  style: ChartGridlineStyle;
}

export interface ChartValueAxis {
  /** null hides the axis name. */
  name: string | null;
  /** null is auto (nice scale over the data). */
  min: number | null;
  max: number | null;
  /** Divisions of the value axis: exact when both bounds are manual, a tick-density target when either is auto. */
  steps: number;
  format: ChartValueFormat;
  gridlines: ChartGridlines;
  labels: boolean;
}

export interface ChartCategoryAxis {
  name: string | null;
  labels: boolean;
}

export interface ChartAxisConfig {
  value: ChartValueAxis;
  category: ChartCategoryAxis;
}

export interface ChartLegend {
  visible: boolean;
  position: ChartLegendPosition;
}

export interface ChartValueLabels {
  visible: boolean;
  location: ChartValueLabelLocation;
  format: ChartValueFormat;
  countUp: boolean;
}

export interface ChartLabelConfig {
  legend: ChartLegend;
  values: ChartValueLabels;
}

export interface ChartStyle {
  /** Appearance preset id. */
  preset: string;
  /** 3D extrusion depth, 0..1 of the preset's range. */
  depth: number;
  /** Space between category groups, in bar widths. */
  gap: number;
  /** 0..1 of half the bar width. */
  cornerRadius: number;
  /** Presentation tilt for hero 3D charts, X/Y degrees. */
  rotation: [number, number];
  /** Pie only; > 0 makes a donut, as a fraction of the outer radius. */
  innerRadius: number;
}

export interface ChartAnimationConfig {
  /** Build-in preset id. */
  preset: string;
  delivery: ChartAnimationDelivery;
  staggerMs: number;
  durationMs: number;
  from: ChartAnimationFrom;
}

/** A full data snapshot for keyframed data (the Magic Chart model): same series and category counts as the block's own data, values only. */
export interface ChartValuesPose {
  values: number[][];
}

/** The resolved chart block: what the scene hands the renderers. */
export interface ChartConfig {
  type: ChartType;
  dimension: ChartDimension;
  mount: ChartMount;
  /** Staged mount only. */
  placement?: DevicePlacement;
  data: ChartData;
  style: ChartStyle;
  axis: ChartAxisConfig;
  labels: ChartLabelConfig;
  animation: ChartAnimationConfig;
}

/** What `computeChartLayout` reads. Everything but `type` is optional: pass a resolved `ChartConfig` or a sparse literal and the layout defaults fill in. */
export interface ChartLayoutConfig {
  type: ChartType;
  style?: Partial<ChartStyle>;
  axis?: {
    value?: Partial<ChartValueAxis>;
    category?: Partial<ChartCategoryAxis>;
  };
  labels?: {
    legend?: Partial<ChartLegend>;
    values?: Partial<ChartValueLabels>;
  };
}

/** A point in the 0..1 plot rect (x right, y up). */
export interface ChartPoint {
  x: number;
  y: number;
}

/** One rectangular mark (column, bar or stack segment), already orientation-resolved: `x`/`width` run right, `y`/`height` run up, whatever the chart type. */
export interface ChartBarMark {
  seriesIndex: number;
  categoryIndex: number;
  /** Left edge in plot space. */
  x: number;
  /** Bottom edge in plot space. */
  y: number;
  width: number;
  height: number;
  /** The datum behind the mark (after stacked clamping). */
  value: number;
  /** Plot-space coordinate along the value axis the mark grows FROM: the edge that stays put while it builds. */
  base: number;
  /** Data-space value the segment stacks on top of; 0 when unstacked. */
  stackBase: number;
  /** Where the value label sits, resolved from `labels.values.location`, the orientation and the sign; renderers nudge it outward by their own padding. */
  labelAnchor: ChartPoint;
}

/** A value point on a line or area, at its category band centre. */
export interface ChartLinePoint extends ChartPoint {
  categoryIndex: number;
  value: number;
}

/** One line/area series: the value curve plus the lower boundary an area fills to (the zero line, or the stack layer below). */
export interface ChartSeriesLayout {
  seriesIndex: number;
  points: ChartLinePoint[];
  baseline: ChartLinePoint[];
}

export interface ChartPieSlice {
  seriesIndex: number;
  categoryIndex: number;
  /** Radians clockwise from 12 o'clock (the d3-arc convention). */
  startAngle: number;
  endAngle: number;
  midAngle: number;
  /** The datum, negatives clamped to 0. */
  value: number;
  /** Share of the total, 0..1; 0 for every slice when the total is 0. */
  fraction: number;
}

export interface ChartPieLayout {
  slices: ChartPieSlice[];
  /** Fractions of the outer radius; the renderer owns the pie's size on screen. */
  innerRadius: number;
  outerRadius: number;
  total: number;
}

/** A value-axis tick. Labels are NOT formatted here: callers run `value` through the chart formatter so axis labels, value labels and counters all agree. */
export interface ChartTick {
  value: number;
  /** 0..1 along the value axis. */
  position: number;
}

export interface ChartValueAxisLayout {
  min: number;
  max: number;
  ticks: ChartTick[];
  /** Tick positions to draw a line at; empty when gridlines are off. */
  gridlines: number[];
  gridlineStyle: ChartGridlineStyle;
  /** Position of value 0; outside 0..1 when the domain excludes zero. */
  zero: number;
  name: string | null;
  labels: boolean;
}

export interface ChartCategoryBand {
  index: number;
  label: string;
  /** All 0..1 along the category axis; band 0 starts at 0 (left for columns, bottom for bars). */
  start: number;
  centre: number;
  end: number;
}

export interface ChartCategoryAxisLayout {
  bands: ChartCategoryBand[];
  name: string | null;
  labels: boolean;
}

/** The renderer-complete resolution of (data, config): pure, deterministic, unit-space. Only the family for `type` is populated (`bars`, or `series`, or `pie`). */
export interface ChartLayout {
  type: ChartType;
  orientation: ChartOrientation;
  /** Which plot axis carries values, and which carries category bands. */
  valueAxis: ChartAxisKey;
  categoryAxis: ChartAxisKey;
  stacked: boolean;
  seriesCount: number;
  categoryCount: number;
  bars: ChartBarMark[];
  series: ChartSeriesLayout[];
  pie: ChartPieLayout | null;
  value: ChartValueAxisLayout;
  category: ChartCategoryAxisLayout;
  /** Category-axis extents, normalised: one band, and one mark within it. */
  bandWidth: number;
  barWidth: number;
}

/** Per-element build state: `grow` scales a mark from its base (0 = nothing there, 1 = final size), `alpha` multiplies its opacity. */
export interface ChartReveal {
  grow: number;
  alpha: number;
}

/** Per-element reveal lookup, called once per mark. Pie slices key on `categoryIndex`, line and area points on both. Absent means everything is fully revealed. */
export type ChartRevealFn = (seriesIndex: number, categoryIndex: number) => ChartReveal;

/** What every chart renderer takes, 2D and 3D alike: the resolved block, its computed layout, one colour per series (one per CATEGORY for pie), the plot area in WORLD units, and the optional build state. */
export interface ChartRendererProps {
  chart: ChartConfig;
  layout: ChartLayout;
  colours: string[];
  size: { width: number; height: number };
  reveal?: ChartRevealFn;
  opacity?: number;
}
