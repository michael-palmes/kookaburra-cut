/** 3D pie and donut: the flat renderer's wedge shape (same d3 angles, same arc sampling) extruded with a subtle bevel, built ONCE at the final angles so a build-in never re-triangulates. The disc stands upright in the XY plane and extrudes along z, the Keynote pose, and the HOST tips it with `style.rotation`. Slice reveal is a scale about the pie centre plus alpha, never an angle rebuild. */

import { useEffect, useLayoutEffect, useMemo } from "react";
import { type BufferGeometry, ExtrudeGeometry, MeshStandardMaterial } from "three";
import { CHART_2D_APPEARANCE, PIE_CURVE_SEGMENTS, pieSliceShape } from "./chart2dMath";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import type { Chart3DSpace } from "./space3d";
import type { ChartPieLayout, ChartRevealFn } from "./types";

export interface Pie3DProps {
  pie: ChartPieLayout;
  space: Chart3DSpace;
  colours: readonly string[];
  fallbackColour: string;
  reveal?: ChartRevealFn;
  opacity: number;
  shadows: boolean;
  roughness: number;
  metalness: number;
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
  const { pie, space, colours, fallbackColour, reveal, opacity, shadows, roughness, metalness } =
    props;
  const count = pie.slices.length;
  const outer = pieRadius(space);
  const inner = pie.innerRadius * outer;
  const angles = pie.slices.map((s) => `${s.startAngle},${s.endAngle}`).join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: angles stands in for the slice list, which is a fresh identity every render
  const geometries = useMemo(() => {
    const bevel = Math.min(space.depth * BEVEL_DEPTH_FRACTION, outer * BEVEL_RADIUS_FRACTION);
    return pie.slices.map((slice) => {
      const shape = pieSliceShape(
        slice.startAngle,
        slice.endAngle,
        inner,
        outer,
        CHART_2D_APPEARANCE.pieGap,
      );
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
    // `angles` stands in for the slice list: same arcs, same triangulation.
  }, [angles, inner, outer, space.depth, pie.slices]);
  useEffect(() => {
    return () => {
      for (const geometry of geometries) geometry?.dispose();
    };
  }, [geometries]);

  const materials = useMemo(
    () => Array.from({ length: count }, () => new MeshStandardMaterial({ roughness, metalness })),
    [count, roughness, metalness],
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
      material.color.set(chartColourAt(colours, slice.categoryIndex, fallbackColour));
      const alpha = revealAt(reveal, slice.seriesIndex, slice.categoryIndex).alpha * opacity;
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
        return (
          <mesh
            key={slice.categoryIndex}
            geometry={geometry}
            material={materials[i]}
            scale={Math.max(1e-4, revealAt(reveal, slice.seriesIndex, slice.categoryIndex).grow)}
            castShadow={shadows}
            receiveShadow={shadows}
          />
        );
      })}
    </group>
  );
}
