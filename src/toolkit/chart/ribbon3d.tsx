/** 3D lines and areas: an extruded ribbon swept along the value curve, or the solid between that curve and its baseline (the zero line, or the stack layer below). Draw-on is a fragment X-clip against a progress uniform, so a build-in never rebuilds geometry; line and area families are always vertically oriented, so the category axis is x and the clip runs left to right. */

import { useEffect, useLayoutEffect, useMemo } from "react";
import { MeshStandardMaterial } from "three";
import { buildAreaSolid, buildRibbonSolid, type ChartPoint2 } from "./geometry3d";
import { chartColourAt } from "./palette";
import { meanAlpha, revealAt } from "./reveal";
import { type Chart3DSpace, chartWorldX, chartWorldY } from "./space3d";
import type { ChartLayout, ChartRevealFn, ChartSeriesLayout } from "./types";

export interface Series3DProps {
  layout: ChartLayout;
  space: Chart3DSpace;
  /** Areas fill to their baseline; lines sweep a ribbon along the curve alone. */
  filled: boolean;
  colours: readonly string[];
  fallbackColour: string;
  reveal?: ChartRevealFn;
  opacity: number;
  shadows: boolean;
  roughness: number;
  metalness: number;
}

/** Line ribbon thickness as a fraction of the plot's short side. */
const LINE_THICKNESS_FRACTION = 0.02;
/** Keeps a fully grown series clear of the clip plane at the last fragment. */
const CLIP_MARGIN = 1e-3;

function clipMaterial(colour: string, roughness: number, metalness: number) {
  const uniform = { value: 0 };
  const material = new MeshStandardMaterial({ color: colour, roughness, metalness });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uChartClipX = uniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vChartX;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvChartX = transformed.x;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vChartX;\nuniform float uChartClipX;",
      )
      .replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\nif ( vChartX > uChartClipX ) discard;",
      );
  };
  material.customProgramCacheKey = () => "kookaburra-chart-clip-v1";
  return { material, uniform };
}

interface SeriesSolidProps {
  series: ChartSeriesLayout;
  space: Chart3DSpace;
  filled: boolean;
  colour: string;
  /** 0..1 draw-on across the category axis. */
  progress: number;
  alpha: number;
  yOffset: number;
  shadows: boolean;
  roughness: number;
  metalness: number;
}

/** A stable signature for a polyline: the geometry rebuilds only when the actual coordinates move. */
const pointKey = (points: readonly { x: number; y: number }[]): string =>
  points.map((p) => `${p.x},${p.y}`).join("|");

function SeriesSolid(props: SeriesSolidProps) {
  const { series, space, filled, colour, progress, alpha, yOffset, shadows, roughness, metalness } =
    props;
  const topKey = pointKey(series.points);
  const baseKey = filled ? pointKey(series.baseline) : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: the point keys stand in for the layout arrays, which are a fresh identity every render
  const geometry = useMemo(() => {
    const top: ChartPoint2[] = series.points.map((p) => ({
      x: chartWorldX(space, p.x),
      y: chartWorldY(space, p.y),
    }));
    if (!filled) {
      return buildRibbonSolid(top, LINE_THICKNESS_FRACTION * space.unit, space.halfDepth);
    }
    const bottom: ChartPoint2[] = series.baseline.map((p) => ({
      x: chartWorldX(space, p.x),
      y: chartWorldY(space, p.y),
    }));
    return buildAreaSolid(top, bottom, space.halfDepth);
  }, [topKey, baseKey, filled, space, series.points, series.baseline]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const { material, uniform } = useMemo(
    () => clipMaterial(colour, roughness, metalness),
    [colour, roughness, metalness],
  );
  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    uniform.value = -space.width / 2 + progress * space.width + CLIP_MARGIN;
    material.opacity = alpha;
    const transparent = alpha < 1;
    if (material.transparent !== transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
  });

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, yOffset, 0]}
      castShadow={shadows}
      receiveShadow={shadows}
      frustumCulled={false}
    />
  );
}

export function Series3D(props: Series3DProps) {
  const {
    layout,
    space,
    filled,
    colours,
    fallbackColour,
    reveal,
    opacity,
    shadows,
    roughness,
    metalness,
  } = props;
  return (
    <>
      {layout.series.map((series) => {
        // The draw-on clip runs to the furthest-grown point of the series; the stroke's alpha is the mean across its points, the shared stroke rule.
        let progress = layout.categoryCount === 0 ? 1 : 0;
        for (let c = 0; c < layout.categoryCount; c++) {
          progress = Math.max(progress, revealAt(reveal, series.seriesIndex, c).grow);
        }
        return (
          <SeriesSolid
            key={series.seriesIndex}
            series={series}
            space={space}
            filled={filled}
            colour={chartColourAt(colours, series.seriesIndex, fallbackColour)}
            progress={progress}
            alpha={meanAlpha(reveal, series.seriesIndex, layout.categoryCount) * opacity}
            yOffset={layout.stacked ? series.seriesIndex * space.stackEpsilon : 0}
            shadows={shadows}
            roughness={roughness}
            metalness={metalness}
          />
        );
      })}
    </>
  );
}
