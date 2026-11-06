/** The light trail in the scene graph, one component for both renderers: a strip mesh per run the axis trim left standing, sharing one material, and a glowing head at the leading end (`trailMath.ts` holds the maths and the material). The caller maps plot space to its own local units (the flat plot rect, or 3D chart space with the trail's depth) and picks pixel or chart-unit widths. Uniforms are written from the build state on every commit, and a strip's buffers are rewritten in place only when its centres move, so a settled trail holds its buffers and a draw-on never touches geometry. */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ShaderMaterial } from "three";
import { drawEdgeX, pulseScale } from "./chart2dMath";
import {
  CHART_TRAIL_HEAD,
  CHART_TRAIL_MOVING,
  CHART_TRAIL_TAIL,
  type ChartTrailPoint,
  type ChartTrailState,
  type ChartTrailTone,
  chartTrailGains,
  chartTrailGeometry,
  chartTrailHeadQuad,
  chartTrailKey,
  chartTrailLead,
  chartTrailRampUniform,
  chartTrailStrip,
  makeChartTrailMaterial,
  writeChartTrailStrip,
  writeChartTrailUniforms,
} from "./trailMath";
import type { ChartPoint } from "./types";

export interface ChartSeriesTrailProps {
  /** The series' drawn points in plot space, and the runs `chartTrailRuns` keeps. */
  points: readonly ChartPoint[];
  runs: readonly (readonly [number, number])[];
  /** Plot space to the group's local units, depth included. */
  place: (p: ChartPoint) => ChartTrailPoint;
  /** The series' draw-on progress, and each point's emphasis pulse. */
  draw: number;
  pulseAt: (index: number) => number;
  tone: ChartTrailTone;
  /** Halo half width: export pixels when flat, chart units in 3D. */
  reach: number;
  /** Flat widens by pixels (a fixed fraction of the frame) among the transparent flat layers; 3D widens by chart units with the opaque marks. */
  flat: boolean;
  /** The export frame's pixel height; read only when flat. */
  framePixels: number;
  /** The draw-on clip's feather, local units. */
  feather: number;
  alpha: number;
  order: { strip: number; head: number };
  /** How far the head stands in front of the strip, local z. */
  headLift: number;
}

export function ChartSeriesTrail(props: ChartSeriesTrailProps) {
  const { points, runs, place, draw, pulseAt, tone, reach, flat, feather, alpha, order } = props;
  const strip = useMemo(() => makeChartTrailMaterial(tone.mode, flat), [tone.mode, flat]);
  const head = useMemo(() => makeChartTrailMaterial(tone.mode, flat), [tone.mode, flat]);
  useEffect(() => () => strip.material.dispose(), [strip]);
  useEffect(() => () => head.material.dispose(), [head]);
  const quad = useMemo(() => chartTrailGeometry(chartTrailHeadQuad()), []);
  useEffect(() => () => quad.dispose(), [quad]);

  const lead = chartTrailLead(points, runs, draw);
  const localX = (x: number): number => place({ x, y: 0 })[0];
  const edge = points.length > 0 ? drawEdgeX(points, draw) : 0;
  const tailX = points.length > 0 ? localX(points[0].x) : 0;
  const pulse = lead ? pulseAt(lead.index) : 0;
  const pixels = flat ? props.framePixels : 0;
  const shared = { tone, pixels, feather, alpha };
  const stripState: ChartTrailState = {
    ...shared,
    reach,
    gains: chartTrailGains(tone.mode, false),
    clipX: draw < 1 && points.length >= 2 ? localX(edge) : null,
    ramp: chartTrailRampUniform(tailX, localX(lead?.x ?? edge), CHART_TRAIL_TAIL),
  };
  const headState: ChartTrailState = {
    ...shared,
    reach: reach * CHART_TRAIL_HEAD.radius * pulseScale(pulse),
    gains: chartTrailGains(tone.mode, true, pulse),
    clipX: null,
    ramp: [0, 0, 1],
  };
  // Written on commit, like every other imperative chart write, so a discarded render can never reach the frame.
  useLayoutEffect(() => {
    writeChartTrailUniforms(strip.uniforms, stripState);
    writeChartTrailUniforms(head.uniforms, headState);
  });

  const at = lead && alpha > 0 ? place(lead) : null;
  return (
    <>
      {runs.map(([from, to]) => (
        <TrailRun
          key={from}
          points={points.slice(from, to).map(place)}
          material={strip.material}
          order={order.strip}
        />
      ))}
      {at && (
        <mesh
          geometry={quad}
          material={head.material}
          position={[at[0], at[1], at[2] + props.headLift]}
          renderOrder={order.head}
          frustumCulled={false}
        />
      )}
    </>
  );
}

/** One run's strip: buffers sized by its point count, centres rewritten in place when they move. */
function TrailRun(props: {
  points: readonly ChartTrailPoint[];
  material: ShaderMaterial;
  order: number;
}) {
  const { points, material, order } = props;
  const count = points.length;
  const held = useRef(points);
  held.current = points;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the buffers are sized by the count; their centres are rewritten in place below
  const run = useMemo(() => {
    const strip = chartTrailStrip(held.current);
    return { strip, geometry: chartTrailGeometry(strip), key: chartTrailKey(held.current) };
  }, [count]);
  useEffect(() => () => run.geometry.dispose(), [run]);
  const key = chartTrailKey(points);
  useLayoutEffect(() => {
    if (run.key === key) return;
    writeChartTrailStrip(held.current, run.strip);
    for (const name of CHART_TRAIL_MOVING) run.geometry.getAttribute(name).needsUpdate = true;
    run.key = key;
  }, [key, run]);
  if (count < 2) return null;
  return (
    <mesh geometry={run.geometry} material={material} renderOrder={order} frustumCulled={false} />
  );
}
