/** 3D lines and areas: an extruded ribbon swept along the value curve, or the solid between that curve and its baseline (the zero line, or the stack layer below). The build channels are separate, exactly as in the flat renderer: `grow` rides each point up out of its baseline and `drop` displaces it and its fill boundary together (the solid rebuilds only when its coordinates actually move), while `draw` is a fragment X-clip against a uniform, so a draw-on never rebuilds geometry. Line and area families are always vertically oriented, so the category axis is x and the clip runs left to right. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Color } from "three";
import { drawEdgeX, droppedBaseline, revealedPoints } from "./chart2dMath";
import { buildAreaSolid, buildRibbonSolid, type ChartPoint2 } from "./geometry3d";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import { type ChartRevealSource, chartRevealFn, chartSeriesReveal } from "./revealSource";
import { type Chart3DSpace, chartWorldX, chartWorldY } from "./space3d";
import { makeChartMaterial } from "./surface3d";
import type { ChartLayout, ChartPoint, ChartStyleSurface3D } from "./types";

export interface Series3DProps {
  layout: ChartLayout;
  space: Chart3DSpace;
  /** Areas fill to their baseline; lines sweep a ribbon along the curve alone. */
  filled: boolean;
  colours: readonly string[];
  fallbackColour: string;
  reveal?: ChartRevealSource;
  opacity: number;
  shadows: boolean;
  finish: ChartStyleSurface3D;
}

/** Line ribbon thickness as a fraction of the plot's short side. */
const LINE_THICKNESS_FRACTION = 0.02;
/** Keeps a fully drawn series clear of the clip plane at the last fragment. */
const CLIP_MARGIN = 1e-3;
/** Glow-head half width as a fraction of the plot width, and its emissive gain: the flat renderer's dot has no 3D twin, so the solid brightens instead. */
const HEAD_WIDTH_FRACTION = 0.06;
const HEAD_GAIN = 0.5;

function clipMaterial(colour: string, finish: ChartStyleSurface3D) {
  const uniform = { value: 0 };
  const head = { value: new Color(0, 0, 0) };
  const headAt = { value: 0 };
  const headWidth = { value: 1 };
  const material = makeChartMaterial(finish, {
    colour,
    cacheKey: "kookaburra-chart-clip-v3",
    patch: (shader) => {
      shader.uniforms.uChartClipX = uniform;
      shader.uniforms.uChartHeadColour = head;
      shader.uniforms.uChartHeadX = headAt;
      shader.uniforms.uChartHeadWidth = headWidth;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying float vChartX;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvChartX = transformed.x;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying float vChartX;
uniform float uChartClipX;
uniform vec3 uChartHeadColour;
uniform float uChartHeadX;
uniform float uChartHeadWidth;`,
        )
        .replace(
          "#include <clipping_planes_fragment>",
          "#include <clipping_planes_fragment>\nif ( vChartX > uChartClipX ) discard;",
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
float chartG = clamp(1.0 - abs(vChartX - uChartHeadX) / uChartHeadWidth, 0.0, 1.0);
totalEmissiveRadiance += uChartHeadColour * (chartG * chartG * (3.0 - 2.0 * chartG));`,
        );
    },
  });
  return { material, uniform, head, headAt, headWidth };
}

interface SeriesSolidProps {
  points: ChartPoint[];
  baseline: readonly ChartPoint[];
  space: Chart3DSpace;
  filled: boolean;
  colour: string;
  /** Plot-space x the draw-on has reached, or null once the series is fully drawn. */
  drawX: number | null;
  /** Plot-space x of the glow head, or -1 for no head. */
  headX: number;
  headColour: string;
  alpha: number;
  yOffset: number;
  shadows: boolean;
  finish: ChartStyleSurface3D;
}

/** A stable signature for a polyline: the geometry rebuilds only when the actual coordinates move. */
const pointKey = (points: readonly { x: number; y: number }[]): string =>
  points.map((p) => `${p.x},${p.y}`).join("|");

function SeriesSolid(props: SeriesSolidProps) {
  const {
    points,
    baseline,
    space,
    filled,
    colour,
    drawX,
    headX,
    headColour,
    alpha,
    yOffset,
    shadows,
    finish,
  } = props;
  const topKey = pointKey(points);
  const baseKey = filled ? pointKey(baseline) : "";
  const held = useRef(props);
  held.current = props;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the point keys stand in for the layout arrays, which are a fresh identity every render
  const geometry = useMemo(() => {
    const top: ChartPoint2[] = held.current.points.map((p) => ({
      x: chartWorldX(space, p.x),
      y: chartWorldY(space, p.y),
    }));
    if (!filled) {
      return buildRibbonSolid(top, LINE_THICKNESS_FRACTION * space.unit, space.halfDepth);
    }
    const bottom: ChartPoint2[] = held.current.baseline.map((p) => ({
      x: chartWorldX(space, p.x),
      y: chartWorldY(space, p.y),
    }));
    return buildAreaSolid(top, bottom, space.halfDepth);
  }, [topKey, baseKey, filled, space]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const { material, uniform, head, headAt, headWidth } = useMemo(
    () => clipMaterial(colour, finish),
    [colour, finish],
  );
  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    uniform.value =
      drawX === null ? space.width : chartWorldX(space, drawX) + CLIP_MARGIN * space.unit;
    headAt.value = chartWorldX(space, headX);
    headWidth.value = Math.max(1e-5, HEAD_WIDTH_FRACTION * space.width);
    if (headX < 0) head.value.setRGB(0, 0, 0);
    else head.value.set(headColour).multiplyScalar(HEAD_GAIN);
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
  const { layout, space, filled, colours, fallbackColour, reveal, opacity, shadows, finish } =
    props;
  const at = chartRevealFn(reveal);
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
        const build = chartSeriesReveal(reveal, series.seriesIndex, layout.categoryCount);
        return (
          <SeriesSolid
            key={series.seriesIndex}
            points={points}
            baseline={droppedBaseline(series.baseline, drops)}
            space={space}
            filled={filled}
            colour={chartColourAt(colours, series.seriesIndex, fallbackColour)}
            drawX={build.draw >= 1 ? null : drawEdgeX(points, build.draw)}
            headX={build.headX}
            headColour={fallbackColour}
            alpha={build.alpha * opacity}
            yOffset={layout.stacked ? series.seriesIndex * space.stackEpsilon : 0}
            shadows={shadows}
            finish={finish}
          />
        );
      })}
    </>
  );
}
