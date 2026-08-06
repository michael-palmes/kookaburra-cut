/** 3D pie and donut: the flat renderer's wedge shape (same d3 angles, same arc sampling, same gap) extruded with a subtle bevel. The disc stands upright in the XY plane and extrudes along z, the Keynote pose, and the HOST tips it with `style.rotation`. A slice's build state SWEEPS it, exactly as in the flat renderer: `grow` drives the drawn end angle, so the wedges iris open out of their own start angles, and whatever an overshoot preset pushes past a full sweep rides the pop scale. Geometry rebuilds while those angles move (the sweep window, or a keyframed data morph) and rests the moment they land, never on the `drop` entrance: a pie has no value axis to fall along, and both `fall` presets degrade to `sweep` here. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { type BufferGeometry, ExtrudeGeometry } from "three";
import {
  PIE_CURVE_SEGMENTS,
  pieSliceShape,
  pieSweepEnd,
  pieSweepKey,
  pieSweepScale,
  pulseColour,
} from "./chart2dMath";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import { type ChartRevealSource, chartRevealFn } from "./revealSource";
import type { Chart3DSpace } from "./space3d";
import { makeChartMaterial } from "./surface3d";
import type { ChartPieLayout, ChartStyleSurface3D } from "./types";

export interface Pie3DProps {
  pie: ChartPieLayout;
  space: Chart3DSpace;
  colours: readonly string[];
  fallbackColour: string;
  /** Angular gap between slices, radians, already under the preset's `pieGapScale`. */
  pieGap: number;
  reveal?: ChartRevealSource;
  opacity: number;
  shadows: boolean;
  finish: ChartStyleSurface3D;
}

/** Outer radius as a fraction of the plot's short side. */
export const PIE_RADIUS_FRACTION = 0.46;
const BEVEL_SEGMENTS = 2;
const BEVEL_DEPTH_FRACTION = 0.14;
const BEVEL_RADIUS_FRACTION = 0.03;

/** World radius of the disc; the label furniture reads it too. */
export const pieRadius = (space: Chart3DSpace): number => PIE_RADIUS_FRACTION * space.unit;

/** World centre of the disc: the plot's mid-height, on the group's z 0 plane. */
export const pieCentreY = (space: Chart3DSpace): number => space.height / 2;

export function Pie3D(props: Pie3DProps) {
  const { pie, space, colours, fallbackColour, pieGap, reveal, opacity, shadows, finish } = props;
  const at = chartRevealFn(reveal);
  const count = pie.slices.length;
  const outer = pieRadius(space);
  const inner = pie.innerRadius * outer;
  const arcs = pie.slices.map<[number, number]>((slice) => [
    slice.startAngle,
    pieSweepEnd(slice, revealAt(at, slice.seriesIndex, slice.categoryIndex).grow),
  ]);
  const arcKey = pieSweepKey(arcs);
  const held = useRef(arcs);
  held.current = arcs;

  // biome-ignore lint/correctness/useExhaustiveDependencies: arcKey stands in for the arcs, which are a fresh identity every render
  const geometries = useMemo(() => {
    const bevel =
      Math.min(space.depth * BEVEL_DEPTH_FRACTION, outer * BEVEL_RADIUS_FRACTION) *
      Math.max(0, finish.bevelScale);
    return held.current.map(([start, end]) => {
      const shape = pieSliceShape(start, end, inner, outer, pieGap);
      if (!shape) return null;
      const geometry = new ExtrudeGeometry(shape, {
        depth: Math.max(1e-4, space.depth),
        steps: 1,
        curveSegments: PIE_CURVE_SEGMENTS,
        bevelEnabled: bevel > 1e-5,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelOffset: 0,
        bevelSegments: BEVEL_SEGMENTS,
      });
      geometry.translate(0, 0, -space.depth / 2);
      return geometry;
    });
  }, [arcKey, inner, outer, pieGap, space.depth, finish.bevelScale]);
  useEffect(() => {
    return () => {
      for (const geometry of geometries) geometry?.dispose();
    };
  }, [geometries]);

  const materials = useMemo(
    () =>
      Array.from({ length: count }, () =>
        makeChartMaterial(finish, { cacheKey: "kookaburra-chart-pie-v1" }),
      ),
    [count, finish],
  );
  useEffect(() => {
    return () => {
      for (const material of materials) material.dispose();
    };
  }, [materials]);

  // Colour and alpha are per slice and change per frame; materials are never rebuilt for them.
  useLayoutEffect(() => {
    pie.slices.forEach((slice, i) => {
      const material = materials[i];
      if (!material) return;
      const build = revealAt(at, slice.seriesIndex, slice.categoryIndex);
      material.color.set(
        pulseColour(chartColourAt(colours, slice.categoryIndex, fallbackColour), build.pulse),
      );
      const alpha = build.alpha * opacity;
      material.opacity = alpha;
      const transparent = alpha < 1;
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
      }
    });
  });

  if (count === 0) return null;
  return (
    <group position={[0, pieCentreY(space), 0]}>
      {pie.slices.map((slice, i) => {
        const geometry: BufferGeometry | null = geometries[i];
        if (!geometry) return null;
        const build = revealAt(at, slice.seriesIndex, slice.categoryIndex);
        return (
          <mesh
            key={slice.categoryIndex}
            geometry={geometry}
            material={materials[i]}
            // The pop scales about the disc centre this group already sits on, so a pulse never shifts the layout.
            scale={pieSweepScale(build.grow, build.pulse)}
            castShadow={shadows}
            receiveShadow={shadows}
          />
        );
      })}
    </group>
  );
}
