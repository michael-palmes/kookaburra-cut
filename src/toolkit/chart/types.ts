/** The chart vocabulary: the authored config (mirroring the sidecar `chart` block) and the RESOLVED layout the renderers consume. Layout is normalised to a 0..1 plot rect with x right and y UP, and is already orientation-resolved (bar charts swap axes here), so the 2D and 3D renderers share one contract and never re-derive orientation from the chart type. */

import type { DevicePlacement } from "../device/Device";
import type { Chart2DAppearance } from "./chart2dMath";

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
  /** Hero-mount nudge off the fitted centre, world units X/Y. */
  offset: [number, number];
  /** Hero-mount size multiplier over the fitted scale. */
  scale: number;
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
  /** Named colour scheme id (`paletteSchemes.ts`); null takes the theme's palette, which is the pre-scheme behaviour. */
  palette: string | null;
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

/** Per-element build state. `grow` scales a mark from its base (0 = nothing there, 1 = final size; an overshoot preset may push it to `CHART_GROW_MAX` and a landing squash a little under 1). `alpha` multiplies its opacity. `count` is the CLAMPED, monotone counting channel a value label prints against (`value * count`), so a label never runs past the true value while `grow` overshoots. `pulse` is a 0..1 emphasis envelope (glow and scale pops), 0 at rest. `shine` is the shine-band sweep position, 0..1 with 1 = swept past; -1 = no band. `drop` translates the whole element along the VALUE axis in plot-space units (positive = displaced toward the far end), which is the one entrance a scaling channel cannot express; 0 at rest. */
export interface ChartReveal {
  grow: number;
  alpha: number;
  count: number;
  pulse: number;
  shine: number;
  drop: number;
}

/** Per-series build state. `draw` is left-to-right draw-on progress over the series polyline, and doubles as the wipe clip edge along the category axis (1 = fully drawn). `headX` is the plot-space x of the leading head, for its glow; -1 when no head is travelling. `alpha` is the series-level opacity a stroke or fill takes as one unit. */
export interface ChartSeriesReveal {
  draw: number;
  headX: number;
  alpha: number;
}

/** Per-element reveal lookup, called once per mark. Pie slices key on `categoryIndex`, line and area points on both. Absent means everything is fully revealed. */
export type ChartRevealFn = (seriesIndex: number, categoryIndex: number) => ChartReveal;

export type ChartSeriesRevealFn = (seriesIndex: number) => ChartSeriesReveal;

/** One build's two lookups: `at` per element, `series` per series. A fresh object (and fresh closures) per frame, which is what the instanced writers key their dep arrays on. */
export interface ChartRevealSampler {
  at: ChartRevealFn;
  series: ChartSeriesRevealFn;
}

/** What every renderer accepts for `reveal`: the per-element lookup alone (a scene's own override) or a whole sampler. `revealSource.ts` reads either shape, so a renderer never branches on which. */
export type ChartRevealSource = ChartRevealFn | ChartRevealSampler;

/** How an area fill is painted: flat at `areaOpacity`, or a vertical ramp built from `chartGradientRamp`. */
export type ChartAreaGradient = "none" | "vertical";

/** Legend swatches as plain dots, or as filled chips (the FrameChip pill treatment). */
export type ChartLegendChrome = "plain" | "chips";

/** Which theme face chart numerals and labels take. */
export type ChartFontEmphasis = "body" | "headline";

/** The flat facet of an appearance preset: every `Chart2DAppearance` fraction the 2D metrics resolve, plus the treatments only a preset asks for. A superset, so `chart2dMetrics` takes it as is. */
export interface ChartStyleSurface2D extends Chart2DAppearance {
  /** Value labels sit in a filled pill rather than floating over the mark. */
  labelPill: boolean;
  /** 0..1: how far tick and category labels lift from the muted token toward the text token (0 = muted, the flat default). */
  tickWeight: number;
  /** Draw a rule along the category axis at the value baseline. */
  axisLine: boolean;
  areaGradient: ChartAreaGradient;
  /** Multiplies every stroke THICKNESS the metrics resolve (line stroke, gridline, point radius, axis line); the per-element fractions stay comparable across presets. */
  strokeWidthScale: number;
}

/** The lit facet: `MeshStandardMaterial` params plus the physical extras a gloss or glass preset needs (the renderer builds a `MeshPhysicalMaterial` only when `clearcoat` or `transmission` is non-zero) and the 3D furniture flags. */
export interface ChartStyleSurface3D {
  roughness: number;
  metalness: number;
  /** 0 = no clearcoat. */
  clearcoat: number;
  clearcoatRoughness: number;
  /** 0 = opaque; above 0 makes frosted glass with `thickness` and `ior`. */
  transmission: number;
  /** Refraction thickness in world units at the default depth; `resolveChartStyle` scales it by the authored `style.depth`. */
  thickness: number;
  ior: number;
  /** 0..1 emissive rim along the mark's edges: the neon look, in-material, never post-processing bloom. */
  emissiveEdge: number;
  /** Multiplies the extrusion bevel on pie slices and ribbon edges; bar boxes take `cornerRadiusScale` instead. */
  bevelScale: number;
  /** Draw the back-wall gridlines. */
  wallGrid: boolean;
  /** Let the chart lay its own floor and catch a shadow when the stage has none. */
  floorShadow: boolean;
  /** Stack segments take the matte finish `chartStackSurface` returns, so a tall stack is not a column of highlights. */
  interiorFlatStacks: boolean;
}

/** The resolved appearance BOTH renderers consume: one flat facet, one lit facet, and the treatments that cross both. `resolveChartStyle` is its only maker, and nothing downstream of it reads `style.preset`. */
export interface ChartStyleSurface {
  /** The preset actually applied (`boardroom` after a degrade). */
  id: string;
  twod: ChartStyleSurface2D;
  threed: ChartStyleSurface3D;
  /** Gridline presence, 0..2: multiplies `twod.gridOpacity` flat and the wall-grid lift in 3D; 0 suppresses gridlines the block asked for. */
  gridStyleWeight: number;
  legendChrome: ChartLegendChrome;
  /** Multiplies `twod.pieGap`, which both dimensions cut their arcs with. */
  pieGapScale: number;
  /** Multiplies the authored `style.cornerRadius`; resolve caps it so the product never passes 1. */
  cornerRadiusScale: number;
  fontEmphasis: ChartFontEmphasis;
  /** OKLCH lightness step per series index, away from the background (`chartSeriesTint`); 0 leaves the palette as resolved. */
  seriesLightnessStep: number;
}

/** What every chart renderer takes, 2D and 3D alike: the resolved block, its computed layout, one colour per series (one per CATEGORY for pie), the plot area in WORLD units, and the optional build state. */
export interface ChartRendererProps {
  chart: ChartConfig;
  layout: ChartLayout;
  colours: string[];
  size: { width: number; height: number };
  reveal?: ChartRevealSource;
  opacity?: number;
}
