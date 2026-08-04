/** Flat columns, bars and their stacked variants: one `InstancedMesh` of unit quads behind the SDF rounded-rect material, so a whole chart is a single draw call whatever its series count. Every per-instance write (matrix, half-extents, radius, colour) is imperative in a layout effect, never r3f JSX prop diffing (per-instance colour through the reconciler is a known upstream bug), and the write is a pure function of the layout plus the build state. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { useTheme } from "../../theme";
import {
  barSpan,
  CHART_2D_ORDER,
  type Chart2DMetrics,
  type ChartSize,
  contrastPick,
  makeChartRectMaterial,
  markCornerRadius,
  plotToWorldX,
  plotToWorldY,
} from "./chart2dMath";
import { ChartLabel } from "./chartText";
import { formatChartValue } from "./format";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import type { ChartLayout, ChartRevealFn, ChartValueLabels } from "./types";

const IDENTITY = new Quaternion();
const _matrix = new Matrix4();
const _position = new Vector3();
const _scale = new Vector3();
const _colour = new Color();

export interface Bars2DProps {
  layout: ChartLayout;
  colours: string[];
  size: ChartSize;
  metrics: Chart2DMetrics;
  /** `chart.style.cornerRadius`, 0..1 of half the bar thickness. */
  cornerRadius: number;
  labels: ChartValueLabels;
  reveal?: ChartRevealFn;
  opacity: number;
  /** SDF edge softening, world units. */
  feather: number;
  z: number;
}

export function Bars2D(props: Bars2DProps) {
  const { layout, colours, size, metrics, cornerRadius, labels, reveal, opacity, feather, z } =
    props;
  const bars = layout.bars;
  const count = bars.length;
  const mesh = useRef<InstancedMesh>(null);
  const accent = useTheme().colors.accent;

  const rect = useMemo(() => makeChartRectMaterial(), []);
  useEffect(() => () => rect.material.dispose(), [rect]);

  const geometry = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    const half = new InstancedBufferAttribute(new Float32Array(count * 2), 2);
    const radius = new InstancedBufferAttribute(new Float32Array(count), 1);
    const colour = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
    half.setUsage(DynamicDrawUsage);
    radius.setUsage(DynamicDrawUsage);
    colour.setUsage(DynamicDrawUsage);
    g.setAttribute("iHalf", half);
    g.setAttribute("iRadius", radius);
    g.setAttribute("iColour", colour);
    return g;
  }, [count]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  rect.feather.value = feather;

  useLayoutEffect(() => {
    const target = mesh.current;
    if (!target) return;
    const half = geometry.getAttribute("iHalf") as InstancedBufferAttribute;
    const radii = geometry.getAttribute("iRadius") as InstancedBufferAttribute;
    const colour = geometry.getAttribute("iColour") as InstancedBufferAttribute;
    const vertical = layout.valueAxis === "y";
    for (let i = 0; i < bars.length; i++) {
      const mark = bars[i];
      const build = revealAt(reveal, mark.seriesIndex, mark.categoryIndex);
      const span = barSpan(mark, layout.valueAxis, build.grow);
      const width = vertical ? mark.width * size.width : span.size * size.width;
      const height = vertical ? span.size * size.height : mark.height * size.height;
      const cx = vertical
        ? plotToWorldX(size, mark.x + mark.width / 2)
        : plotToWorldX(size, span.lo + span.size / 2);
      const cy = vertical
        ? plotToWorldY(size, span.lo + span.size / 2)
        : plotToWorldY(size, mark.y + mark.height / 2);
      _position.set(cx, cy, z);
      _scale.set(Math.max(width, 0), Math.max(height, 0), 1);
      _matrix.compose(_position, IDENTITY, _scale);
      target.setMatrixAt(i, _matrix);
      half.setXY(i, width / 2, height / 2);
      radii.setX(
        i,
        markCornerRadius(cornerRadius, vertical ? width : height, vertical ? height : width),
      );
      _colour.set(chartColourAt(colours, mark.seriesIndex, accent));
      colour.setXYZW(i, _colour.r, _colour.g, _colour.b, build.alpha * opacity);
    }
    target.instanceMatrix.needsUpdate = true;
    half.needsUpdate = true;
    radii.needsUpdate = true;
    colour.needsUpdate = true;
  }, [accent, bars, colours, cornerRadius, geometry, layout.valueAxis, opacity, reveal, size, z]);

  return (
    <>
      {count > 0 && (
        // Instance matrices change every frame; the geometry-derived bounding sphere would cull them.
        <instancedMesh
          key={count}
          ref={mesh}
          args={[geometry, rect.material, count]}
          frustumCulled={false}
          renderOrder={CHART_2D_ORDER.mark}
        />
      )}
      {labels.visible && (
        <BarValueLabels
          layout={layout}
          colours={colours}
          size={size}
          metrics={metrics}
          labels={labels}
          reveal={reveal}
          opacity={opacity}
          z={z}
        />
      )}
    </>
  );
}

function BarValueLabels(props: {
  layout: ChartLayout;
  colours: string[];
  size: ChartSize;
  metrics: Chart2DMetrics;
  labels: ChartValueLabels;
  reveal?: ChartRevealFn;
  opacity: number;
  z: number;
}) {
  const { layout, colours, size, metrics, labels, reveal, opacity, z } = props;
  const theme = useTheme();
  const vertical = layout.valueAxis === "y";
  const inside = labels.location === "inside";
  return (
    <>
      {layout.bars.map((mark) => {
        const build = revealAt(reveal, mark.seriesIndex, mark.categoryIndex);
        const span = barSpan(mark, layout.valueAxis, build.grow);
        const along =
          labels.location === "below" ? mark.base : inside ? (mark.base + span.end) / 2 : span.end;
        const across = vertical ? mark.labelAnchor.x : mark.labelAnchor.y;
        const nudge = labels.location === "above" ? metrics.gap * span.direction : 0;
        const fill = chartColourAt(colours, mark.seriesIndex, theme.colors.accent);
        const colour = inside
          ? contrastPick(fill, theme.colors.text, theme.colors.background)
          : theme.colors.text;
        const x = vertical ? plotToWorldX(size, across) : plotToWorldX(size, along) + nudge;
        const y = vertical ? plotToWorldY(size, along) + nudge : plotToWorldY(size, across);
        const outward = span.direction > 0;
        const anchorX = vertical || inside ? "center" : outward ? "left" : "right";
        const anchorY = !vertical || inside ? "middle" : outward ? "bottom" : "top";
        // A counting label rides its own build state, so it lands on exactly the printed static value (grow settles at 1).
        const value = labels.countUp ? mark.value * build.grow : mark.value;
        return (
          <ChartLabel
            key={`${mark.seriesIndex}-${mark.categoryIndex}`}
            text={formatChartValue(value, labels.format)}
            position={[x, y, z + 0.001]}
            fontSize={metrics.value}
            colour={colour}
            anchorX={anchorX}
            anchorY={anchorY}
            alpha={build.alpha * opacity}
          />
        );
      })}
    </>
  );
}
