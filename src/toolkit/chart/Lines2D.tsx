/** Flat lines and areas. Strokes are `Line2` fat lines (`three/addons/lines`): `linewidth` in pixels with `worldUnits: false`, `alphaToCoverage` for MSAA edges, and the `resolution` uniform taken ONCE from the format's fixed pixel dimensions, never a resize listener, so a stroke is exactly the same fraction of the frame in preview and in export. Area fills are `ShapeGeometry` polygons between the value curve and the boundary below it (linear sampling in v1, so the fill and its stroke share vertices exactly), stacked layers stepped apart in z with explicit render order. The build channels are separate: `grow` rides each point up out of its baseline and `drop` displaces it and its fill boundary together (both move vertices), while the series' `draw` is a UNIFORM x-clip both the stroke and its fill take, plus a glow head (an accent dot on the line and a brightness ramp in the stroke material) at the series' `headX`. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { CircleGeometry, type InterleavedBufferAttribute, ShapeGeometry } from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { useTheme } from "../../theme";
import {
  areaShape,
  CHART_2D_ORDER,
  CHART_2D_Z_STEP,
  type Chart2DMetrics,
  type ChartDrawUniforms,
  type ChartSize,
  chartRampTexture,
  drawEdgeX,
  droppedBaseline,
  LABEL_PILL,
  labelPillRect,
  makeChartFillMaterial,
  patchChartLineMaterial,
  plotPointToWorld,
  plotToWorldX,
  plotToWorldY,
  pointsKey,
  polylinePositions,
  polylineYAt,
  pulseColour,
  pulseGain,
  pulseScale,
  revealedPoint,
  revealedPoints,
  type WorldRect,
} from "./chart2dMath";
import { ChartLabel, ChartPills } from "./chartText";
import { formatChartValue } from "./format";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import { type ChartRevealSource, chartRevealFn, chartSeriesReveal } from "./revealSource";
import { chartGradientRamp } from "./stylePresets";
import type { ChartLayout, ChartPoint, ChartStyleSurface2D, ChartValueLabels } from "./types";

/** Glow-head sizes, in point radii: the dot itself, and how far the stroke brightens either side of the head. */
const HEAD_DOT = 1.7;
const HEAD_GLOW = 3.5;
/** Additive accent at the head's centre, on top of the series colour. */
const HEAD_GAIN = 0.35;

export interface Lines2DProps {
  layout: ChartLayout;
  colours: string[];
  size: ChartSize;
  metrics: Chart2DMetrics;
  look: ChartStyleSurface2D;
  labels: ChartValueLabels;
  /** Chip fill behind every value label under `labelPill`; null draws them bare. */
  pill: string | null;
  /** Value labels take the family's semibold face. */
  bold: boolean;
  reveal?: ChartRevealSource;
  opacity: number;
  /** The export frame in pixels: the `LineMaterial` resolution reference. */
  resolution: { width: number; height: number };
  /** Pixels per world unit at that resolution, for the stroke's pixel width. */
  pixelsPerUnit: number;
  /** SDF edge softening for the label pills, world units. */
  feather: number;
  z: number;
}

/** The draw-on edge and the glow head in the group's world units, or null when the series is settled (nothing clipped, no head). */
interface DrawState {
  clipX: number | null;
  head: { x: number; y: number; pulse: number } | null;
}

export function Lines2D(props: Lines2DProps) {
  const { layout, colours, size, metrics, look, labels, reveal, opacity, z } = props;
  const theme = useTheme();
  const at = chartRevealFn(reveal);
  const filled = layout.type === "area" || layout.type === "stackedArea";
  const dot = useMemo(() => new CircleGeometry(1, 20), []);
  useEffect(() => () => dot.dispose(), [dot]);

  return (
    <>
      {layout.series.map((series) => {
        const builds = series.points.map((p) => revealAt(at, series.seriesIndex, p.categoryIndex));
        const drops = builds.map((b) => b.drop);
        const points = revealedPoints(
          series.points,
          series.baseline,
          builds.map((b) => b.grow),
          drops,
        );
        // A falling series translates as one band, so its fill boundary drops with it; identity when nothing is falling, which keeps the fill's vertex key stable.
        const baseline = droppedBaseline(series.baseline, drops);
        const build = chartSeriesReveal(reveal, series.seriesIndex, series.points.length);
        const colour = chartColourAt(colours, series.seriesIndex, theme.colors.accent);
        const alpha = build.alpha * opacity;
        const layerZ = z + series.seriesIndex * CHART_2D_Z_STEP;
        const draw = drawState(points, build.draw, build.headX, size, (i) => builds[i]?.pulse ?? 0);
        return (
          <group key={series.seriesIndex}>
            {filled && (
              <AreaFill
                points={points}
                baseline={baseline}
                size={size}
                colour={colour}
                stops={look.areaGradient === "vertical" ? chartGradientRamp(theme, colour) : null}
                opacity={alpha * look.areaOpacity}
                clipX={draw.clipX}
                feather={metrics.grid}
                z={layerZ}
              />
            )}
            {(!filled || look.areaStroke) && (
              <LineStroke
                points={points}
                size={size}
                colour={colour}
                opacity={alpha}
                width={metrics.stroke * props.pixelsPerUnit}
                resolution={props.resolution}
                draw={draw}
                feather={metrics.grid}
                glow={metrics.point * HEAD_GLOW}
                accent={theme.colors.accent}
                z={layerZ + CHART_2D_Z_STEP / 2}
              />
            )}
            {points.map((p, i) => {
              const pulse = builds[i].pulse;
              // A chart without point dots still shows an emphasis pulse: the dot fades up with the envelope and leaves with it.
              if (!look.points && pulse <= 0) return null;
              return (
                <mesh
                  key={series.points[i].categoryIndex}
                  geometry={dot}
                  position={[
                    plotToWorldX(size, p.x),
                    plotToWorldY(size, p.y),
                    layerZ + CHART_2D_Z_STEP,
                  ]}
                  scale={metrics.point * pulseScale(pulse)}
                  renderOrder={CHART_2D_ORDER.mark}
                >
                  <meshBasicMaterial
                    color={pulseColour(colour, pulse)}
                    transparent
                    opacity={alpha * (look.points ? 1 : pulse)}
                    depthWrite={false}
                    toneMapped={false}
                  />
                </mesh>
              );
            })}
            {draw.head && (
              <mesh
                geometry={dot}
                position={[draw.head.x, draw.head.y, layerZ + CHART_2D_Z_STEP * 1.5]}
                scale={metrics.point * HEAD_DOT * pulseScale(draw.head.pulse)}
                renderOrder={CHART_2D_ORDER.mark}
              >
                <meshBasicMaterial
                  color={pulseColour(theme.colors.accent, draw.head.pulse)}
                  transparent
                  opacity={alpha}
                  depthWrite={false}
                  toneMapped={false}
                />
              </mesh>
            )}
          </group>
        );
      })}
      {labels.visible && (
        <PointValueLabels
          layout={layout}
          size={size}
          metrics={metrics}
          labels={labels}
          pill={props.pill}
          bold={props.bold}
          reveal={reveal}
          opacity={opacity}
          feather={props.feather}
          z={z + layout.seriesCount * CHART_2D_Z_STEP}
        />
      )}
    </>
  );
}

/** Where the draw-on has reached, in world units: the clip edge, and the head riding the line (with the emphasis pulse of the point it is passing). Both null once the series is fully drawn, so a preset without the draw channel pays nothing. */
function drawState(
  points: readonly ChartPoint[],
  draw: number,
  headX: number,
  size: ChartSize,
  pulseAt: (index: number) => number,
): DrawState {
  if (draw >= 1 || points.length < 2) return { clipX: null, head: null };
  const edge = drawEdgeX(points, draw);
  const head =
    headX < 0
      ? null
      : {
          x: plotToWorldX(size, headX),
          y: plotToWorldY(size, polylineYAt(points, headX)),
          pulse: pulseAt(Math.round(draw * (points.length - 1))),
        };
  return { clipX: plotToWorldX(size, edge), head };
}

/** The closed fill under a value curve. The polygon is keyed on its VERTEX VALUES, not array identity, so a settled chart holds one buffer while a data morph pays earcut over tens of vertices (deterministic for the same polygon). The draw-on is a uniform clip on the SAME edge the stroke takes, never a re-triangulation. Under `areaGradient` the flat colour gives way to a write-once ramp texture, sampled over the PLOT's height so stacked layers share one gradient rather than each restarting. */
function AreaFill(props: {
  points: ChartPoint[];
  baseline: readonly ChartPoint[];
  size: ChartSize;
  colour: string;
  /** Vertical ramp stops (base to curve), or null for a flat fill. */
  stops: readonly (readonly [string, number])[] | null;
  opacity: number;
  clipX: number | null;
  feather: number;
  z: number;
}) {
  const { points, baseline, size, colour, stops, opacity, clipX, feather, z } = props;
  const key = `${pointsKey(points)}/${pointsKey(baseline)}`;
  const held = useRef(props);
  held.current = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands in for the vertices; the arrays are a fresh identity each render
  const geometry = useMemo(() => {
    const shape = areaShape(held.current.points, held.current.baseline, held.current.size);
    return shape ? new ShapeGeometry(shape) : null;
  }, [key, size.width, size.height]);
  useEffect(() => () => geometry?.dispose(), [geometry]);

  const rampKey = stops ? stops.map(([hex, at]) => `${hex}@${at}`).join("|") : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the stop key stands in for the stops, which are a fresh array each render
  const ramp = useMemo(() => {
    const current = held.current.stops;
    return current ? chartRampTexture(current) : null;
  }, [rampKey]);
  useEffect(() => () => ramp?.dispose(), [ramp]);

  const fill = useMemo(() => makeChartFillMaterial(), []);
  useEffect(() => () => fill.material.dispose(), [fill]);
  fill.material.color.set(colour);
  fill.material.opacity = opacity;
  fill.uniforms.ramp.value = ramp;
  fill.uniforms.rampSpan.value.set(-size.height / 2, 1 / Math.max(1e-6, size.height), ramp ? 1 : 0);
  writeClip(fill.uniforms, clipX, feather);

  if (!geometry) return null;
  return (
    <mesh
      geometry={geometry}
      material={fill.material}
      position={[0, 0, z]}
      renderOrder={CHART_2D_ORDER.fill}
    />
  );
}

/** The clip uniform, off when the layer is settled. */
function writeClip(uniforms: ChartDrawUniforms, clipX: number | null, feather: number): void {
  uniforms.clip.value.set(clipX ?? 0, Math.max(1e-5, feather), clipX === null ? 0 : 1);
}

/** Write a polyline's world positions into a `LineGeometry`'s interleaved segment buffer in place: `setPositions` allocates fresh GPU buffers on every call, which a per-frame morph must not do. */
function writeSegments(geometry: LineGeometry, xyz: number[]): void {
  const attribute = geometry.getAttribute("instanceStart") as InterleavedBufferAttribute;
  const array = attribute.data.array as Float32Array;
  const segments = Math.max(0, xyz.length / 3 - 1);
  for (let i = 0; i < segments; i++) {
    const from = i * 3;
    const to = i * 6;
    array[to] = xyz[from];
    array[to + 1] = xyz[from + 1];
    array[to + 2] = xyz[from + 2];
    array[to + 3] = xyz[from + 3];
    array[to + 4] = xyz[from + 4];
    array[to + 5] = xyz[from + 5];
  }
  attribute.data.needsUpdate = true;
}

function LineStroke(props: {
  points: ChartPoint[];
  size: ChartSize;
  colour: string;
  opacity: number;
  /** Stroke width in pixels of the resolution reference. */
  width: number;
  resolution: { width: number; height: number };
  draw: DrawState;
  /** Clip edge softening and glow-head half width, world units. */
  feather: number;
  glow: number;
  accent: string;
  z: number;
}) {
  const { points, size, colour, opacity, width, resolution, draw, feather, glow, accent, z } =
    props;
  const count = points.length;

  const line = useMemo(() => {
    const geometry = new LineGeometry();
    geometry.setPositions(new Float32Array(Math.max(2, count) * 3));
    const material = new LineMaterial({
      worldUnits: false,
      alphaToCoverage: true,
      transparent: true,
      depthWrite: false,
    });
    const uniforms = patchChartLineMaterial(material);
    const object = new Line2(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = CHART_2D_ORDER.mark;
    return { object, uniforms };
  }, [count]);
  useEffect(
    () => () => {
      line.object.geometry.dispose();
      line.object.material.dispose();
    },
    [line],
  );

  useLayoutEffect(() => {
    if (count < 2) return;
    const material = line.object.material;
    writeSegments(line.object.geometry, polylinePositions(points, size, z));
    material.color.set(colour);
    material.opacity = opacity;
    material.linewidth = width;
    material.resolution.set(resolution.width, resolution.height);
    writeClip(line.uniforms, draw.clipX, feather);
    const head = draw.head;
    line.uniforms.head.value.set(head?.x ?? 0, 1 / Math.max(1e-5, glow), head ? 1 : 0);
    if (head) {
      line.uniforms.headColour.value.set(accent).multiplyScalar(HEAD_GAIN * pulseGain(head.pulse));
    }
  }, [
    accent,
    count,
    colour,
    draw,
    feather,
    glow,
    line,
    opacity,
    points,
    resolution,
    size,
    width,
    z,
  ]);

  if (count < 2) return null;
  return <primitive object={line.object} />;
}

function PointValueLabels(props: {
  layout: ChartLayout;
  size: ChartSize;
  metrics: Chart2DMetrics;
  labels: ChartValueLabels;
  pill: string | null;
  bold: boolean;
  reveal?: ChartRevealSource;
  opacity: number;
  feather: number;
  z: number;
}) {
  const { layout, size, metrics, labels, pill, bold, reveal, opacity, feather, z } = props;
  const theme = useTheme();
  const sample = chartRevealFn(reveal);
  const below = labels.location === "below";
  const anchorY = below ? "top" : "bottom";
  const pills: WorldRect[] = [];

  const drawn = layout.series.flatMap((series) =>
    series.points.map((point, i) => {
      const build = revealAt(sample, series.seriesIndex, point.categoryIndex);
      const base = revealedPoint(series.baseline[i] ?? point, undefined, 1, build.drop);
      const at = revealedPoint(point, series.baseline[i], build.grow, build.drop);
      const [x, y] = plotPointToWorld(size, labels.location === "inside" ? midpoint(base, at) : at);
      const value = labels.countUp ? point.value * build.count : point.value;
      const text = formatChartValue(value, labels.format);
      const labelY = below ? y - metrics.gap : y + metrics.gap;
      if (pill) pills.push(labelPillRect(text, metrics.value, x, labelY, "center", anchorY));
      return {
        key: `${series.seriesIndex}-${point.categoryIndex}`,
        text,
        x,
        y: labelY,
        alpha: build.alpha,
      };
    }),
  );

  return (
    <>
      {pill && (
        <ChartPills
          rects={pills}
          radiusFraction={LABEL_PILL.radius}
          colour={pill}
          opacity={opacity}
          alphas={drawn.map((label) => label.alpha)}
          feather={feather}
          z={z - CHART_2D_Z_STEP / 2}
        />
      )}
      {drawn.map((label) => (
        <ChartLabel
          key={label.key}
          text={label.text}
          position={[label.x, label.y, z]}
          fontSize={metrics.value}
          colour={theme.colors.text}
          anchorY={anchorY}
          bold={bold}
          alpha={label.alpha * opacity}
        />
      ))}
    </>
  );
}

const midpoint = (a: ChartPoint, b: ChartPoint): ChartPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
