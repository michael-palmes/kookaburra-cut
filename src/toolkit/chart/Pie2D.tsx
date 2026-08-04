/** Flat pie and donut: one `ShapeGeometry` wedge per slice, built from the same d3 angles the 3D renderer extrudes, with `innerRadius` opening the donut and a fixed angular pad separating neighbours. A slice's build state scales it about the pie centre and multiplies its alpha (never the `drop` entrance: a pie has no value axis to fall along, and both `fall` presets degrade to `sweep` here); geometry rebuilds only when the angles move (a keyframed data morph), which is a handful of triangles. Colours index by CATEGORY here, since a pie is one series split into slices. */

import { useEffect, useMemo, useRef } from "react";
import { DoubleSide, ShapeGeometry } from "three";
import { useTheme } from "../../theme";
import {
  CHART_2D_ORDER,
  CHART_2D_Z_STEP,
  type Chart2DAppearance,
  type Chart2DMetrics,
  contrastPick,
  PIE_CURVE_SEGMENTS,
  pieRadial,
  pieSliceShape,
  pulseColour,
  pulseScale,
} from "./chart2dMath";
import { ChartLabel } from "./chartText";
import { formatChartValue } from "./format";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import { type ChartRevealSource, chartRevealFn } from "./revealSource";
import type { ChartLayout, ChartPieSlice, ChartValueLabels } from "./types";

/** Label radius as a fraction of the outer radius, by where the author wants the value. */
const LABEL_RADIUS = { above: 1.12, inside: 0.66, below: 1.12 } as const;
/** Category labels always sit outside, clear of the value labels. */
const CATEGORY_RADIUS = 1.26;

export interface Pie2DProps {
  layout: ChartLayout;
  colours: string[];
  metrics: Chart2DMetrics;
  look: Chart2DAppearance;
  labels: ChartValueLabels;
  reveal?: ChartRevealSource;
  opacity: number;
  z: number;
}

export function Pie2D(props: Pie2DProps) {
  const { layout, colours, metrics, look, labels, reveal, opacity, z } = props;
  const theme = useTheme();
  const at = chartRevealFn(reveal);
  const pie = layout.pie;
  const outer = metrics.pieOuter;
  const inner = outer * (pie?.innerRadius ?? 0);
  const slices = pie?.slices ?? [];
  // The angles ARE the geometry: keying on their values (not the array identity the layout hands over each frame) rebuilds during a data morph and holds the buffers on a settled pie.
  const angleKey = slices.map((s) => `${s.startAngle},${s.endAngle}`).join("|");
  const held = useRef(slices);
  held.current = slices;

  // biome-ignore lint/correctness/useExhaustiveDependencies: angleKey stands in for the slices; the array itself is a fresh identity each render
  const geometries = useMemo(() => {
    const built: (ShapeGeometry | null)[] = [];
    for (const slice of held.current) {
      const shape = pieSliceShape(slice.startAngle, slice.endAngle, inner, outer, look.pieGap);
      built.push(shape ? new ShapeGeometry(shape, PIE_CURVE_SEGMENTS) : null);
    }
    return built;
  }, [angleKey, inner, outer, look.pieGap]);
  useEffect(
    () => () => {
      for (const g of geometries) g?.dispose();
    },
    [geometries],
  );

  if (!pie) return null;

  return (
    <>
      {slices.map((slice, i) => {
        const geometry = geometries[i];
        if (!geometry) return null;
        const build = revealAt(at, slice.seriesIndex, slice.categoryIndex);
        return (
          <mesh
            key={slice.categoryIndex}
            geometry={geometry}
            // The pop scales about the pie centre, which the wedge geometry already sits on, so a pulse never shifts the layout.
            position={[0, 0, z + i * CHART_2D_Z_STEP]}
            scale={build.grow * pulseScale(build.pulse)}
            renderOrder={CHART_2D_ORDER.mark}
          >
            <meshBasicMaterial
              color={pulseColour(
                chartColourAt(colours, slice.categoryIndex, theme.colors.accent),
                build.pulse,
              )}
              transparent
              opacity={build.alpha * opacity}
              depthWrite={false}
              toneMapped={false}
              side={DoubleSide}
            />
          </mesh>
        );
      })}
      {layout.category.labels &&
        slices.map((slice) => (
          <SliceLabel
            key={slice.categoryIndex}
            slice={slice}
            text={layout.category.bands[slice.categoryIndex]?.label ?? ""}
            radius={outer * CATEGORY_RADIUS}
            fontSize={metrics.tick}
            colour={theme.colors.text}
            alpha={revealAt(at, slice.seriesIndex, slice.categoryIndex).alpha * opacity}
            z={z + slices.length * CHART_2D_Z_STEP}
          />
        ))}
      {labels.visible &&
        slices.map((slice) => {
          const build = revealAt(at, slice.seriesIndex, slice.categoryIndex);
          const value = labels.countUp ? slice.value * build.count : slice.value;
          return (
            <SliceLabel
              key={slice.categoryIndex}
              slice={slice}
              text={formatChartValue(value, labels.format)}
              radius={outer * LABEL_RADIUS[labels.location]}
              fontSize={metrics.value}
              colour={
                labels.location === "inside"
                  ? contrastPick(
                      chartColourAt(colours, slice.categoryIndex, theme.colors.accent),
                      theme.colors.text,
                      theme.colors.background,
                    )
                  : theme.colors.text
              }
              alpha={build.alpha * opacity}
              z={z + slices.length * CHART_2D_Z_STEP}
            />
          );
        })}
    </>
  );
}

/** One label parked on a slice's mid-angle, anchored away from the pie so it never overlaps the wedge it names. */
function SliceLabel(props: {
  slice: ChartPieSlice;
  text: string;
  radius: number;
  fontSize: number;
  colour: string;
  alpha: number;
  z: number;
}) {
  const { slice, text, radius, fontSize, colour, alpha, z } = props;
  if (slice.fraction <= 0) return null;
  const [x, y] = pieRadial(slice.midAngle, radius);
  const anchorX = Math.abs(x) < radius * 0.2 ? "center" : x > 0 ? "left" : "right";
  return (
    <ChartLabel
      text={text}
      position={[x, y, z]}
      fontSize={fontSize}
      colour={colour}
      anchorX={anchorX}
      alpha={alpha}
    />
  );
}
