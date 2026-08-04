/** Flat lines and areas. Strokes are `Line2` fat lines (`three/addons/lines`): `linewidth` in pixels with `worldUnits: false`, `alphaToCoverage` for MSAA edges, and the `resolution` uniform taken ONCE from the format's fixed pixel dimensions, never a resize listener, so a stroke is exactly the same fraction of the frame in preview and in export. Area fills are `ShapeGeometry` polygons between the value curve and the boundary below it (linear sampling in v1, so the fill and its stroke share vertices exactly), stacked layers stepped apart in z with explicit render order. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { CircleGeometry, DoubleSide, type InterleavedBufferAttribute, ShapeGeometry } from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { useTheme } from "../../theme";
import {
  areaShape,
  CHART_2D_ORDER,
  CHART_2D_Z_STEP,
  type Chart2DAppearance,
  type Chart2DMetrics,
  type ChartSize,
  plotPointToWorld,
  plotToWorldX,
  plotToWorldY,
  pointsKey,
  polylinePositions,
  revealedPoints,
} from "./chart2dMath";
import { ChartLabel } from "./chartText";
import { formatChartValue } from "./format";
import { chartColourAt } from "./palette";
import { meanAlpha, revealAt } from "./reveal";
import type { ChartLayout, ChartPoint, ChartRevealFn, ChartValueLabels } from "./types";

export interface Lines2DProps {
  layout: ChartLayout;
  colours: string[];
  size: ChartSize;
  metrics: Chart2DMetrics;
  look: Chart2DAppearance;
  labels: ChartValueLabels;
  reveal?: ChartRevealFn;
  opacity: number;
  /** The export frame in pixels: the `LineMaterial` resolution reference. */
  resolution: { width: number; height: number };
  /** Pixels per world unit at that resolution, for the stroke's pixel width. */
  pixelsPerUnit: number;
  z: number;
}

export function Lines2D(props: Lines2DProps) {
  const { layout, colours, size, metrics, look, labels, reveal, opacity, z } = props;
  const theme = useTheme();
  const filled = layout.type === "area" || layout.type === "stackedArea";
  const dot = useMemo(() => new CircleGeometry(1, 20), []);
  useEffect(() => () => dot.dispose(), [dot]);

  return (
    <>
      {layout.series.map((series) => {
        const grows = series.points.map(
          (p) => revealAt(reveal, series.seriesIndex, p.categoryIndex).grow,
        );
        const points = revealedPoints(series.points, series.baseline, grows);
        const colour = chartColourAt(colours, series.seriesIndex, theme.colors.accent);
        const alpha = meanAlpha(reveal, series.seriesIndex, series.points.length) * opacity;
        const layerZ = z + series.seriesIndex * CHART_2D_Z_STEP;
        return (
          <group key={series.seriesIndex}>
            {filled && (
              <AreaFill
                points={points}
                baseline={series.baseline}
                size={size}
                colour={colour}
                opacity={alpha * look.areaOpacity}
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
                z={layerZ + CHART_2D_Z_STEP / 2}
              />
            )}
            {look.points &&
              points.map((p, i) => (
                <mesh
                  key={series.points[i].categoryIndex}
                  geometry={dot}
                  position={[
                    plotToWorldX(size, p.x),
                    plotToWorldY(size, p.y),
                    layerZ + CHART_2D_Z_STEP,
                  ]}
                  scale={metrics.point}
                  renderOrder={CHART_2D_ORDER.mark}
                >
                  <meshBasicMaterial
                    color={colour}
                    transparent
                    opacity={alpha}
                    depthWrite={false}
                    toneMapped={false}
                  />
                </mesh>
              ))}
          </group>
        );
      })}
      {labels.visible && (
        <PointValueLabels
          layout={layout}
          size={size}
          metrics={metrics}
          labels={labels}
          reveal={reveal}
          opacity={opacity}
          z={z + layout.seriesCount * CHART_2D_Z_STEP}
        />
      )}
    </>
  );
}

/** The closed fill under a value curve. The polygon is keyed on its VERTEX VALUES, not array identity, so a settled chart holds one buffer while a data morph pays earcut over tens of vertices (deterministic for the same polygon). */
function AreaFill(props: {
  points: ChartPoint[];
  baseline: readonly ChartPoint[];
  size: ChartSize;
  colour: string;
  opacity: number;
  z: number;
}) {
  const { points, baseline, size, colour, opacity, z } = props;
  const key = `${pointsKey(points)}/${pointsKey(baseline)}`;
  const held = useRef(props);
  held.current = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands in for the vertices; the arrays are a fresh identity each render
  const geometry = useMemo(() => {
    const shape = areaShape(held.current.points, held.current.baseline, held.current.size);
    return shape ? new ShapeGeometry(shape) : null;
  }, [key, size.width, size.height]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh geometry={geometry} position={[0, 0, z]} renderOrder={CHART_2D_ORDER.fill}>
      <meshBasicMaterial
        color={colour}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
        side={DoubleSide}
      />
    </mesh>
  );
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
  z: number;
}) {
  const { points, size, colour, opacity, width, resolution, z } = props;
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
    const object = new Line2(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = CHART_2D_ORDER.mark;
    return object;
  }, [count]);
  useEffect(
    () => () => {
      line.geometry.dispose();
      line.material.dispose();
    },
    [line],
  );

  useLayoutEffect(() => {
    if (count < 2) return;
    writeSegments(line.geometry, polylinePositions(points, size, z));
    line.material.color.set(colour);
    line.material.opacity = opacity;
    line.material.linewidth = width;
    line.material.resolution.set(resolution.width, resolution.height);
  }, [count, colour, line, opacity, points, resolution, size, width, z]);

  if (count < 2) return null;
  return <primitive object={line} />;
}

function PointValueLabels(props: {
  layout: ChartLayout;
  size: ChartSize;
  metrics: Chart2DMetrics;
  labels: ChartValueLabels;
  reveal?: ChartRevealFn;
  opacity: number;
  z: number;
}) {
  const { layout, size, metrics, labels, reveal, opacity, z } = props;
  const theme = useTheme();
  const below = labels.location === "below";
  return (
    <>
      {layout.series.map((series) =>
        series.points.map((point, i) => {
          const build = revealAt(reveal, series.seriesIndex, point.categoryIndex);
          const base = series.baseline[i] ?? point;
          const at: ChartPoint = {
            x: base.x + (point.x - base.x) * build.grow,
            y: base.y + (point.y - base.y) * build.grow,
          };
          const [x, y] = plotPointToWorld(
            size,
            labels.location === "inside" ? midpoint(base, at) : at,
          );
          const value = labels.countUp ? point.value * build.grow : point.value;
          return (
            <ChartLabel
              key={`${series.seriesIndex}-${point.categoryIndex}`}
              text={formatChartValue(value, labels.format)}
              position={[x, below ? y - metrics.gap : y + metrics.gap, z]}
              fontSize={metrics.value}
              colour={theme.colors.text}
              anchorY={below ? "top" : "bottom"}
              alpha={build.alpha * opacity}
            />
          );
        }),
      )}
    </>
  );
}

const midpoint = (a: ChartPoint, b: ChartPoint): ChartPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
