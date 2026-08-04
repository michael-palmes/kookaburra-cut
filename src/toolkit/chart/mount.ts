/** Where a chart sits in the world: the pure half of the chart host. It composes the fixed-scale layout the chart engine documents (the track's upper envelope pins the value axis, each frame's sample supplies the marks), resolves the series palette, schedules the build-in (when the sampler is still needed, and the whole-chart entrance offset a channel cannot carry), and turns a `FormatInfo` safe frame into the plot rect each mount needs: a flat chart shrinks by the furniture bands `chart2dMath` reserves, a tilted 3D chart scales to fit its rotated bounding box, and a hero chart under a headline first gives up a title band. No clock, no three.js, no state, so every mount is a pure function of (chart, format, time). */

import {
  chartDataWithValues,
  chartValuesAt,
  maxAcrossTrack,
  type ResolvedChart,
} from "../../engine/sceneChart";
import type { Theme } from "../../theme/tokens";
import type { DevicePlacement } from "../device/Device";
import type { FormatInfo, V3 } from "../types";
import {
  CHART_ENTER_LIFT,
  type ChartRevealDims,
  chartAnimationEndMs,
  chartPresetFor,
} from "./animation";
import {
  CHART_2D_APPEARANCE,
  type Chart2DAppearance,
  type Chart2DInsets,
  type ChartSize,
  chart2dInsets,
} from "./chart2dMath";
import { computeChartLayout } from "./layout";
import { resolveSeriesColour } from "./palette";
import { revealAt } from "./reveal";
import { chart3dSpace } from "./space3d";
import type { ChartConfig, ChartLayout, ChartRevealSampler, ChartStyle } from "./types";

/** A flat chart's furniture bands scale with the plot they leave behind, so the rect settles over a fixed number of passes: a pure, terminating fixpoint rather than a convergence loop. */
const CHART_2D_FIT_PASSES = 3;

/** Label-furniture allowance around a 3D plot, as a fraction of its short edge; symmetric so a tilted chart stays centred in the frame. Estimated like the flat bands, and the same seam for a measured upgrade. */
const CHART_3D_FURNITURE = 0.16;

/** Plot size a staged chart is built at, near the device auto-fit height so a chart beside a phone reads at the same scale; `placement.scale` multiplies it. */
export const CHART_STAGED_SIZE: ChartSize = { width: 3.3, height: 2.2 };

/** Modular-scale steps below the title size the gap between a headline and the plot takes (the `TitleBlock` subtitle step, so chart scenes breathe like text scenes). */
const CHART_TITLE_GAP_STEPS = 4;

/** Ceiling on the title band as a share of the safe height, so no frame can be starved of a plot. */
const CHART_TITLE_BAND_MAX = 0.4;

const MIN_EXTENT = 1e-3;
const DEG2RAD = Math.PI / 180;

/** A world-space rect by its CENTRE (an r3f group position) and its extents. */
export interface ChartRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The visible frame minus its safe insets: what a hero chart lays out inside. */
export function chartSafeRect(format: FormatInfo): ChartRect {
  const { frame, safe } = format;
  return {
    x: (safe.left - safe.right) / 2,
    y: (safe.bottom - safe.top) / 2,
    width: Math.max(MIN_EXTENT, frame.width - safe.left - safe.right),
    height: Math.max(MIN_EXTENT, frame.height - safe.top - safe.bottom),
  };
}

/** The headline a chart scene draws above its plot, as the scaffold's `chart.tsx` template places it: middle-anchored at this world y at this size, portrait then landscape. Mirrored here (not shared) because the band a hero chart gives up has to agree with the title a scene actually draws, and the template is the only thing that draws it. */
export function chartTitleMetrics(format: FormatInfo): { y: number; size: number } {
  return format.aspect < 1 ? { y: 1.9, size: 0.23 } : { y: 1.72, size: 0.42 };
}

/** Band a hero chart gives up off the top of the safe frame so it never runs into the scene's headline: the drop from the safe top to the title's bottom edge, plus a modular-scale gap. 0 without a title, and capped so a small frame always keeps a plot. */
export function chartTitleBand(
  title: string | null | undefined,
  format: FormatInfo,
  theme: Theme,
): number {
  if (!title || title.trim().length === 0) return 0;
  const { y, size } = chartTitleMetrics(format);
  const gap = size / Math.max(1, theme.typography.scale) ** CHART_TITLE_GAP_STEPS;
  const band = format.frame.height / 2 - format.safe.top - (y - size / 2) + gap;
  const available = Math.max(
    MIN_EXTENT,
    format.frame.height - format.safe.top - format.safe.bottom,
  );
  return Math.min(Math.max(0, band), CHART_TITLE_BAND_MAX * available);
}

/** What a hero chart lays out inside: the safe frame, less the title band, recentred on what is left. */
export function chartHeroRect(
  format: FormatInfo,
  theme: Theme,
  title: string | null | undefined,
): ChartRect {
  const safe = chartSafeRect(format);
  const band = Math.min(chartTitleBand(title, format, theme), safe.height - MIN_EXTENT);
  if (band <= 0) return safe;
  return {
    x: safe.x,
    y: safe.y - band / 2,
    width: safe.width,
    height: Math.max(MIN_EXTENT, safe.height - band),
  };
}

/** One colour per series, or per CATEGORY for pie (the `ChartRendererProps` contract): an authored series override wins, then the theme palette. */
export function chartColours(chart: ChartConfig, theme: Theme): string[] {
  if (chart.type === "pie") {
    return chart.data.categories.map((_, i) => resolveSeriesColour(theme, i));
  }
  return chart.data.series.map((s, i) => resolveSeriesColour(theme, i, s.colour));
}

export interface ChartValueBounds {
  min: number;
  max: number;
}

/** Value bounds pinned across a keyframed track, from layout run over the elementwise upper envelope, so a morph never clips a mark or jitters the axis. Null for a static chart, which keeps its natural (nice) ticks. */
export function chartScaleBounds(chart: ResolvedChart): ChartValueBounds | null {
  if (chart.track.keys.length === 0) return null;
  const envelope = computeChartLayout(chartDataWithValues(chart, maxAcrossTrack(chart)), chart);
  return { min: envelope.value.min, max: envelope.value.max };
}

/** The layout for one scene-local instant: the sampled matrix laid out against the pinned bounds. */
export function chartLayoutAt(
  chart: ResolvedChart,
  localMs: number,
  bounds: ChartValueBounds | null,
): ChartLayout {
  const data = chartDataWithValues(chart, chartValuesAt(chart, localMs));
  if (!bounds) return computeChartLayout(data, chart);
  return computeChartLayout(data, {
    ...chart,
    axis: {
      ...chart.axis,
      value: { ...chart.axis.value, min: bounds.min, max: bounds.max },
    },
  });
}

/** When the chart is done moving under its build-in, so the host can stop sampling and let the renderers' value-keyed geometry rest on the full-reveal default. Infinite while a data track can still move it: the marks change every frame regardless, and the build composes with the morph. */
export function chartSettleMs(chart: ResolvedChart, dims: ChartRevealDims): number {
  if (chart.track.keys.length > 0) return Number.POSITIVE_INFINITY;
  return chartAnimationEndMs(chart.animation, dims);
}

/** The whole-chart entrance the `lift` channel asks for (`fadeUp`), as a SIGNED fraction of the plot's height: the chart starts low and rises to 0, driven by the mean counting progress so one number covers any delivery. 0 for every other preset, and 0 once the build has settled. The other entrance (`fall`) is per element and belongs to the renderers. */
export function chartEnterOffset(
  chart: ResolvedChart,
  dims: ChartRevealDims,
  sampler: ChartRevealSampler | null,
): number {
  if (!sampler) return 0;
  if (chartPresetFor(chart.type, chart.animation.preset).channels.enter !== "lift") return 0;
  const count = dims.seriesCount * dims.categoryCount;
  if (count <= 0) return 0;
  let total = 0;
  for (let s = 0; s < dims.seriesCount; s++) {
    for (let c = 0; c < dims.categoryCount; c++) total += revealAt(sampler.at, s, c).count;
  }
  return -(1 - total / count) * CHART_ENTER_LIFT;
}

export interface Chart2DFit {
  size: ChartSize;
  /** World centre of the PLOT rect, which sits off the available centre by whatever the bands reserve. */
  centre: [number, number];
}

/** The flat plot rect inside `available`: the furniture bands (tick labels, category labels, axis names, legend) come from the same estimate the renderer draws with, so reserved and drawn space cannot disagree. Widths are character-count estimates; a measured pass would swap `chart2dInsets`, not this. */
export function fitChart2d(
  chart: ChartConfig,
  layout: ChartLayout,
  available: ChartRect,
  look?: Partial<Chart2DAppearance>,
): Chart2DFit {
  const appearance: Chart2DAppearance = { ...CHART_2D_APPEARANCE, ...look };
  let size: ChartSize = { width: available.width, height: available.height };
  let insets: Chart2DInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  for (let pass = 0; pass < CHART_2D_FIT_PASSES; pass++) {
    insets = chart2dInsets(chart, layout, size, appearance);
    size = {
      width: Math.max(MIN_EXTENT, available.width - insets.left - insets.right),
      height: Math.max(MIN_EXTENT, available.height - insets.top - insets.bottom),
    };
  }
  return {
    size,
    centre: [
      available.x + (insets.left - insets.right) / 2,
      available.y + (insets.bottom - insets.top) / 2,
    ],
  };
}

export interface Chart3DFit {
  size: ChartSize;
  /** Presentation tilt in radians, X then Y. */
  rotation: [number, number];
  /** Uniform scale that brings the tilted footprint back inside `available`. */
  scale: number;
}

/** The tilted 3D plot: built at the available size, then scaled so its rotated bounding box (plot plus a symmetric furniture allowance, plus the extrusion depth) fits the frame again. */
export function fitChart3d(style: ChartStyle, available: ChartRect): Chart3DFit {
  const size: ChartSize = { width: available.width, height: available.height };
  const space = chart3dSpace(style.depth, size.width, size.height);
  const margin = CHART_3D_FURNITURE * space.unit;
  const hx = size.width / 2 + margin;
  const hy = size.height / 2 + margin;
  const hz = space.halfDepth;
  const rx = style.rotation[0] * DEG2RAD;
  const ry = style.rotation[1] * DEG2RAD;
  const sx = Math.sin(rx);
  const cx = Math.cos(rx);
  const sy = Math.sin(ry);
  const cy = Math.cos(ry);
  // Three's XYZ euler with z = 0; the absolute rows give the rotated AABB half extents.
  const width = Math.abs(cy) * hx + Math.abs(sy) * hz;
  const height = Math.abs(sx * sy) * hx + Math.abs(cx) * hy + Math.abs(sx * cy) * hz;
  const scale = Math.min(
    1,
    available.width / Math.max(MIN_EXTENT, 2 * width),
    available.height / Math.max(MIN_EXTENT, 2 * height),
  );
  return { size, rotation: [rx, ry], scale };
}

/** A staged chart's pose, `DevicePlacement` semantics: the layout stamp wins over the scalar fields, rotations are authored in degrees, and `ground` only bites when the scene stages a floor. */
export interface ChartPose {
  position: V3;
  rotation: V3;
  scale: number;
  ground: boolean;
}

export function chartPose(placement: DevicePlacement | undefined): ChartPose {
  const p = placement ?? {};
  const position = p.resolvedLayout?.position ?? p.position ?? [0, 0, 0];
  const deg = p.resolvedLayout?.rotationDeg ?? p.rotationDeg ?? [0, 0, 0];
  return {
    position,
    rotation: [deg[0] * DEG2RAD, deg[1] * DEG2RAD, deg[2] * DEG2RAD],
    scale: p.resolvedLayout?.scale ?? p.scale ?? 1,
    ground: p.ground ?? false,
  };
}

/** World y a staged chart sits at: the plot's base resting on the stage floor when the block asks to ground and the scene stages one, else the authored y. Both dimensions centre their plot on the group origin, so one formula covers them. */
export function chartGroundY(pose: ChartPose, floorY: number | null): number {
  if (!pose.ground || floorY === null) return pose.position[1];
  return floorY + (CHART_STAGED_SIZE.height / 2) * pose.scale;
}
