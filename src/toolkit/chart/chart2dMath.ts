/** Flat-chart geometry and metrics: the pure half of the 2D renderer. Everything here is a function of (layout, plot size, appearance), never of the clock, so `Chart2D` can build its buffers in `useMemo` and know preview and export agree. The plot rect is CENTRED on the group origin: plot space 0..1 (x right, y up) maps to -size/2..+size/2, and axis furniture hangs outside it (see `chart2dInsets`). */

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DoubleSide,
  LinearFilter,
  MeshBasicMaterial,
  RGBAFormat,
  type ShaderMaterial,
  Shape,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  Vector3,
} from "three";
import { SHINE_AXIS, SHINE_HALF_W } from "../text/presets";
import { formatChartValue } from "./format";
import type {
  ChartAxisKey,
  ChartBarMark,
  ChartConfig,
  ChartGridlineStyle,
  ChartLayout,
  ChartPieSlice,
  ChartPoint,
  ChartStyleSurface,
  ChartStyleSurface2D,
  ChartValueLabelLocation,
} from "./types";

/** Coplanar layers step apart by this much in z, so a fill can never z-fight the stroke or gridline it sits against (a fixed geometric epsilon, never `polygonOffset`). */
export const CHART_2D_Z_STEP = 0.002;

/** Draw order beneath the marks and above them; explicit so the flat layers never depend on tree order alone. */
export const CHART_2D_ORDER = {
  grid: 0,
  fill: 1,
  mark: 2,
  pill: 3,
  label: 4,
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

/** What the flat metrics resolve from: the appearance fractions, plus the resolved surface's stroke-weight multiplier when one is passed (a bare `Chart2DAppearance` leaves every thickness alone). */
export type Chart2DLook = Chart2DAppearance & { strokeWidthScale?: number };

/** The appearance one flat chart actually draws with: the resolved surface's flat facet, then the scene's own `look` overrides, with the preset's `pieGapScale` folded into `pieGap` so every arc (flat and extruded) cuts the same gap. A fresh object, never the surface's own. */
export function chart2dLook(
  surface: ChartStyleSurface,
  look?: Partial<Chart2DAppearance>,
): ChartStyleSurface2D {
  const merged: ChartStyleSurface2D = { ...surface.twod, ...look };
  merged.pieGap *= Math.max(0, surface.pieGapScale);
  return merged;
}

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

export function chart2dMetrics(size: ChartSize, look: Chart2DLook): Chart2DMetrics {
  const short = Math.max(1e-6, Math.min(size.width, size.height));
  const tick = short * look.labelFraction;
  // Only THICKNESSES take the preset's stroke weight; dash lengths are a pattern, and gridline presence rides `gridStyleWeight` instead, so nothing multiplies twice.
  const weight = Number.isFinite(look.strokeWidthScale)
    ? Math.max(0, look.strokeWidthScale as number)
    : 1;
  return {
    tick,
    value: tick * look.valueScale,
    axisName: tick * look.axisNameScale,
    legend: tick * look.legendScale,
    gap: tick * look.gapScale,
    stroke: short * look.strokeFraction * weight,
    grid: short * look.gridFraction * weight,
    point: short * look.pointFraction * weight,
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

export function barSpan(
  mark: ChartBarMark,
  valueAxis: ChartAxisKey,
  grow: number,
  drop = 0,
): BarSpan {
  const lo = valueAxis === "y" ? mark.y : mark.x;
  const length = valueAxis === "y" ? mark.height : mark.width;
  // `base` is one of the mark's two value-axis edges, so the far edge mirrors it.
  const far = 2 * lo + length - mark.base;
  const end = mark.base + (far - mark.base) * grow;
  // The entrance displaces the whole span, so a falling mark keeps its size and its direction.
  const d = Number.isFinite(drop) ? drop : 0;
  return {
    lo: Math.min(mark.base, end) + d,
    size: Math.abs(end - mark.base),
    end: end + d,
    direction: far >= mark.base ? 1 : -1,
  };
}

/** Where a bar's value label sits at a build state: `along` the value axis (riding the growing end unless the block parked it at the base or inside), `across` the category axis, plus the outward `nudge` an "above" label takes and the direction it grew in. One rule for the flat and the 3D renderers, so a label never sits differently between dimensions. */
export interface BarLabelSpot {
  along: number;
  across: number;
  nudge: number;
  direction: number;
}

export function barLabelSpot(
  mark: ChartBarMark,
  valueAxis: ChartAxisKey,
  location: ChartValueLabelLocation,
  grow: number,
  outward: number,
  drop = 0,
): BarLabelSpot {
  const span = barSpan(mark, valueAxis, grow, drop);
  const base = mark.base + (Number.isFinite(drop) ? drop : 0);
  const along =
    location === "below" ? base : location === "inside" ? (base + span.end) / 2 : span.end;
  return {
    along,
    across: valueAxis === "y" ? mark.labelAnchor.x : mark.labelAnchor.y,
    nudge: location === "above" ? outward * span.direction : 0,
    direction: span.direction,
  };
}

/** Emphasis brightness at a `pulse` sample: a mark's colour is multiplied by this, so a pop reads as light rather than a layout shift. */
export const CHART_PULSE_LIFT = 0.18;
/** Scale pop at a full `pulse`, the house 2 to 6 percent bound; only radial marks (pie slices) take it. */
export const CHART_PULSE_POP = 0.05;

export const pulseGain = (pulse: number): number =>
  1 + CHART_PULSE_LIFT * (Number.isFinite(pulse) ? Math.min(1, Math.max(0, pulse)) : 0);

export const pulseScale = (pulse: number): number =>
  1 + CHART_PULSE_POP * (Number.isFinite(pulse) ? Math.min(1, Math.max(0, pulse)) : 0);

const _pulse = new Color();

/** A mark's colour under an emphasis pulse: the same linear gain the instanced writers apply, as a hex a JSX material can take. */
export function pulseColour(colour: string, pulse: number): string {
  if (!(pulse > 0)) return colour;
  return `#${_pulse.set(colour).multiplyScalar(pulseGain(pulse)).getHexString()}`;
}

/** Peak luminance lift under the shine band's centre: deliberately restrained, a gleam rather than a flash. */
export const CHART_SHINE_GAIN = 0.12;

/** The shine band's 0..1 strength at a projected coordinate `s`, for a mark whose projection spans -extent..+extent, at sweep position `u` (-1 is no band). The text motion pack's band, reused: it enters with its trailing edge on the low corner and leaves with its leading edge past the high one. */
export function chartShineAmount(s: number, extent: number, u: number): number {
  if (!(extent > 0) || !(u >= 0)) return 0;
  const band = SHINE_HALF_W * 2 * extent;
  const centre = -extent - band + (2 * extent + 2 * band) * Math.min(1, u);
  const t = Math.max(0, Math.min(1, 1 - Math.abs(s - centre) / band));
  return t * t * (3 - 2 * t);
}

/** The same band in GLSL, so the flat and the 3D bar materials sweep identically. */
export const CHART_SHINE_GLSL = /* glsl */ `
float chartShineAmount(float s, float extent, float u) {
  if (extent <= 0.0 || u < 0.0) return 0.0;
  float band = ${SHINE_HALF_W.toFixed(4)} * 2.0 * extent;
  float centre = -extent - band + (2.0 * extent + 2.0 * band) * min(1.0, u);
  float t = clamp(1.0 - abs(s - centre) / band, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}`;

/** The 45 degree sweep axis, matching the text pack's. */
export const CHART_SHINE_AXIS_GLSL = `vec2(${SHINE_AXIS[0].toFixed(8)}, ${SHINE_AXIS[1].toFixed(8)})`;

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

/** The baseline rule under `axisLine`, as a multiple of a gridline's thickness: a hair heavier, so the rule reads as the axis rather than as one more gridline. */
export const AXIS_LINE_WEIGHT = 1.6;

/** The rule along the CATEGORY axis at the value axis' zero, clamped into the plot when the domain excludes it. Null for a pie, which has no value axis to rule. */
export function axisLineRect(
  layout: ChartLayout,
  size: ChartSize,
  metrics: Chart2DMetrics,
): WorldRect | null {
  if (layout.type === "pie") return null;
  const at = Math.min(1, Math.max(0, layout.value.zero));
  const thickness = metrics.grid * AXIS_LINE_WEIGHT;
  if (layout.valueAxis === "y") {
    return {
      x: -size.width / 2,
      y: plotToWorldY(size, at) - thickness / 2,
      width: size.width,
      height: thickness,
    };
  }
  return {
    x: plotToWorldX(size, at) - thickness / 2,
    y: -size.height / 2,
    width: thickness,
    height: size.height,
  };
}

/** Value-label pill proportions, in font sizes: padding either side of the estimated text box, padding above and below, and the corner radius as a fraction of the pill height (0.5 is a capsule). */
export const LABEL_PILL = { padX: 0.42, padY: 0.26, radius: 0.5 } as const;
/** Legend chip proportions: padding either side of the entry, and its height in font sizes. */
export const LEGEND_CHIP = { padX: 0.5, height: 1.62 } as const;

/** The pill behind one label, from the same width ESTIMATE the bands are reserved with (no troika measure round trip, so a pill is a pure function of its inputs). The label's anchor point is `(x, y)`; the text box is one font size tall. */
export function labelPillRect(
  text: string,
  fontSize: number,
  x: number,
  y: number,
  anchorX: "left" | "center" | "right",
  anchorY: "top" | "middle" | "bottom",
): WorldRect {
  const padX = fontSize * LABEL_PILL.padX;
  const width = estimateTextWidth(text, fontSize) + 2 * padX;
  const height = fontSize * (1 + 2 * LABEL_PILL.padY);
  const left =
    anchorX === "left" ? x - padX : anchorX === "right" ? x + padX - width : x - width / 2;
  const centreY =
    anchorY === "middle" ? y : anchorY === "top" ? y - fontSize / 2 : y + fontSize / 2;
  return { x: left, y: centreY - height / 2, width, height };
}

/** The chip behind one legend entry (swatch and label together), anchored on the entry's left edge and vertical centre. */
export function legendChipRect(
  entryWidth: number,
  fontSize: number,
  x: number,
  y: number,
): WorldRect {
  const padX = fontSize * LEGEND_CHIP.padX;
  const height = fontSize * LEGEND_CHIP.height;
  return { x: x - padX, y: y - height / 2, width: entryWidth + 2 * padX, height };
}

/** One point ridden from its baseline towards its value at `grow`, then displaced by `drop` along the value axis (always y for the line families); the value labels place against exactly this. */
export function revealedPoint(
  point: ChartPoint,
  baseline: ChartPoint | undefined,
  grow: number,
  drop = 0,
): ChartPoint {
  const b = baseline ?? point;
  const g = Number.isFinite(grow) ? grow : 1;
  const d = Number.isFinite(drop) ? drop : 0;
  return { x: b.x + (point.x - b.x) * g, y: b.y + (point.y - b.y) * g + d };
}

/** A fill boundary displaced by the same per-point `drop` as the curve above it, so a falling area translates as one rigid band instead of stretching. Returns the ORIGINAL array when nothing is displaced, which keeps the fill's vertex key (and its buffers) unchanged on a settled chart. */
export function droppedBaseline(
  baseline: readonly ChartPoint[],
  drops: readonly number[],
): readonly ChartPoint[] {
  if (!drops.some((d) => d !== 0)) return baseline;
  return baseline.map((p, i) => ({ x: p.x, y: p.y + (drops[i] ?? 0) }));
}

/** A series' drawn points at a build state: each point rides from its baseline up to its value, so a cascade reads as a growth story rather than a pop. */
export function revealedPoints(
  points: readonly ChartPoint[],
  baseline: readonly ChartPoint[],
  grows: readonly number[],
  drops?: readonly number[],
): ChartPoint[] {
  return points.map((p, i) => revealedPoint(p, baseline[i], grows[i] ?? 1, drops?.[i] ?? 0));
}

/** Where the draw-on edge has reached across a point run, in plot space: the head walks from the first point's x to the last's, which are the band centres the sampler's `headX` reports. */
export function drawEdgeX(points: readonly ChartPoint[], draw: number): number {
  if (points.length === 0) return 1;
  const first = points[0].x;
  const last = points[points.length - 1].x;
  const d = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 1;
  return first + (last - first) * d;
}

/** The polyline's y at a plot-space x, linearly along the run (the glow head rides the line, never floats off it). Clamped to the end points outside the run. */
export function polylineYAt(points: readonly ChartPoint[], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (x <= b.x) {
      const span = b.x - a.x;
      return span > 0 ? a.y + ((b.y - a.y) * (x - a.x)) / span : b.y;
    }
  }
  return last.y;
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

/** A slice's DRAWN end angle at a build state: `grow` sweeps the arc out of its own start angle, so a pie irises open instead of scaling up. Clamped at the full arc, so an overshoot preset can never draw over its neighbour. */
export function pieSweepEnd(slice: ChartPieSlice, grow: number): number {
  const g = Number.isFinite(grow) ? Math.min(1, Math.max(0, grow)) : 1;
  return slice.startAngle + (slice.endAngle - slice.startAngle) * g;
}

/** The scale a swept slice takes: whatever `grow` overshoots past a full sweep, times the emphasis pop, so `bloom` keeps its bloom on top of the sweep. */
export function pieSweepScale(grow: number, pulse: number): number {
  const g = Number.isFinite(grow) ? Math.max(1, grow) : 1;
  return g * pulseScale(pulse);
}

/** A signature of the drawn arcs, so a pie's geometry rebuilds while its sweep (or a data morph) moves the angles and rests the moment they settle. */
export function pieSweepKey(angles: readonly [number, number][]): string {
  return angles.map(([a, b]) => `${a},${b}`).join("|");
}

/** The SDF rounded-rect material behind every bar family: one `MeshBasicMaterial` (unlit, so a 2D chart reads as graphic design, not a lit object) patched to take per-instance half-extents, corner radius, colour and shine sweep, the `FrameChip.makePillMaterial` idiom. `iColour` carries alpha too, and `iShine` the band position, which is how one shared material still gives every bar its own build state. */
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
attribute float iShine;
varying vec2 vRectP;
varying vec2 vRectHalf;
varying float vRectRadius;
varying vec4 vRectColour;
varying float vRectShine;
${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
  vRectP = position.xy * iHalf * 2.0;
  vRectHalf = iHalf;
  vRectRadius = iRadius;
  vRectColour = iColour;
  vRectShine = iShine;`,
    );
    shader.fragmentShader = `uniform float uFeather;
varying vec2 vRectP;
varying vec2 vRectHalf;
varying float vRectRadius;
varying vec4 vRectColour;
varying float vRectShine;
${CHART_SHINE_GLSL}
${shader.fragmentShader}`
      .replace("#include <color_fragment>", "diffuseColor *= vRectColour;")
      .replace(
        "#include <opaque_fragment>",
        `#include <opaque_fragment>
        float rectR = min(vRectRadius, min(vRectHalf.x, vRectHalf.y));
        vec2 rectQ = abs(vRectP) - vRectHalf + rectR;
        float rectD = length(max(rectQ, 0.0)) + min(max(rectQ.x, rectQ.y), 0.0) - rectR;
        gl_FragColor.a *= 1.0 - smoothstep(-uFeather, uFeather, rectD);
        vec2 rectAxis = ${CHART_SHINE_AXIS_GLSL};
        float rectExtent = dot(abs(vRectHalf), abs(rectAxis));
        gl_FragColor.rgb *= 1.0 + ${CHART_SHINE_GAIN.toFixed(
          4,
        )} * chartShineAmount(dot(vRectP, rectAxis), rectExtent, vRectShine);`,
      );
  };
  material.customProgramCacheKey = () => "kookaburra-chart-rect-v2";
  return { material, feather };
}

/** Rows in a fill's vertical ramp: enough for a smooth blend under linear filtering, small enough to raster in a frame. */
export const CHART_RAMP_ROWS = 64;

/** #rrggbb to raw sRGB bytes; NOT three's `Color`, which converts to the linear working space. */
function hexBytes(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** A vertical ramp texture from `chartGradientRamp`'s stops (base at v 0, the value curve at v 1), rasterised in pure JS so it is bit-identical on any machine and written ONCE per colour set: the `gradientTexture` idiom, one pixel wide. Stops interpolate per channel in sRGB bytes; the perceptual work already happened in OKLCH when the stops were mixed. */
export function chartRampTexture(stops: readonly (readonly [string, number])[]): DataTexture {
  const sorted = [...stops]
    .sort((a, b) => a[1] - b[1])
    .map(([hex, pos]) => ({ rgb: hexBytes(hex), pos }));
  const rows = CHART_RAMP_ROWS;
  const data = new Uint8Array(rows * 4);
  for (let row = 0; row < rows; row++) {
    const t = row / (rows - 1);
    let lo = sorted[0];
    let hi = sorted[sorted.length - 1];
    for (let s = 0; s < sorted.length - 1; s++) {
      if (t >= sorted[s].pos && t <= sorted[s + 1].pos) {
        lo = sorted[s];
        hi = sorted[s + 1];
        break;
      }
    }
    const span = hi.pos - lo.pos;
    const k = span > 0 ? Math.min(1, Math.max(0, (t - lo.pos) / span)) : 0;
    const i = row * 4;
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(lo.rgb[c] + (hi.rgb[c] - lo.rgb[c]) * k);
    data[i + 3] = 255;
  }
  const texture = new DataTexture(data, 1, rows, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A draw-on clip plus a glow head, in the ONE form both flat line layers take: `clip` is (edge x in the group's local units, feather half-width, enabled) and `head` is (head x, inverse half-width, enabled), with `headColour` the accent tint the band adds. Both are uniform writes: a build-in never rebuilds a fill or a stroke. */
export interface ChartDrawUniforms {
  clip: { value: Vector3 };
  head: { value: Vector3 };
  headColour: { value: Color };
}

export const makeChartDrawUniforms = (): ChartDrawUniforms => ({
  clip: { value: new Vector3(0, 1, 0) },
  head: { value: new Vector3(0, 1, 0) },
  headColour: { value: new Color(0, 0, 0) },
});

const CLIP_FRAGMENT_DEFS = /* glsl */ `
uniform vec3 uChartClip;
varying float vChartX;`;

const clipAlpha = (target: string): string => /* glsl */ `
  if (uChartClip.z > 0.5) {
    ${target} *= 1.0 - smoothstep(-uChartClip.y, uChartClip.y, vChartX - uChartClip.x);
  }`;

/** The area fill's uniforms: the draw clip and glow head every flat line layer shares, plus the vertical ramp under `areaGradient` (`span` is (plot base y, 1 / plot height, enabled), so the ramp runs over the PLOT rather than each fill's own moving extent, and a build never re-rasters it). */
export interface ChartFillUniforms extends ChartDrawUniforms {
  ramp: { value: Texture | null };
  rampSpan: { value: Vector3 };
}

/** The area fill's material: unlit like the gridlines, with the same x clip its stroke takes so a fill can never lead or trail the line it sits under, and an optional vertical ramp that replaces the flat series colour. */
export function makeChartFillMaterial(): {
  material: MeshBasicMaterial;
  uniforms: ChartFillUniforms;
} {
  const uniforms: ChartFillUniforms = {
    ...makeChartDrawUniforms(),
    ramp: { value: null },
    rampSpan: { value: new Vector3(0, 1, 0) },
  };
  const material = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  });
  material.toneMapped = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uChartClip = uniforms.clip;
    shader.uniforms.uChartRamp = uniforms.ramp;
    shader.uniforms.uChartRampSpan = uniforms.rampSpan;
    shader.vertexShader = `varying float vChartX;
varying float vChartY;
${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vChartX = transformed.x;\n  vChartY = transformed.y;",
    );
    shader.fragmentShader = `${CLIP_FRAGMENT_DEFS}
uniform sampler2D uChartRamp;
uniform vec3 uChartRampSpan;
varying float vChartY;
${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      `#include <opaque_fragment>
  if (uChartRampSpan.z > 0.5) {
    float rampT = clamp((vChartY - uChartRampSpan.x) * uChartRampSpan.y, 0.0, 1.0);
    gl_FragColor.rgb = texture2D(uChartRamp, vec2(0.5, rampT)).rgb;
  }${clipAlpha("gl_FragColor.a")}`,
    );
  };
  material.customProgramCacheKey = () => "kookaburra-chart-fill-v2";
  return { material, uniforms };
}

/** Patch a `LineMaterial` (a `ShaderMaterial`, so its own source is patched rather than three's includes) with the draw clip and the glow head. `vChartX` takes the segment END POINT's object-space x, which interpolates along the segment, so the edge is the polyline's own x and never a screen-space guess. */
export function patchChartLineMaterial(material: ShaderMaterial): ChartDrawUniforms {
  const uniforms = makeChartDrawUniforms();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uChartClip = uniforms.clip;
    shader.uniforms.uChartHead = uniforms.head;
    shader.uniforms.uChartHeadColour = uniforms.headColour;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <clipping_planes_pars_vertex>",
        "#include <clipping_planes_pars_vertex>\nvarying float vChartX;",
      )
      .replace(
        "float aspect = resolution.x / resolution.y;",
        `vChartX = ( position.y < 0.5 ) ? instanceStart.x : instanceEnd.x;
			float aspect = resolution.x / resolution.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <clipping_planes_pars_fragment>",
        `#include <clipping_planes_pars_fragment>
uniform vec3 uChartHead;
uniform vec3 uChartHeadColour;
${CLIP_FRAGMENT_DEFS}`,
      )
      .replace(
        "gl_FragColor = vec4( diffuseColor.rgb, alpha );",
        `vec3 chartRgb = diffuseColor.rgb;
			if (uChartHead.z > 0.5) {
				float chartG = clamp(1.0 - abs(vChartX - uChartHead.x) * uChartHead.y, 0.0, 1.0);
				chartRgb += uChartHeadColour * (chartG * chartG * (3.0 - 2.0 * chartG));
			}${clipAlpha("alpha")}
			gl_FragColor = vec4( chartRgb, alpha );`,
      );
  };
  material.customProgramCacheKey = () => "kookaburra-chart-line-v1";
  return uniforms;
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
  look: Chart2DLook = CHART_2D_APPEARANCE,
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
  look: Chart2DLook = CHART_2D_APPEARANCE,
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
