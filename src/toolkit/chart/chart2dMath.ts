/** Flat-chart geometry and metrics: the pure half of the 2D renderer. Everything here is a function of (layout, plot size, appearance), never of the clock, so `Chart2D` can build its buffers in `useMemo` and know preview and export agree. The plot rect is CENTRED on the group origin: plot space 0..1 (x right, y up) maps to -size/2..+size/2, and axis furniture hangs outside it (see `chart2dInsets`). */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  MeshBasicMaterial,
  Shape,
  SRGBColorSpace,
} from "three";
import { formatChartValue } from "./format";
import type {
  ChartAxisKey,
  ChartBarMark,
  ChartConfig,
  ChartGridlineStyle,
  ChartLayout,
  ChartPoint,
} from "./types";

/** Coplanar layers step apart by this much in z, so a fill can never z-fight the stroke or gridline it sits against (a fixed geometric epsilon, never `polygonOffset`). */
export const CHART_2D_Z_STEP = 0.002;

/** Draw order beneath the marks and above them; explicit so the flat layers never depend on tree order alone. */
export const CHART_2D_ORDER = {
  grid: 0,
  fill: 1,
  mark: 2,
  label: 3,
} as const;

/** Average glyph advance as a fraction of the font size, for reserving label bands without a troika measure round trip (Inter/Space Grotesk digits and short labels sit near this). */
export const CHART_GLYPH_ADVANCE = 0.55;

/** Pie wedges are always sampled at this many divisions, so slice triangulation is identical every run. */
export const PIE_CURVE_SEGMENTS = 64;

/** The flat look, everything a fraction of the plot's SHORT edge so a chart reads the same in every aspect. The appearance-preset phase overrides these field by field. */
export interface Chart2DAppearance {
  /** Tick and category label size. */
  labelFraction: number;
  /** Value label size, relative to a tick label. */
  valueScale: number;
  /** Axis name size, relative to a tick label. */
  axisNameScale: number;
  /** Legend label size, relative to a tick label. */
  legendScale: number;
  /** Gap between the plot edge and its furniture, relative to a tick label. */
  gapScale: number;
  /** Line stroke thickness. */
  strokeFraction: number;
  /** Gridline thickness. */
  gridFraction: number;
  gridOpacity: number;
  /** Dashed gridline dash and gap lengths. */
  dashFraction: number;
  dashGapFraction: number;
  /** Area fill opacity under its stroke. */
  areaOpacity: number;
  /** Draw the value curve over an area fill. */
  areaStroke: boolean;
  /** Dots at line data points. */
  points: boolean;
  pointFraction: number;
  /** Angular gap between pie slices, radians. */
  pieGap: number;
  /** Pie outer radius as a fraction of half the plot's short edge. */
  pieRadius: number;
}

export const CHART_2D_APPEARANCE: Chart2DAppearance = {
  labelFraction: 0.05,
  valueScale: 0.92,
  axisNameScale: 1.05,
  legendScale: 0.95,
  gapScale: 0.5,
  strokeFraction: 0.008,
  gridFraction: 0.002,
  gridOpacity: 0.28,
  dashFraction: 0.02,
  dashGapFraction: 0.016,
  areaOpacity: 0.55,
  areaStroke: true,
  points: false,
  pointFraction: 0.014,
  pieGap: 0.008,
  pieRadius: 0.86,
};

/** World-unit sizes the renderer draws with, resolved once from the plot size. */
export interface Chart2DMetrics {
  tick: number;
  value: number;
  axisName: number;
  legend: number;
  gap: number;
  stroke: number;
  grid: number;
  point: number;
  dash: number;
  dashGap: number;
  pieOuter: number;
}

export interface ChartSize {
  width: number;
  height: number;
}

export function chart2dMetrics(size: ChartSize, look: Chart2DAppearance): Chart2DMetrics {
  const short = Math.max(1e-6, Math.min(size.width, size.height));
  const tick = short * look.labelFraction;
  return {
    tick,
    value: tick * look.valueScale,
    axisName: tick * look.axisNameScale,
    legend: tick * look.legendScale,
    gap: tick * look.gapScale,
    stroke: short * look.strokeFraction,
    grid: short * look.gridFraction,
    point: short * look.pointFraction,
    dash: short * look.dashFraction,
    dashGap: short * look.dashGapFraction,
    pieOuter: (short / 2) * look.pieRadius,
  };
}

/** Plot space (0..1) to the group's local world coordinates. */
export const plotToWorldX = (size: ChartSize, x: number): number => (x - 0.5) * size.width;
export const plotToWorldY = (size: ChartSize, y: number): number => (y - 0.5) * size.height;

export function plotPointToWorld(size: ChartSize, p: ChartPoint): [number, number] {
  return [plotToWorldX(size, p.x), plotToWorldY(size, p.y)];
}

/** Rough label width without a typeset, for reserving bands and packing the legend. */
export const estimateTextWidth = (text: string, fontSize: number): number =>
  text.length * fontSize * CHART_GLYPH_ADVANCE;

/** A signature of a point run, so a geometry rebuild keys on the VERTEX VALUES rather than array identity (the layout hands the renderer a fresh array every frame). */
export const pointsKey = (points: readonly ChartPoint[]): string =>
  points.map((p) => `${p.x},${p.y}`).join("|");

/** One mark's extent along the value axis at a given build state: it grows from `base` towards the edge it would settle on, so a bar rises out of the baseline and a negative bar falls out of it. */
export interface BarSpan {
  /** Lower coordinate of the drawn span, plot space. */
  lo: number;
  /** Drawn length along the value axis, plot space. */
  size: number;
  /** The growing end (where a value label rides). */
  end: number;
  /** +1 when the mark grows towards higher values, -1 when lower. */
  direction: number;
}

export function barSpan(mark: ChartBarMark, valueAxis: ChartAxisKey, grow: number): BarSpan {
  const lo = valueAxis === "y" ? mark.y : mark.x;
  const length = valueAxis === "y" ? mark.height : mark.width;
  // `base` is one of the mark's two value-axis edges, so the far edge mirrors it.
  const far = 2 * lo + length - mark.base;
  const end = mark.base + (far - mark.base) * grow;
  return {
    lo: Math.min(mark.base, end),
    size: Math.abs(end - mark.base),
    end,
    direction: far >= mark.base ? 1 : -1,
  };
}

/** Split a run into dashes that start and end on a dash, so a dashed gridline never trails off mid-gap. Returns `[start, length]` pairs along the run. */
export function dashSegments(length: number, dash: number, gap: number): [number, number][] {
  if (!(length > 0)) return [];
  if (!(dash > 0) || !(gap > 0)) return [[0, length]];
  const count = Math.max(1, Math.round((length + gap) / (dash + gap)));
  const drawn = (length - (count - 1) * gap) / count;
  if (!(drawn > 0)) return [[0, length]];
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) out.push([i * (drawn + gap), drawn]);
  return out;
}

/** An axis-aligned rectangle in the group's local world coordinates. */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One indexed BufferGeometry for a set of rectangles: gridlines are quads, never `gl.LINE` (unreliable AA, ropey under motion). */
export function rectsGeometry(rects: readonly WorldRect[]): BufferGeometry {
  const positions = new Float32Array(rects.length * 12);
  const indices = new Uint16Array(rects.length * 6);
  for (let i = 0; i < rects.length; i++) {
    const { x, y, width, height } = rects[i];
    const p = i * 12;
    positions.set([x, y, 0, x + width, y, 0, x + width, y + height, 0, x, y + height, 0], p);
    const v = i * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/** Gridline quads across the plot, perpendicular to the value axis. */
export function gridlineRects(
  positionsAlongAxis: readonly number[],
  valueAxis: ChartAxisKey,
  style: ChartGridlineStyle,
  size: ChartSize,
  metrics: Chart2DMetrics,
): WorldRect[] {
  if (style === "none") return [];
  const rects: WorldRect[] = [];
  const half = metrics.grid / 2;
  const run = valueAxis === "y" ? size.width : size.height;
  const runs: [number, number][] =
    style === "dashed" ? dashSegments(run, metrics.dash, metrics.dashGap) : [[0, run]];
  for (const at of positionsAlongAxis) {
    if (at < 0 || at > 1) continue;
    for (const [start, length] of runs) {
      if (valueAxis === "y") {
        rects.push({
          x: -size.width / 2 + start,
          y: plotToWorldY(size, at) - half,
          width: length,
          height: metrics.grid,
        });
      } else {
        rects.push({
          x: plotToWorldX(size, at) - half,
          y: -size.height / 2 + start,
          width: metrics.grid,
          height: length,
        });
      }
    }
  }
  return rects;
}

/** A series' drawn points at a build state: each point rides from its baseline up to its value, so a cascade reads as a growth story rather than a pop. */
export function revealedPoints(
  points: readonly ChartPoint[],
  baseline: readonly ChartPoint[],
  grows: readonly number[],
): ChartPoint[] {
  return points.map((p, i) => {
    const b = baseline[i] ?? p;
    const g = grows[i] ?? 1;
    return { x: b.x + (p.x - b.x) * g, y: b.y + (p.y - b.y) * g };
  });
}

/** Flat XYZ triples for a polyline, ready for `LineGeometry.setPositions`. */
export function polylinePositions(
  points: readonly ChartPoint[],
  size: ChartSize,
  z: number,
): number[] {
  const out: number[] = [];
  for (const p of points) {
    out.push(plotToWorldX(size, p.x), plotToWorldY(size, p.y), z);
  }
  return out;
}

/** The closed polygon between a value curve and the boundary it fills to (the zero line, or the stack layer below). Linear sampling in v1: the curve is exactly the polyline the stroke draws. */
export function areaShape(
  points: readonly ChartPoint[],
  baseline: readonly ChartPoint[],
  size: ChartSize,
): Shape | null {
  if (points.length < 2) return null;
  const shape = new Shape();
  const [x0, y0] = plotPointToWorld(size, points[0]);
  shape.moveTo(x0, y0);
  for (let i = 1; i < points.length; i++) {
    const [x, y] = plotPointToWorld(size, points[i]);
    shape.lineTo(x, y);
  }
  for (let i = baseline.length - 1; i >= 0; i--) {
    const [x, y] = plotPointToWorld(size, baseline[i] ?? points[i]);
    shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/** A flat pie wedge (or donut segment) centred on the origin. d3 angles run clockwise from 12 o'clock, so they convert to the cartesian convention as `PI/2 - angle`. */
export function pieSliceShape(
  startAngle: number,
  endAngle: number,
  innerRadius: number,
  outerRadius: number,
  pad: number,
): Shape | null {
  const span = endAngle - startAngle;
  if (!(span > 0) || !(outerRadius > 0)) return null;
  const trim = span > pad ? pad / 2 : 0;
  const t0 = Math.PI / 2 - (startAngle + trim);
  const t1 = Math.PI / 2 - (endAngle - trim);
  const shape = new Shape();
  shape.absarc(0, 0, outerRadius, t0, t1, true);
  if (innerRadius > 0) shape.absarc(0, 0, innerRadius, t1, t0, false);
  else shape.lineTo(0, 0);
  shape.closePath();
  return shape;
}

/** A point on the pie at a d3 angle. */
export function pieRadial(angle: number, radius: number): [number, number] {
  return [Math.sin(angle) * radius, Math.cos(angle) * radius];
}

/** The SDF rounded-rect material behind every bar family: one `MeshBasicMaterial` (unlit, so a 2D chart reads as graphic design, not a lit object) patched to take per-instance half-extents, corner radius and colour, the `FrameChip.makePillMaterial` idiom. `iColour` carries alpha too, which is how one shared material still gives every bar its own build state. */
export interface ChartRectMaterial {
  material: MeshBasicMaterial;
  /** Edge softening, world units (about a pixel at the export resolution). */
  feather: { value: number };
}

export function makeChartRectMaterial(): ChartRectMaterial {
  const feather = { value: 0.001 };
  const material = new MeshBasicMaterial({ transparent: true, depthWrite: false });
  material.toneMapped = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFeather = feather;
    shader.vertexShader = `attribute vec2 iHalf;
attribute float iRadius;
attribute vec4 iColour;
varying vec2 vRectP;
varying vec2 vRectHalf;
varying float vRectRadius;
varying vec4 vRectColour;
${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
  vRectP = position.xy * iHalf * 2.0;
  vRectHalf = iHalf;
  vRectRadius = iRadius;
  vRectColour = iColour;`,
    );
    shader.fragmentShader = `uniform float uFeather;
varying vec2 vRectP;
varying vec2 vRectHalf;
varying float vRectRadius;
varying vec4 vRectColour;
${shader.fragmentShader}`
      .replace("#include <color_fragment>", "diffuseColor *= vRectColour;")
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
        float rectR = min(vRectRadius, min(vRectHalf.x, vRectHalf.y));
        vec2 rectQ = abs(vRectP) - vRectHalf + rectR;
        float rectD = length(max(rectQ, 0.0)) + min(max(rectQ.x, rectQ.y), 0.0) - rectR;
        gl_FragColor.a *= 1.0 - smoothstep(-uFeather, uFeather, rectD);`,
      );
  };
  material.customProgramCacheKey = () => "kookaburra-chart-rect-v1";
  return { material, feather };
}

const _colour = new Color();
const _srgb = { r: 0, g: 0, b: 0 };

/** The label token that reads on a given fill, by its sRGB luminance (the `FrameChip` contrast rule): value labels sitting inside a bar take the readable one. */
export function contrastPick(fill: string, onDarkFill: string, onLightFill: string): string {
  _colour.set(fill).getRGB(_srgb, SRGBColorSpace);
  const luminance = 0.2126 * _srgb.r + 0.7152 * _srgb.g + 0.0722 * _srgb.b;
  return luminance > 0.55 ? onLightFill : onDarkFill;
}

/** Corner radius for one mark: `style.cornerRadius` is a fraction of half the bar's THICKNESS (its category-axis extent), capped so a short bar rounds into a lozenge rather than a blob. */
export function markCornerRadius(cornerRadius: number, thickness: number, length: number): number {
  const wanted = Math.max(0, Math.min(1, cornerRadius)) * (thickness / 2);
  return Math.min(wanted, thickness / 2, length / 2);
}

/** Row pitch as a multiple of the font size, shared by every stacked chart label. */
export const CHART_LINE_HEIGHT = 1.25;
/** Legend proportions, in font sizes: swatch diameter, swatch-to-label gap, entry-to-entry gap. */
export const LEGEND_SWATCH = 0.62;
export const LEGEND_SWATCH_GAP = 0.45;
export const LEGEND_ENTRY_GAP = 1.1;

export const legendEntryWidth = (label: string, fontSize: number): number =>
  fontSize * (LEGEND_SWATCH + LEGEND_SWATCH_GAP) + estimateTextWidth(label, fontSize);

/** Entries packed into rows that fit `maxWidth`; at least one entry lands on every row, so a legend can never vanish because its labels are long. */
export function packLegendRows<T extends { width: number }>(
  entries: readonly T[],
  maxWidth: number,
  gap: number,
): T[][] {
  const rows: T[][] = [];
  let row: T[] = [];
  let used = 0;
  for (const entry of entries) {
    const advance = row.length === 0 ? entry.width : gap + entry.width;
    if (row.length > 0 && used + advance > maxWidth) {
      rows.push(row);
      row = [entry];
      used = entry.width;
    } else {
      row.push(entry);
      used += advance;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/** The world-unit thickness of each furniture band, all measured OUTWARD from the plot edge and all zero when that piece is off. One source for both the renderer (where it draws) and the mount (how much room to reserve). */
export interface Chart2DBands {
  /** Value-axis tick labels. */
  tick: number;
  /** Category labels. */
  category: number;
  valueName: number;
  categoryName: number;
  /** Legend block thickness across its flow, and its width when trailing. */
  legend: number;
  legendWidth: number;
  legendRows: number;
}

/** The legend's entries in draw order: series names, or slice names for a pie. */
export function legendLabels(chart: ChartConfig, layout: ChartLayout): string[] {
  if (layout.type === "pie") return layout.category.bands.map((b) => b.label);
  return chart.data.series.map((s) => s.name);
}

/** Furniture band sizes from the same constants the renderer draws with. Label widths are ESTIMATED (`CHART_GLYPH_ADVANCE`), never measured: a pure function keeps the plot rect free of a troika settling race. */
export function chart2dBands(
  chart: ChartConfig,
  layout: ChartLayout,
  size: ChartSize,
  look: Chart2DAppearance = CHART_2D_APPEARANCE,
): Chart2DBands {
  const m = chart2dMetrics(size, look);
  const vertical = layout.valueAxis === "y";
  const pie = layout.type === "pie";
  const tickWidth =
    layout.value.labels && !pie
      ? layout.value.ticks.reduce(
          (w, t) =>
            Math.max(
              w,
              estimateTextWidth(formatChartValue(t.value, chart.axis.value.format), m.tick),
            ),
          0,
        )
      : 0;
  const categoryWidth = layout.category.labels
    ? layout.category.bands.reduce((w, b) => Math.max(w, estimateTextWidth(b.label, m.tick)), 0)
    : 0;

  const labels = chart.labels.legend.visible ? legendLabels(chart, layout) : [];
  const trailing = chart.labels.legend.position === "trailing";
  const widths = labels.map((label) => ({ width: legendEntryWidth(label, m.legend) }));
  const widest = widths.reduce((w, e) => Math.max(w, e.width), 0);
  const rows = trailing
    ? widths.length
    : packLegendRows(widths, size.width, m.legend * LEGEND_ENTRY_GAP).length;

  return {
    tick: pie || !layout.value.labels ? 0 : vertical ? tickWidth : m.tick * CHART_LINE_HEIGHT,
    category:
      !layout.category.labels || pie ? 0 : vertical ? m.tick * CHART_LINE_HEIGHT : categoryWidth,
    valueName: layout.value.name && !pie ? m.axisName * CHART_LINE_HEIGHT : 0,
    categoryName: layout.category.name && !pie ? m.axisName * CHART_LINE_HEIGHT : 0,
    legend: labels.length === 0 ? 0 : rows * m.legend * CHART_LINE_HEIGHT,
    legendWidth: trailing ? widest : 0,
    legendRows: labels.length === 0 ? 0 : rows,
  };
}

/** World-unit bands the axis furniture needs OUTSIDE the plot rect. The hero and panel mounts shrink their plot rect by these so tick labels and axis names never collide with the marks. */
export interface Chart2DInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A furniture band's full reach from the plot edge: its own thickness plus the gap before it, and nothing at all when the band is off. */
export const withGap = (thickness: number, gap: number): number =>
  thickness > 0 ? gap + thickness : 0;

/** How much room the furniture needs outside the plot rect, for the mount to subtract before it hands `size` to `Chart2D`. */
export function chart2dInsets(
  chart: ChartConfig,
  layout: ChartLayout,
  size: ChartSize,
  look: Chart2DAppearance = CHART_2D_APPEARANCE,
): Chart2DInsets {
  const m = chart2dMetrics(size, look);
  const bands = chart2dBands(chart, layout, size, look);
  const insets: Chart2DInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  if (layout.type === "pie") {
    const pad = m.gap + m.value * CHART_LINE_HEIGHT;
    insets.top = pad;
    insets.right = pad;
    insets.bottom = pad;
    insets.left = pad;
  } else {
    const valueSide = withGap(bands.tick, m.gap) + withGap(bands.valueName, m.gap);
    const categorySide = withGap(bands.category, m.gap) + withGap(bands.categoryName, m.gap);
    if (layout.valueAxis === "y") {
      insets.left = valueSide;
      insets.bottom = categorySide;
    } else {
      insets.bottom = valueSide;
      insets.left = categorySide;
    }
  }
  if (bands.legend > 0) {
    if (chart.labels.legend.position === "top") insets.top += m.gap + bands.legend;
    else if (chart.labels.legend.position === "trailing") {
      insets.right += m.gap + bands.legendWidth;
    } else insets.bottom += m.gap + bands.legend;
  }
  return insets;
}
