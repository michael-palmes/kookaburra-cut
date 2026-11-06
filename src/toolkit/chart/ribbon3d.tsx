/** 3D lines and areas: an extruded ribbon swept along the value curve (or, under the light trail finish, a camera-facing glowing strip receding in depth, `Trail.tsx`), or the solid between that curve and its baseline (the zero line, or the stack layer below). The build channels are separate, exactly as in the flat renderer: `grow` rides each point up out of its baseline and `drop` displaces it and its fill boundary together (the solid rebuilds only when its coordinates actually move), while `draw` is a fragment X-clip against a uniform, so a draw-on never rebuilds geometry. Line and area families are always vertically oriented, so the category axis is x and the clip runs left to right. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Color } from "three";
import { drawEdgeX, revealedPoints } from "./chart2dMath";
import { buildAreaSolid, buildRibbonSolid, type ChartPoint2 } from "./geometry3d";
import { chartTrimRuns } from "./layout";
import { chartColourAt } from "./palette";
import { revealAt } from "./reveal";
import { type ChartRevealSource, chartRevealFn, chartSeriesReveal } from "./revealSource";
import { type Chart3DSpace, chartWorldX, chartWorldY } from "./space3d";
import { makeChartMaterial } from "./surface3d";
import { ChartSeriesTrail } from "./Trail";
import {
  CHART_TRAIL_FEATHER,
  CHART_TRAIL_RENDER_ORDER,
  chartTrailRuns,
  chartTrailTone,
  chartTrailZ,
} from "./trailMath";
import type { ChartLayout, ChartPoint, ChartStyleSurface3D } from "./types";

/** A line drawn as a light trail instead of a ribbon: its halo half width and depth travel in chart units, and the stage it glows (or inks) against. */
export interface Series3DTrail {
  reach: number;
  travel: number;
  background: string;
}

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
  /** Lines only: draw each run as a light trail; absent keeps the ribbon. */
  trail?: Series3DTrail | null;
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
  const trail = filled ? null : (props.trail ?? null);
  return (
    <>
      {layout.series.flatMap((series) => {
        const builds = series.points.map((p) => revealAt(at, series.seriesIndex, p.categoryIndex));
        const grows = builds.map((b) => b.grow);
        const drops = builds.map((b) => b.drop);
        const points = revealedPoints(series.points, series.baseline, grows, drops);
        const build = chartSeriesReveal(reveal, series.seriesIndex, layout.categoryCount);
        if (trail) {
          return [
            <ChartSeriesTrail
              key={`${series.seriesIndex}-trail`}
              points={points}
              runs={chartTrailRuns(series.points)}
              place={(p) => [
                chartWorldX(space, p.x),
                chartWorldY(space, p.y),
                chartTrailZ(p.x, trail.travel),
              ]}
              draw={build.draw}
              pulseAt={(i) => builds[i]?.pulse ?? 0}
              tone={chartTrailTone(
                chartColourAt(colours, series.seriesIndex, fallbackColour),
                trail.background,
              )}
              reach={trail.reach}
              flat={false}
              framePixels={0}
              feather={trail.reach * CHART_TRAIL_FEATHER}
              alpha={build.alpha * opacity}
              order={{ strip: CHART_TRAIL_RENDER_ORDER, head: CHART_TRAIL_RENDER_ORDER + 1 }}
              headLift={0}
            />,
          ];
        }
        // The fill boundary rides the same build out of the same origin, so a trimmed edge arrives with the curve above it and a falling series still translates as one band.
        const baseline = revealedPoints(series.fillBaseline, series.baseline, grows, drops);
        // An area is one solid between the two clamped curves; a line sweeps a ribbon along each run the trim left standing.
        const spans: [number, number][] = filled
          ? [[0, points.length]]
          : chartTrimRuns(series.points);
        const solid = {
          space,
          filled,
          colour: chartColourAt(colours, series.seriesIndex, fallbackColour),
          drawX: build.draw >= 1 ? null : drawEdgeX(points, build.draw),
          headX: build.headX,
          headColour: fallbackColour,
          alpha: build.alpha * opacity,
          yOffset: layout.stacked ? series.seriesIndex * space.stackEpsilon : 0,
          shadows,
          finish,
        };
        return spans.map(([from, to]) => (
          <SeriesSolid
            key={`${series.seriesIndex}-${from}`}
            points={points.slice(from, to)}
            baseline={baseline.slice(from, to)}
            {...solid}
          />
        ));
      })}
    </>
  );
}
