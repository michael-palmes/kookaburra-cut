/** The 3D chart renderer: all eight types as staged solids in one group whose plot spans `size.width` x `size.height` world units with the ground at y 0 and the group origin at the centre of the floor. It adds NO lights (the stage lights it, the `Device` contract) and never applies `style.rotation`: the HOST owns placement, the presentation tilt and the camera rig. Every element takes its channels from `reveal` (a bare per-element lookup or a whole sampler), which defaults to fully built, and its finish from the resolved `ChartStyleSurface` (never a preset id). */

import { useMemo } from "react";
import { useTheme } from "../../theme";
import { liftColour } from "../colour";
import { useStageFloorY, useStageMapShadows } from "../stage/context";
import { ChartStage3D, ChartText3D } from "./axes3d";
import { Bars3D } from "./bars3d";
import { chart2dLook } from "./chart2dMath";
import { Pie3D } from "./pie3d";
import { Series3D } from "./ribbon3d";
import { chart3dSpace } from "./space3d";
import { CHART_STYLE_DEFAULT_ID, CHART_STYLE_PRESETS, chartStackSurface } from "./stylePresets";
import type { ChartRendererProps, ChartStyleSurface, ChartType } from "./types";

/** Lift amounts from the theme background toward its text colour, so the furniture sits on light and dark themes alike; the gridline lift takes the preset's `gridStyleWeight`. */
const FLOOR_LIFT = 0.06;
const GRID_LIFT = 0.22;

const BAR_TYPES: ChartType[] = ["column", "bar", "stackedColumn", "stackedBar"];
const AREA_TYPES: ChartType[] = ["area", "stackedArea"];

export interface Chart3DProps extends ChartRendererProps {
  /** The resolved appearance; absent takes the catalogue's default preset, so the primitive still stands alone. */
  surface?: ChartStyleSurface;
}

export function Chart3D(props: Chart3DProps) {
  const { chart, layout, colours, size, reveal, opacity = 1 } = props;
  const theme = useTheme();
  // The stage lights the chart and, when it backs onto a floor, grounds it too: the chart brings neither.
  const shadows = useStageMapShadows();
  const stageFloorY = useStageFloorY();
  const surface = props.surface ?? CHART_STYLE_PRESETS[CHART_STYLE_DEFAULT_ID].surface;
  const look = useMemo(() => chart2dLook(surface), [surface]);
  // A stack's segments take the matte finish, so a tall column is not a ladder of highlights; identity for every other preset.
  const finish = useMemo(
    () => (layout.stacked ? chartStackSurface(surface.threed) : surface.threed),
    [layout.stacked, surface.threed],
  );

  const space = useMemo(
    () => chart3dSpace(chart.style.depth, size.width, size.height),
    [chart.style.depth, size.width, size.height],
  );
  const floorColour = useMemo(
    () => liftColour(theme.colors.background, theme.colors.text, FLOOR_LIFT),
    [theme.colors.background, theme.colors.text],
  );
  const gridColour = useMemo(
    () =>
      liftColour(
        theme.colors.background,
        theme.colors.text,
        GRID_LIFT * Math.max(0, surface.gridStyleWeight),
      ),
    [theme.colors.background, theme.colors.text, surface.gridStyleWeight],
  );
  const tickColour = useMemo(
    () => liftColour(theme.colors.muted, theme.colors.text, look.tickWeight),
    [theme.colors.muted, theme.colors.text, look.tickWeight],
  );

  const pie = chart.type === "pie";
  const cornerRadius = Math.min(
    1,
    Math.max(0, chart.style.cornerRadius * surface.cornerRadiusScale),
  );
  const marks = {
    colours,
    fallbackColour: theme.colors.accent,
    reveal,
    opacity,
    shadows,
    finish,
  };

  return (
    <group>
      <ChartStage3D
        layout={layout}
        space={space}
        floor={!pie && stageFloorY === null && surface.threed.floorShadow}
        floorColour={floorColour}
        gridColour={gridColour}
        wallGrid={surface.threed.wallGrid && surface.gridStyleWeight > 0}
        dash={{ length: look.dashFraction, gap: look.dashGapFraction }}
        opacity={opacity}
        shadows={shadows}
      />
      {BAR_TYPES.includes(chart.type) && (
        <Bars3D layout={layout} space={space} cornerRadius={cornerRadius} {...marks} />
      )}
      {chart.type === "line" && (
        <Series3D layout={layout} space={space} filled={false} {...marks} />
      )}
      {AREA_TYPES.includes(chart.type) && (
        <Series3D layout={layout} space={space} filled {...marks} />
      )}
      {pie && layout.pie && (
        <Pie3D pie={layout.pie} space={space} pieGap={look.pieGap} {...marks} />
      )}
      <ChartText3D
        chart={chart}
        layout={layout}
        space={space}
        colours={colours}
        textColour={theme.colors.text}
        mutedColour={tickColour}
        legendChrome={surface.legendChrome}
        bold={surface.fontEmphasis === "headline"}
        reveal={reveal}
        opacity={opacity}
      />
    </group>
  );
}
