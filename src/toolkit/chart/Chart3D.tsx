/** The 3D chart renderer: all eight types as staged solids in one group whose plot spans `size.width` x `size.height` world units with the ground at y 0 and the group origin at the centre of the floor. It adds NO lights (the stage lights it, the `Device` contract) and never applies `style.rotation`: the HOST owns placement, the presentation tilt and the camera rig. Every element takes its `grow`/`alpha` from `reveal`, which defaults to fully built, so the animation phase only has to thread a real sampler. */

import { useMemo } from "react";
import { useTheme } from "../../theme";
import { liftColour } from "../colour";
import { useStageFloorY, useStageMapShadows } from "../stage/context";
import { ChartStage3D, ChartText3D } from "./axes3d";
import { Bars3D } from "./bars3d";
import { Pie3D } from "./pie3d";
import { Series3D } from "./ribbon3d";
import { chart3dSpace } from "./space3d";
import type { ChartRendererProps, ChartType } from "./types";

/** The one surface finish until the appearance presets land: a soft dielectric that reads as moulded plastic under the stage's key light. */
const CHART_SURFACE = { roughness: 0.42, metalness: 0.1 };

/** Lift amounts from the theme background toward its text colour, so the furniture sits on light and dark themes alike. */
const FLOOR_LIFT = 0.06;
const GRID_LIFT = 0.22;

const BAR_TYPES: ChartType[] = ["column", "bar", "stackedColumn", "stackedBar"];
const AREA_TYPES: ChartType[] = ["area", "stackedArea"];

export function Chart3D(props: ChartRendererProps) {
  const { chart, layout, colours, size, reveal, opacity = 1 } = props;
  const theme = useTheme();
  // The stage lights the chart and, when it backs onto a floor, grounds it too: the chart brings neither.
  const shadows = useStageMapShadows();
  const stageFloorY = useStageFloorY();

  const space = useMemo(
    () => chart3dSpace(chart.style.depth, size.width, size.height),
    [chart.style.depth, size.width, size.height],
  );
  const floorColour = useMemo(
    () => liftColour(theme.colors.background, theme.colors.text, FLOOR_LIFT),
    [theme.colors.background, theme.colors.text],
  );
  const gridColour = useMemo(
    () => liftColour(theme.colors.background, theme.colors.text, GRID_LIFT),
    [theme.colors.background, theme.colors.text],
  );

  const pie = chart.type === "pie";
  const surface = { ...CHART_SURFACE, shadows };
  const marks = { colours, fallbackColour: theme.colors.accent, reveal, opacity, ...surface };

  return (
    <group>
      <ChartStage3D
        layout={layout}
        space={space}
        floor={!pie && stageFloorY === null}
        floorColour={floorColour}
        gridColour={gridColour}
        opacity={opacity}
        shadows={shadows}
      />
      {BAR_TYPES.includes(chart.type) && (
        <Bars3D layout={layout} space={space} cornerRadius={chart.style.cornerRadius} {...marks} />
      )}
      {chart.type === "line" && (
        <Series3D layout={layout} space={space} filled={false} {...marks} />
      )}
      {AREA_TYPES.includes(chart.type) && (
        <Series3D layout={layout} space={space} filled {...marks} />
      )}
      {pie && layout.pie && <Pie3D pie={layout.pie} space={space} {...marks} />}
      <ChartText3D
        chart={chart}
        layout={layout}
        space={space}
        colours={colours}
        textColour={theme.colors.text}
        mutedColour={theme.colors.muted}
        reveal={reveal}
        opacity={opacity}
      />
    </group>
  );
}
