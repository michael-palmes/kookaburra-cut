/** The chart host: one primitive a scene mounts bare (`<Chart />`) to draw its sidecar `chart` block, or with overrides to retype/restage it. It owns everything the renderers deliberately do not: the series palette, the fixed-scale layout composition (the track's upper envelope pins the value axis, the current scene-local sample supplies the marks), the build-in sampler (rebuilt every frame from the scene-local clock, so the instanced writers see a fresh identity and rewrite) and placement, which is the only thing that differs between the hero, staged and panel mounts. Flat charts lay out against `useFormat()`'s safe frame minus the bands their furniture needs (and minus the title band when the scene draws a headline); 3D charts stand at the content depth band under the presentation tilt, scaled so the tilted footprint still fits. Sidecar-driven, so a chart block renders with no scene TSX at all (`ChartFallback`). */

import { useEffect, useId, useMemo, useRef } from "react";
import type { Group } from "three";
import { useChartEditStore } from "../../engine/chartEditStore";
import { useFormat } from "../../engine/format";
import { useGizmoSectionOpen } from "../../engine/gizmoSections";
import { registerGizmoTarget, unregisterGizmoTarget } from "../../engine/gizmoTargetRegistry";
import { SceneGizmo } from "../../engine/SceneGizmo";
import { SceneOutline } from "../../engine/SceneOutline";
import type { ResolvedChart } from "../../engine/sceneChart";
import { useSceneContext } from "../../engine/sceneContext";
import { useSceneChart, useSceneDoc } from "../../engine/sceneDoc";
import { useTimeline } from "../../engine/timeline";
import { useTheme } from "../../theme";
import type { DevicePlacement } from "../device/Device";
import { LightRig } from "../lighting/LightRig";
import { useSceneStaged, useStageFloorY } from "../stage/context";
import { DEPTH_BANDS } from "../stage/DepthStage";
import { buildChartRevealSampler, type ChartRevealDims } from "./animation";
import { chart3dBelowStack } from "./axes3d";
import { Chart2D } from "./Chart2D";
import { Chart3D } from "./Chart3D";
import { type Chart2DAppearance, chart2dLook } from "./chart2dMath";
import {
  CHART_3D_STACK_PERSPECTIVE,
  CHART_STAGED_SIZE,
  type ChartRect,
  chartColours,
  chartEnterOffset,
  chartGroundY,
  chartHeroPose,
  chartHeroRect,
  chartLayoutAt,
  chartPose,
  chartScaleBounds,
  chartSettleMs,
  fitChart2d,
  fitChart3d,
} from "./mount";
import type { ChartRevealSource } from "./revealSource";
import { chart3dSpace } from "./space3d";
import { resolveChartStyle } from "./stylePresets";
import type {
  ChartDimension,
  ChartLayout,
  ChartMount,
  ChartStyleSurface,
  ChartType,
} from "./types";

const RAD2DEG = 180 / Math.PI;

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Overrides applied over the sidecar block; every field is optional, so `<Chart />` is the whole authoring surface for a sidecar-driven chart. */
export interface ChartProps {
  type?: ChartType;
  dimension?: ChartDimension;
  mount?: ChartMount;
  /** Staged mount only, `DevicePlacement` semantics. */
  placement?: DevicePlacement;
  /** Appearance overrides applied over the preset's flat facet, straight through to `Chart2D`. */
  look?: Partial<Chart2DAppearance>;
  /** Build state replacing the block's own build-in, a bare per-element lookup or a whole sampler; absent samples the sidecar's animation preset. */
  reveal?: ChartRevealSource;
  opacity?: number;
  /** Bundle the standard rig for a 3D chart (the `Device` contract): defaults true, or false under a lighting `<SceneStage>`; an explicit value wins. Inert for flat charts, which are unlit. */
  lit?: boolean;
}

export function Chart(props: ChartProps = {}) {
  const chart = useSceneChart();
  if (!chart) return null;
  return <MountedChart chart={chart} {...props} />;
}

export interface MountedChartProps extends ChartProps {
  chart: ResolvedChart;
  /** Panel mount only, supplied by `FramePanel`: the world rect (by centre) the overlay column hands the chart. A panel-mounted chart draws nowhere else, so without it the host renders nothing. */
  panel?: ChartRect;
}

/** The host proper, split from `Chart` so `ChartFallback` can draw a scene's chart WITHOUT calling `useSceneChart`, which would register it as its own consumer and cycle the fallback's render gate. */
export function MountedChart(props: MountedChartProps) {
  const {
    chart: base,
    type,
    dimension,
    mount,
    placement,
    look,
    reveal,
    opacity = 1,
    lit,
    panel,
  } = props;
  const theme = useTheme();
  const { localMs } = useTimeline();
  const staged = useSceneStaged();
  const doc = useSceneDoc();
  const chart = useMemo(
    () => mergeChart(base, { type, dimension, mount, placement }),
    [base, type, dimension, mount, placement],
  );
  // ONE resolved appearance for the whole chart: no renderer ever sees `style.preset`.
  const surface = useMemo(
    () => resolveChartStyle(chart.style.preset, chart.style, theme),
    [chart.style, theme],
  );
  const colours = useMemo(
    () => chartColours(chart, theme, surface.seriesLightnessStep),
    [chart, theme, surface.seriesLightnessStep],
  );
  const bounds = useMemo(() => chartScaleBounds(chart), [chart]);
  const layout = useMemo(() => chartLayoutAt(chart, localMs, bounds), [chart, localMs, bounds]);
  const { seriesCount, categoryCount } = layout;
  const dims = useMemo<ChartRevealDims>(
    () => ({ seriesCount, categoryCount, type: chart.type }),
    [seriesCount, categoryCount, chart.type],
  );
  const settleMs = useMemo(() => chartSettleMs(chart, dims), [chart, dims]);
  // Built during render, never memoised: the sampler must be a NEW identity every frame or the instanced writers keying on it stop rewriting. Past the settle it drops to null instead, so a finished chart's value-keyed geometry can rest.
  const sampler =
    reveal || localMs >= settleMs ? null : buildChartRevealSampler(chart.animation, dims, localMs);
  const mounted: MountArgs = {
    chart,
    layout,
    colours,
    surface,
    look,
    reveal: reveal ?? sampler ?? undefined,
    enter: chartEnterOffset(chart, dims, sampler),
    title: doc?.text?.title ?? "",
    opacity,
  };

  // The panel mount only draws inside an overlay panel, which hands it its slot; the parser already coerces it to 2d.
  if (chart.mount === "panel") return panel ? <PanelChart {...mounted} slot={panel} /> : null;
  return (
    <>
      {chart.dimension === "3d" && (lit ?? !staged) && <LightRig />}
      <ChartBody {...mounted} />
    </>
  );
}

function ChartBody(props: MountArgs) {
  if (props.chart.mount === "staged") return <StagedChart {...props} />;
  if (props.chart.dimension === "3d") return <Hero3D {...props} />;
  return <Hero2D {...props} />;
}

interface MountArgs {
  chart: ResolvedChart;
  layout: ChartLayout;
  colours: string[];
  /** The resolved appearance both renderers draw with. */
  surface: ChartStyleSurface;
  look: Partial<Chart2DAppearance> | undefined;
  reveal: ChartRevealSource | undefined;
  /** Whole-chart entrance offset, a signed fraction of the plot height. */
  enter: number;
  /** The scene document's headline, which a hero mount reserves a band for. */
  title: string;
  opacity: number;
}

/** Top-level overrides only: the data, style, axes and track always come from the resolved block. */
function mergeChart(base: ResolvedChart, o: ChartProps): ResolvedChart {
  if (!o.type && !o.dimension && !o.mount && !o.placement) return base;
  const mount = o.mount ?? base.mount;
  const chart: ResolvedChart = {
    ...base,
    type: o.type ?? base.type,
    mount,
    dimension: mount === "panel" ? "2d" : (o.dimension ?? base.dimension),
  };
  const placement = o.placement ?? base.placement;
  if (mount === "staged" && placement) chart.placement = placement;
  return chart;
}

/** Publish the hero chart's posed group and plot rect to the 2D gizmo registry, so the DOM layer can draw a box around it and a drag can invert through the live camera. A comparison's B side registers nothing: a write from there would land on the A doc. */
function useHeroGizmoTarget(
  group: { current: Group | null },
  size: { width: number; height: number },
  /** Plot centre in the posed group's own space, for a mount that lifts the plot below that group. */
  centreY = 0,
) {
  const ctx = useSceneContext();
  const sceneIndex = ctx?.index;
  const side = ctx?.side;
  const key = useId();
  const latest = useRef({ size, centreY });
  latest.current = { size, centreY };
  useEffect(() => {
    if (sceneIndex === undefined || side !== undefined) return;
    registerGizmoTarget(key, {
      domain: "chart",
      sceneIndex,
      itemId: "chart",
      node: () => group.current,
      localRect: () => {
        const { size: s, centreY: cy } = latest.current;
        return [-s.width / 2, cy - s.height / 2, s.width / 2, cy + s.height / 2];
      },
    });
    return () => unregisterGizmoTarget(key);
  }, [key, sceneIndex, side, group]);
}

/** Flat and frame-filling: the plot takes the safe frame minus the title band and the bands its own furniture reserves, and sits on the content plane so it reads as graphic design over whatever the scene stages. */
function Hero2D({
  chart,
  layout,
  colours,
  surface,
  look,
  reveal,
  enter,
  title,
  opacity,
}: MountArgs) {
  const format = useFormat();
  const theme = useTheme();
  const available = useMemo(() => chartHeroRect(format, theme, title), [format, theme, title]);
  // The bands are reserved with exactly the appearance the renderer draws with, preset and overrides alike.
  const appearance = useMemo(() => chart2dLook(surface, look), [surface, look]);
  const fit = useMemo(
    () => fitChart2d(chart, layout, available, appearance),
    [chart, layout, available, appearance],
  );
  const groupRef = useRef<Group>(null);
  useHeroGizmoTarget(groupRef, fit.size);
  return (
    <group
      ref={groupRef}
      position={[
        fit.centre[0] + chart.style.offset[0],
        fit.centre[1] + chart.style.offset[1] + enter * fit.size.height,
        DEPTH_BANDS.content,
      ]}
      scale={chart.style.scale}
    >
      <Chart2D
        chart={chart}
        layout={layout}
        colours={colours}
        size={fit.size}
        surface={surface}
        look={look}
        reveal={reveal}
        opacity={opacity}
      />
    </group>
  );
}

/** Standing at the content depth band under `style.rotation` (the Keynote presentation tilt), pivoting about the plot's centre and scaled so the tilted footprint fits the safe frame (less the title band) again. */
function Hero3D({ chart, layout, colours, surface, reveal, enter, title, opacity }: MountArgs) {
  const format = useFormat();
  const theme = useTheme();
  const available = useMemo(() => chartHeroRect(format, theme, title), [format, theme, title]);
  const fit = useMemo(() => {
    const size = { width: available.width, height: available.height };
    const space = chart3dSpace(chart.style.depth, size.width, size.height);
    const stack = chart3dBelowStack(chart, layout, space, surface.legendChrome);
    return fitChart3d(chart.style, available, {
      below: stack.depth * CHART_3D_STACK_PERSPECTIVE,
      top: stack.top * CHART_3D_STACK_PERSPECTIVE,
    });
  }, [chart, layout, surface.legendChrome, available]);
  const ground = chartHeroPose(fit, chart.style.scale, available);
  const groupRef = useRef<Group>(null);
  useHeroGizmoTarget(groupRef, fit.size, enter * fit.size.height);
  return (
    <group
      ref={groupRef}
      position={[
        available.x + chart.style.offset[0],
        ground.y + chart.style.offset[1],
        DEPTH_BANDS.content,
      ]}
      rotation={[fit.rotation[0], fit.rotation[1], 0]}
      scale={ground.scale}
    >
      <group position={[0, (enter - 0.5) * fit.size.height, 0]}>
        <Chart3D
          chart={chart}
          layout={layout}
          colours={colours}
          size={fit.size}
          surface={surface}
          reveal={reveal}
          opacity={opacity}
        />
      </group>
    </group>
  );
}

/** Inside an overlay panel's column: the band `FramePanel` measured out of the padded column, laid out by the same flat maths a hero chart uses (the furniture bands come out of the band, not the safe frame, and the panel's own text owns the title). The panel draws into the FULL frame, so `useFormat()` deliberately stays the real format and every pixel-derived stroke width and SDF feather holds. */
function PanelChart({
  chart,
  layout,
  colours,
  surface,
  look,
  reveal,
  enter,
  opacity,
  slot,
}: MountArgs & { slot: ChartRect }) {
  const appearance = useMemo(() => chart2dLook(surface, look), [surface, look]);
  const fit = useMemo(
    () => fitChart2d(chart, layout, slot, appearance),
    [chart, layout, slot, appearance],
  );
  return (
    <group position={[fit.centre[0], fit.centre[1] + enter * fit.size.height, 0]}>
      <Chart2D
        chart={chart}
        layout={layout}
        colours={colours}
        size={fit.size}
        surface={surface}
        look={look}
        reveal={reveal}
        opacity={opacity}
      />
    </group>
  );
}

/** Placed among the scene's devices and text: a fixed world-space plot under the block's `placement`, so a chart poses exactly like a `Device` does. While the inspector's position drill is open the staged-object gizmo attaches to the posed group (`chartEditStore`), and `exportPreamble` clears that selection, so exports render the bare transform. */
function StagedChart({ chart, layout, colours, surface, look, reveal, enter, opacity }: MountArgs) {
  const floorY = useStageFloorY();
  const ctx = useSceneContext();
  const sceneIndex = ctx?.index;
  // What a click selects, or null on a comparison's B side: it mounts the same chart at the same index, so a write from here would land on the A doc.
  const editTarget = sceneIndex !== undefined && ctx?.side === undefined ? { sceneIndex } : null;
  const selected = useChartEditStore((s) => s.selected);
  const gizmoMode = useChartEditStore((s) => s.gizmoMode);
  const sectionOpen = useGizmoSectionOpen("chart");
  const groupRef = useRef<Group>(null);
  const pose = chartPose(chart.placement);
  const y = chartGroundY(pose, floorY);
  const lift = enter * CHART_STAGED_SIZE.height;
  const gizmo =
    editTarget !== null &&
    sectionOpen &&
    selected !== null &&
    selected.sceneIndex === editTarget.sceneIndex;

  // The control mutates the group live; the commit reads it back, so the doc lands exactly what is on screen. A drag pins an explicit y, so `ground` drops.
  const commitDrag = () => {
    const group = groupRef.current;
    if (!group || sceneIndex === undefined) return;
    useChartEditStore.getState().requestCommit({
      sceneIndex,
      placement: {
        position: [
          round(group.position.x, 3),
          round(group.position.y, 3),
          round(group.position.z, 3),
        ],
        rotationDeg: [
          round(group.rotation.x * RAD2DEG, 1),
          round(group.rotation.y * RAD2DEG, 1),
          round(group.rotation.z * RAD2DEG, 1),
        ],
        scale: round(group.scale.x, 3),
      },
    });
  };

  // Uniform scale only (the staged-object rule): snap all three axes to the furthest-moved one.
  const uniformiseScale = () => {
    const group = groupRef.current;
    if (gizmoMode !== "scale" || !group || pose.scale <= 1e-6) return;
    let u = 1;
    for (const ratio of [
      group.scale.x / pose.scale,
      group.scale.y / pose.scale,
      group.scale.z / pose.scale,
    ]) {
      if (Math.abs(Math.log(Math.max(1e-3, Math.abs(ratio)))) > Math.abs(Math.log(Math.abs(u)))) {
        u = ratio;
      }
    }
    const next = Math.max(0.01 * pose.scale, Math.abs(u) * pose.scale);
    group.scale.set(next, next, next);
  };

  return (
    <>
      {gizmo && sceneIndex !== undefined && (
        <SceneGizmo
          object={groupRef}
          mode={gizmoMode}
          domain="chart"
          itemId="chart"
          sceneIndex={sceneIndex}
          onObjectChange={uniformiseScale}
          onMouseUp={commitDrag}
        />
      )}
      <group
        ref={groupRef}
        position={[pose.position[0], y, pose.position[2]]}
        rotation={pose.rotation}
        scale={pose.scale}
      >
        {chart.dimension === "3d" ? (
          // A 3D chart stands on its own floor at y 0, so it drops half a plot to centre on the pose.
          <group position={[0, lift - CHART_STAGED_SIZE.height / 2, 0]}>
            <Chart3D
              chart={chart}
              layout={layout}
              colours={colours}
              size={CHART_STAGED_SIZE}
              surface={surface}
              reveal={reveal}
              opacity={opacity}
            />
          </group>
        ) : (
          <group position={[0, lift, 0]}>
            <Chart2D
              chart={chart}
              layout={layout}
              colours={colours}
              size={CHART_STAGED_SIZE}
              surface={surface}
              look={look}
              reveal={reveal}
              opacity={opacity}
            />
          </group>
        )}
        {editTarget && (
          <SceneOutline
            size={[CHART_STAGED_SIZE.width, CHART_STAGED_SIZE.height, 0]}
            domain="chart"
            selected={gizmo}
            onSelect={() => useChartEditStore.getState().select(editTarget)}
          />
        )}
      </group>
    </>
  );
}
