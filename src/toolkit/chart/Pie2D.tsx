/** Flat pie and donut: one `ShapeGeometry` wedge per slice, built from the same d3 angles the 3D renderer extrudes, with `innerRadius` opening the donut and a fixed angular pad separating neighbours. A slice's build state SWEEPS it: `grow` drives the drawn end angle, so the pie irises open out of each slice's own start (the Keynote reveal) rather than scaling up, and whatever an overshoot preset pushes past a full sweep rides the pop scale instead, which is how `bloom` keeps its bloom. Geometry rebuilds only while the drawn angles move (the sweep window, or a keyframed data morph) and rests the moment they settle, which is a handful of triangles either way. Colours index by CATEGORY here, since a pie is one series split into slices. */

import { useEffect, useMemo, useRef } from "react";
import { DoubleSide, ShapeGeometry } from "three";
import { useTheme } from "../../theme";
import {
  CHART_2D_ORDER,
  CHART_2D_Z_STEP,
  type Chart2DMetrics,
  type ChartValuePill,
  contrastPick,
  labelPillRect,
  PIE_CURVE_SEGMENTS,
  pieRadial,
  pieSliceShape,
  pieSweepEnd,
  pieSweepKey,
  pieSweepScale,
  pulseColour,
  type WorldRect,
} from "./chart2dMath";
import { ChartLabel, ChartPills } from "./chartText";
import { formatChartValue } from "./format";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import { type ChartRevealSource, chartRevealFn } from "./revealSource";
import type { ChartLayout, ChartPieSlice, ChartStyleSurface2D, ChartValueLabels } from "./types";

/** Label radius as a fraction of the outer radius, by where the author wants the value. */
const LABEL_RADIUS = { above: 1.12, inside: 0.66, below: 1.12 } as const;
/** Category labels always sit outside, clear of the value labels. */
const CATEGORY_RADIUS = 1.26;

export interface Pie2DProps {
  layout: ChartLayout;
  colours: string[];
  metrics: Chart2DMetrics;
  look: ChartStyleSurface2D;
  labels: ChartValueLabels;
  /** The chip behind every value label (the preset's pill or the block's background); null draws them bare. */
  pill: ChartValuePill | null;
  /** Value labels take the family's semibold face. */
  bold: boolean;
  reveal?: ChartRevealSource;
  opacity: number;
  /** SDF edge softening for the label pills, world units. */
  feather: number;
  z: number;
}

export function Pie2D(props: Pie2DProps) {
  const { layout, colours, metrics, look, labels, pill, bold, reveal, opacity, feather, z } = props;
  const theme = useTheme();
  const at = chartRevealFn(reveal);
  const pie = layout.pie;
  const outer = metrics.pieOuter;
  const inner = outer * (pie?.innerRadius ?? 0);
  const slices = pie?.slices ?? [];
  // The DRAWN arcs are the geometry: keying on their values (not the array identity the layout hands over each frame) rebuilds through the sweep and holds the buffers once it lands.
  const arcs = slices.map<[number, number]>((slice) => [
    slice.startAngle,
    pieSweepEnd(slice, revealAt(at, slice.seriesIndex, slice.categoryIndex).grow),
  ]);
  const arcKey = pieSweepKey(arcs);
  const held = useRef(arcs);
  held.current = arcs;

  // biome-ignore lint/correctness/useExhaustiveDependencies: arcKey stands in for the arcs; the array itself is a fresh identity each render
  const geometries = useMemo(() => {
    const built: (ShapeGeometry | null)[] = [];
    for (const [start, end] of held.current) {
      const shape = pieSliceShape(start, end, inner, outer, look.pieGap);
      built.push(shape ? new ShapeGeometry(shape, PIE_CURVE_SEGMENTS) : null);
    }
    return built;
  }, [arcKey, inner, outer, look.pieGap]);
  useEffect(
    () => () => {
      for (const g of geometries) g?.dispose();
    },
    [geometries],
  );

  const lift = labels.offsetY * metrics.value;
  const pills: WorldRect[] = [];
  const values = labels.visible
    ? slices.map((slice) => {
        const build = revealAt(at, slice.seriesIndex, slice.categoryIndex);
        const text = formatChartValue(
          labels.countUp ? slice.value * build.count : slice.value,
          labels.format,
        );
        const radius = outer * LABEL_RADIUS[labels.location];
        const [x, y] = pieRadial(slice.midAngle, radius);
        if (pill) {
          pills.push(
            labelPillRect(text, metrics.value, x, y + lift, sliceAnchorX(x, radius), "middle"),
          );
        }
        return { slice, text, alpha: build.alpha };
      })
    : [];

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
            scale={pieSweepScale(build.grow, build.pulse)}
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
      {pill && (
        <ChartPills
          rects={pills}
          radiusFraction={pill.radius}
          colour={pill.colour}
          weight={pill.opacity}
          opacity={opacity}
          alphas={values.map((value) => value.alpha)}
          feather={feather}
          z={z + slices.length * CHART_2D_Z_STEP - CHART_2D_Z_STEP / 2}
        />
      )}
      {values.map((value) => (
        <SliceLabel
          key={value.slice.categoryIndex}
          slice={value.slice}
          text={value.text}
          radius={outer * LABEL_RADIUS[labels.location]}
          lift={lift}
          fontSize={metrics.value}
          colour={
            labels.location === "inside" && !pill
              ? contrastPick(
                  chartColourAt(colours, value.slice.categoryIndex, theme.colors.accent),
                  theme.colors.text,
                  theme.colors.background,
                )
              : theme.colors.text
          }
          bold={bold}
          alpha={value.alpha * opacity}
          z={z + slices.length * CHART_2D_Z_STEP}
        />
      ))}
    </>
  );
}

/** A label parked on the pie's rim anchors away from the disc, except near the top and bottom where it centres. */
const sliceAnchorX = (x: number, radius: number): "left" | "center" | "right" =>
  Math.abs(x) < radius * 0.2 ? "center" : x > 0 ? "left" : "right";

/** One label parked on a slice's mid-angle, anchored away from the pie so it never overlaps the wedge it names. */
function SliceLabel(props: {
  slice: ChartPieSlice;
  text: string;
  radius: number;
  fontSize: number;
  colour: string;
  alpha: number;
  bold?: boolean;
  /** Vertical nudge, world units; the value labels' own, never the category ring's. */
  lift?: number;
  z: number;
}) {
  const { slice, text, radius, fontSize, colour, alpha, bold = false, lift = 0, z } = props;
  if (slice.fraction <= 0) return null;
  const [x, y] = pieRadial(slice.midAngle, radius);
  return (
    <ChartLabel
      text={text}
      position={[x, y + lift, z]}
      fontSize={fontSize}
      colour={colour}
      anchorX={sliceAnchorX(x, radius)}
      bold={bold}
      alpha={alpha}
    />
  );
}
