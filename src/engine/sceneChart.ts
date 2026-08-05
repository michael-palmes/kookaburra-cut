/** Chart engine core: resolves the sidecar `chart` block into a fully defaulted `ResolvedChart` (every field present, so renderers never null-check) and samples the keyframed data track. Pure (no clock reads, no three.js) so preview and export agree by construction; the layout maths lives in `toolkit/chart/layout.ts` and number formatting in `toolkit/chart/format.ts`. */

import { CHART_DECIMALS_MAX, CHART_DEFAULT_FORMAT } from "../toolkit/chart/format";
import { CHART_DEFAULT_GAP, CHART_DEFAULT_STEPS } from "../toolkit/chart/layout";
import type {
  ChartAnimationConfig,
  ChartAxisConfig,
  ChartCategoryAxis,
  ChartConfig,
  ChartData,
  ChartLabelConfig,
  ChartLegend,
  ChartSeries,
  ChartStyle,
  ChartValueAxis,
  ChartValueFormat,
  ChartValueLabels,
  ChartValuesPose,
} from "../toolkit/chart/types";
import { ease } from "./ease";
import { trackLayout } from "./keyedTrack";
import type {
  SceneDoc,
  SceneDocChart,
  SceneDocChartData,
  SceneDocChartValueAxis,
  SceneDocChartValueLabels,
} from "./sceneDocSchema";

/** Appearance defaults; hero 3D charts stand front on until a tilt is authored (the inspector's tilt and turn fields). */
export const CHART_STYLE_DEFAULTS: ChartStyle = {
  preset: "boardroom",
  depth: 0.5,
  gap: CHART_DEFAULT_GAP,
  cornerRadius: 0.25,
  rotation: [0, 0],
  innerRadius: 0,
  offset: [0, 0.4],
  scale: 1,
};

/** Axis labels default to auto decimals: round tick values print without trailing zeros. */
export const CHART_AXIS_FORMAT_DEFAULTS: ChartValueFormat = { ...CHART_DEFAULT_FORMAT };

/** Value labels default to whole numbers, so a counting label lands on exactly the printed value. */
export const CHART_VALUE_FORMAT_DEFAULTS: ChartValueFormat = {
  ...CHART_DEFAULT_FORMAT,
  decimals: 0,
};

export const CHART_ANIMATION_DEFAULTS: ChartAnimationConfig = {
  preset: "rise",
  delivery: "cascade",
  staggerMs: 60,
  durationMs: 900,
  from: "start",
};

/** One resolved data key: values normalised to the block's series x category shape. */
export interface ResolvedChartKey {
  /** Scene-local time, ms. */
  tMs: number;
  values: number[][];
}

/** One resolved morph: both endpoint matrices inline (the compare-segment shape), eased across the span. */
export interface ResolvedChartSegment {
  fromTMs: number;
  fromValues: number[][];
  toTMs: number;
  toValues: number[][];
  ease: string;
}

/** Keys sorted by time, segments resolved (bad references dropped); both empty for a static chart. */
export interface ResolvedChartTrack {
  keys: readonly ResolvedChartKey[];
  segments: readonly ResolvedChartSegment[];
}

/** The chart block with every default baked and the data track resolved: what the renderers and the editor read. `data.categories` and every `series.values` row are the same length, so a sampled matrix is always rectangular. */
export interface ResolvedChart extends ChartConfig {
  track: ResolvedChartTrack;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** A manual axis bound only counts when it is a finite number; anything else is auto. */
const boundOf = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function resolveDecimals(raw: number | null | undefined, fallback: number | null): number | null {
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.round(clamp(raw, 0, CHART_DECIMALS_MAX));
  }
  return fallback;
}

function resolveFormat(
  raw: Partial<ChartValueFormat> | undefined,
  defaults: ChartValueFormat,
): ChartValueFormat {
  return {
    decimals: resolveDecimals(raw?.decimals, defaults.decimals),
    separator: raw?.separator ?? defaults.separator,
    prefix: raw?.prefix ?? defaults.prefix,
    suffix: raw?.suffix ?? defaults.suffix,
    compact: raw?.compact ?? defaults.compact,
  };
}

/** Rows and categories normalise to one length (the authored categories, or the longest series when the chart has none), so every downstream matrix is rectangular. */
function resolveData(raw: SceneDocChartData | undefined): ChartData {
  const rawSeries = raw?.series ?? [];
  const longest = rawSeries.reduce((n, s) => Math.max(n, s.values?.length ?? 0), 0);
  const categoryCount = raw?.categories?.length || longest;
  const categories = Array.from({ length: categoryCount }, (_, i) => raw?.categories?.[i] ?? "");
  const series: ChartSeries[] = rawSeries.map((s, i) => {
    const id = s.id || `s${i + 1}`;
    const out: ChartSeries = {
      id,
      name: s.name && s.name.length > 0 ? s.name : id,
      values: Array.from({ length: categoryCount }, (_, c) => num(s.values?.[c], 0)),
    };
    if (s.colour) out.colour = s.colour;
    return out;
  });
  const data: ChartData = { categories, series };
  if (raw?.source) data.source = raw.source;
  return data;
}

/** Bounds layout owns (gap, steps, pie inner radius) pass through as authored; only what layout does not clamp is clamped here. */
function resolveStyle(raw: Partial<ChartStyle> | undefined): ChartStyle {
  const rotation = raw?.rotation;
  return {
    preset: raw?.preset ?? CHART_STYLE_DEFAULTS.preset,
    depth: clamp(num(raw?.depth, CHART_STYLE_DEFAULTS.depth), 0, 1),
    gap: Math.max(0, num(raw?.gap, CHART_STYLE_DEFAULTS.gap)),
    cornerRadius: clamp(num(raw?.cornerRadius, CHART_STYLE_DEFAULTS.cornerRadius), 0, 1),
    rotation: rotation
      ? [num(rotation[0], 0), num(rotation[1], 0)]
      : [CHART_STYLE_DEFAULTS.rotation[0], CHART_STYLE_DEFAULTS.rotation[1]],
    innerRadius: Math.max(0, num(raw?.innerRadius, CHART_STYLE_DEFAULTS.innerRadius)),
    offset: raw?.offset
      ? [clamp(num(raw.offset[0], 0), -20, 20), clamp(num(raw.offset[1], 0), -20, 20)]
      : [CHART_STYLE_DEFAULTS.offset[0], CHART_STYLE_DEFAULTS.offset[1]],
    scale: clamp(num(raw?.scale, CHART_STYLE_DEFAULTS.scale), 0.2, 3),
  };
}

function resolveValueAxis(raw: SceneDocChartValueAxis | undefined): ChartValueAxis {
  return {
    name: typeof raw?.name === "string" ? raw.name : null,
    min: boundOf(raw?.min),
    max: boundOf(raw?.max),
    steps: num(raw?.steps, CHART_DEFAULT_STEPS),
    format: resolveFormat(raw?.format, CHART_AXIS_FORMAT_DEFAULTS),
    gridlines: {
      visible: raw?.gridlines?.visible !== false,
      style: raw?.gridlines?.style ?? "hair",
    },
    labels: raw?.labels !== false,
  };
}

function resolveCategoryAxis(raw: Partial<ChartCategoryAxis> | undefined): ChartCategoryAxis {
  return {
    name: typeof raw?.name === "string" ? raw.name : null,
    labels: raw?.labels !== false,
  };
}

function resolveLegend(raw: Partial<ChartLegend> | undefined): ChartLegend {
  return { visible: raw?.visible !== false, position: raw?.position ?? "bottom" };
}

function resolveValueLabels(raw: SceneDocChartValueLabels | undefined): ChartValueLabels {
  return {
    visible: raw?.visible !== false,
    location: raw?.location ?? "above",
    format: resolveFormat(raw?.format, CHART_VALUE_FORMAT_DEFAULTS),
    countUp: raw?.countUp !== false,
  };
}

function resolveAnimation(raw: Partial<ChartAnimationConfig> | undefined): ChartAnimationConfig {
  return {
    preset: raw?.preset ?? CHART_ANIMATION_DEFAULTS.preset,
    delivery: raw?.delivery ?? CHART_ANIMATION_DEFAULTS.delivery,
    staggerMs: Math.max(0, num(raw?.staggerMs, CHART_ANIMATION_DEFAULTS.staggerMs)),
    durationMs: Math.max(0, num(raw?.durationMs, CHART_ANIMATION_DEFAULTS.durationMs)),
    from: raw?.from ?? CHART_ANIMATION_DEFAULTS.from,
  };
}

/** The static value matrix, `[series][category]`; a fresh copy every call. */
function matrixOf(data: ChartData): number[][] {
  return data.series.map((s) => [...s.values]);
}

/** A pose stretched onto the resolved shape: cells the pose does not define fall back to the static datum, so adding a series after keyframing renders it at its authored value rather than zero. */
function normaliseMatrix(pose: ChartValuesPose | undefined, base: number[][]): number[][] {
  return base.map((row, s) =>
    row.map((v, c) => {
      const cell = pose?.values?.[s]?.[c];
      return typeof cell === "number" && Number.isFinite(cell) ? cell : v;
    }),
  );
}

function resolveTrack(raw: SceneDocChart["track"], base: number[][]): ResolvedChartTrack {
  const layout = trackLayout<ChartValuesPose>({
    keys: raw?.keys ?? [],
    segments: raw?.segments ?? [],
  });
  const byId = new Map(layout.keys.map((k) => [k.id, normaliseMatrix(k.pose, base)]));
  const keys = layout.keys.map((k) => ({
    tMs: k.tMs,
    values: byId.get(k.id) ?? normaliseMatrix(k.pose, base),
  }));
  const segments = layout.segments.map((seg) => ({
    fromTMs: seg.fromTMs,
    fromValues: byId.get(seg.fromId) ?? base,
    toTMs: seg.toTMs,
    toValues: byId.get(seg.toId) ?? base,
    ease: seg.ease,
  }));
  return { keys, segments };
}

/** Normalise a doc's chart block: every default baked, values rectangular, the data track sorted and resolved. Null when the doc has none (the null-for-legacy path). */
export function resolveChart(doc: SceneDoc | undefined): ResolvedChart | null {
  const raw = doc?.chart;
  if (!raw) return null;
  const mount = raw.mount ?? "hero";
  const data = resolveData(raw.data);
  const axis: ChartAxisConfig = {
    value: resolveValueAxis(raw.axis?.value),
    category: resolveCategoryAxis(raw.axis?.category),
  };
  const labels: ChartLabelConfig = {
    legend: resolveLegend(raw.labels?.legend),
    values: resolveValueLabels(raw.labels?.values),
  };
  const chart: ResolvedChart = {
    type: raw.type,
    // A panel column has no depth to stage into, so panel-mounted charts are always flat.
    dimension: mount === "panel" ? "2d" : (raw.dimension ?? "2d"),
    mount,
    data,
    style: resolveStyle(raw.style),
    axis,
    labels,
    animation: resolveAnimation(raw.animation),
    track: resolveTrack(raw.track, matrixOf(data)),
  };
  if (mount === "staged" && raw.placement) chart.placement = raw.placement;
  return chart;
}

/** Sample the chart's values at a scene-local time: elementwise eased interpolation inside a segment, the latest key holding outside one (the compare/camera semantics), the first key before the track starts, and the block's static values when there is no track. Always a fresh matrix. */
export function chartValuesAt(chart: ResolvedChart, localMs: number): number[][] {
  for (const seg of chart.track.segments) {
    if (localMs >= seg.fromTMs && localMs < seg.toTMs) {
      const p = ease(seg.ease, (localMs - seg.fromTMs) / (seg.toTMs - seg.fromTMs));
      return seg.fromValues.map((row, s) => row.map((v, c) => v + (seg.toValues[s][c] - v) * p));
    }
  }
  const keys = chart.track.keys;
  if (keys.length === 0) return matrixOf(chart.data);
  let held = keys[0];
  for (const key of keys) {
    if (key.tMs <= localMs) held = key;
    else break;
  }
  return held.values.map((row) => [...row]);
}

/** The elementwise upper envelope over the static values and every key pose: layout run against it fixes the value scale across the whole track, so a morph never clips a bar or jitters the axis. */
export function maxAcrossTrack(chart: ResolvedChart): number[][] {
  const envelope = matrixOf(chart.data);
  for (const key of chart.track.keys) {
    for (let s = 0; s < envelope.length; s++) {
      for (let c = 0; c < envelope[s].length; c++) {
        envelope[s][c] = Math.max(envelope[s][c], key.values[s][c]);
      }
    }
  }
  return envelope;
}

/** The resolved data with a sampled (or envelope) matrix substituted, ready for `computeChartLayout`: run it over `maxAcrossTrack` once to fix the value scale, then over each frame's `chartValuesAt` for the marks. */
export function chartDataWithValues(chart: ResolvedChart, values: number[][]): ChartData {
  const data: ChartData = {
    categories: chart.data.categories,
    series: chart.data.series.map((s, i) => ({ ...s, values: values[i] ?? s.values })),
  };
  if (chart.data.source) data.source = chart.data.source;
  return data;
}
