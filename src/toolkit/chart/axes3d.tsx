/** Axis furniture for 3D charts: the floor clearing, the gridline wall behind the marks, and every label (ticks, categories, axis names, value labels, legend) through the shared troika components. Tick and value labels billboard so they stay readable under the camera rig; categories, axis names and the legend stay fixed to the chart plane, which reads as designed rather than as a HUD. */

import { useEffect, useMemo } from "react";
import { BoxGeometry, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry } from "three";
import { useTheme } from "../../theme";
import {
  barLabelSpot,
  dashSegments,
  LEGEND_CHIP,
  legendLabels,
  revealedPoint,
} from "./chart2dMath";
import { ChartLabel, ChartLegendRow, chartPillColour } from "./chartText";
import { formatChartValue } from "./format";
import { chartColourAt } from "./palette";
import { pieCentreY, pieRadius } from "./pie3d";
import { revealAt } from "./reveal";
import { type ChartRevealSource, chartRevealFn } from "./revealSource";
import { type Chart3DSpace, chartWorldX, chartWorldY } from "./space3d";
import type { ChartConfig, ChartLayout, ChartLegendChrome } from "./types";

/** Gridline strips run thicker than the flat renderer's quads: they sit metres behind the marks and thin out under perspective. */
const GRID_THICKNESS = 0.0035;
const FLOOR_EPSILON = 0.0015;

const TICK_FONT = 0.042;
const CATEGORY_FONT = 0.046;
const NAME_FONT = 0.052;
const VALUE_FONT = 0.042;
const LEGEND_FONT = 0.046;
/** Room reserved for tick text between the plot edge and the axis name, in font widths (labels are not measured here; the 2D hero mount owns measured reflow). */
const TICK_ALLOWANCE = 3.4;
const TRAILING_LEGEND_FRACTION = 0.4;

export interface ChartStage3DProps {
  layout: ChartLayout;
  space: Chart3DSpace;
  /** Chart's own floor clearing; off when the scene already stages one, or when the preset lays none. */
  floor: boolean;
  floorColour: string;
  gridColour: string;
  /** The back-wall gridlines, off under a preset that clears the wall. */
  wallGrid: boolean;
  /** Dash lengths for a dashed gridline style, fractions of the plot's short side. */
  dash: { length: number; gap: number };
  opacity: number;
  shadows: boolean;
}

interface GridPiece {
  position: [number, number, number];
  scale: [number, number, number];
}

/** One gridline as thin boxes: a single strip for `hair`, or the flat renderer's dash pattern for `dashed`. Pure function of the tick position. */
function gridPieces(
  space: Chart3DSpace,
  vertical: boolean,
  position: number,
  dashed: boolean,
  dash: { length: number; gap: number },
): GridPiece[] {
  const thickness = GRID_THICKNESS * space.unit;
  const run = vertical ? space.width : space.height;
  const origin = vertical ? -space.width / 2 : 0;
  const fixed = vertical ? chartWorldY(space, position) : chartWorldX(space, position);
  const runs: [number, number][] = dashed
    ? dashSegments(run, dash.length * space.unit, dash.gap * space.unit)
    : [[0, run]];
  return runs.map(([start, length]) => {
    const centre = origin + start + length / 2;
    return {
      position: vertical ? [centre, fixed, space.wallZ] : [fixed, centre, space.wallZ],
      scale: vertical ? [length, thickness, thickness] : [thickness, length, thickness],
    };
  });
}

export function ChartStage3D(props: ChartStage3DProps) {
  const { layout, space, floor, floorColour, gridColour, wallGrid, dash, opacity, shadows } = props;
  const vertical = layout.valueAxis === "y";
  const dashed = layout.value.gridlineStyle === "dashed";

  const gridGeometry = useMemo(() => new BoxGeometry(1, 1, 1), []);
  useEffect(() => () => gridGeometry.dispose(), [gridGeometry]);
  const gridMaterial = useMemo(
    () => new MeshBasicMaterial({ color: gridColour, transparent: opacity < 1, opacity }),
    [gridColour, opacity],
  );
  useEffect(() => () => gridMaterial.dispose(), [gridMaterial]);

  const floorGeometry = useMemo(() => new PlaneGeometry(1, 1), []);
  useEffect(() => () => floorGeometry.dispose(), [floorGeometry]);
  const floorMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: floorColour,
        roughness: 0.9,
        metalness: 0,
        transparent: opacity < 1,
        opacity,
      }),
    [floorColour, opacity],
  );
  useEffect(() => () => floorMaterial.dispose(), [floorMaterial]);

  // The clearing runs from a pad behind the gridlines to a pad in front of the marks.
  const floorDepth = space.halfDepth - space.wallZ + 2 * space.pad;
  const floorZ = (space.halfDepth + space.wallZ) / 2;

  return (
    <group>
      {floor && (
        <mesh
          geometry={floorGeometry}
          material={floorMaterial}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -FLOOR_EPSILON * space.unit, floorZ]}
          scale={[space.width + 2 * space.pad, floorDepth, 1]}
          receiveShadow={shadows}
        />
      )}
      {wallGrid &&
        layout.value.gridlines.flatMap((position) =>
          gridPieces(space, vertical, position, dashed, dash).map((piece) => (
            <mesh
              key={`${position}-${piece.position[0]}-${piece.position[1]}`}
              geometry={gridGeometry}
              material={gridMaterial}
              position={piece.position}
              scale={piece.scale}
            />
          )),
        )}
    </group>
  );
}

/** The rows a 3D chart stacks under its floor, and how deep the stack runs (chart-space units below y 0). One source for the renderer and the grounded hero fit, so reserved and drawn depth cannot disagree. */
export function chart3dBelowStack(
  chart: ChartConfig,
  layout: ChartLayout,
  space: Chart3DSpace,
  chrome: ChartLegendChrome = "plain",
): {
  tickY: number | null;
  categoryY: number | null;
  nameY: number | null;
  legendY: number;
  depth: number;
  top: number;
} {
  const vertical = layout.valueAxis === "y";
  const pie = chart.type === "pie";
  const unit = space.unit;
  const pad = space.pad;
  const tickFont = TICK_FONT * unit;
  const catFont = CATEGORY_FONT * unit;
  const nameFont = NAME_FONT * unit;
  const legendFont = LEGEND_FONT * unit;
  const showTicks = !pie && layout.value.labels && layout.value.ticks.length > 0;
  const showCategories = !pie && layout.category.labels;
  let below = pad;
  const tickY = !vertical && showTicks ? -(below + tickFont * 0.6) : null;
  if (tickY !== null) below += tickFont * 1.5;
  const categoryY = vertical && showCategories ? -(below + catFont * 0.6) : null;
  if (categoryY !== null) below += catFont * 1.5;
  const bottomName = vertical ? layout.category.name : layout.value.name;
  const nameY = !pie && bottomName ? -(below + nameFont * 0.6) : null;
  if (nameY !== null) below += nameFont * 1.6;
  const legendY = -(below + legendFont * 0.7);
  const legendBottom = chart.labels.legend.visible && chart.labels.legend.position === "bottom";
  const legendHalf = chrome === "chips" ? LEGEND_CHIP.height / 2 : 0.7;
  const depth = legendBottom ? below + legendFont * (0.7 + legendHalf) : below;
  const legendTop = chart.labels.legend.visible && chart.labels.legend.position === "top";
  const top = legendTop ? pad + legendFont * (0.7 + legendHalf) : pad;
  return { tickY, categoryY, nameY, legendY, depth, top };
}

export interface ChartText3DProps {
  chart: ChartConfig;
  layout: ChartLayout;
  space: Chart3DSpace;
  colours: readonly string[];
  textColour: string;
  /** Tick and value label colour: the muted token already lifted by the preset's `tickWeight`. */
  mutedColour: string;
  /** Legend entries plain, or each on its own chip. */
  legendChrome: ChartLegendChrome;
  /** Value and legend labels take the family's semibold face (the preset's `fontEmphasis`). */
  bold: boolean;
  reveal?: ChartRevealSource;
  opacity: number;
}

export function ChartText3D(props: ChartText3DProps) {
  const { chart, layout, space, colours, textColour, mutedColour, reveal, opacity } = props;
  const theme = useTheme();
  const vertical = layout.valueAxis === "y";
  const pie = chart.type === "pie";
  const unit = space.unit;
  const pad = space.pad;
  const tickFont = TICK_FONT * unit;
  const catFont = CATEGORY_FONT * unit;
  const nameFont = NAME_FONT * unit;
  const valueFont = VALUE_FONT * unit;
  const legendFont = LEGEND_FONT * unit;
  const z = space.frontZ;

  const showTicks = !pie && layout.value.labels && layout.value.ticks.length > 0;
  const showCategories = !pie && layout.category.labels;
  const showValues = chart.labels.values.visible;

  // Rows stack downward from the floor so nothing overlaps; shared with the grounded hero fit.
  const stack = chart3dBelowStack(chart, layout, space);
  const bottomTickY = stack.tickY;
  const bottomCategoryY = stack.categoryY;
  const bottomName = vertical ? layout.category.name : layout.value.name;
  const bottomNameY = stack.nameY;
  const legendY = stack.legendY;

  const sideName = vertical ? layout.value.name : layout.category.name;
  const sideNameX = -space.width / 2 - pad - TICK_ALLOWANCE * (vertical ? tickFont : catFont);

  const legendEntries = legendLabels(chart, layout).map((label, i) => ({
    label,
    colour: chartColourAt(colours, i, textColour),
  }));
  const legendPosition = chart.labels.legend.position;
  const legendAt: [number, number, number] =
    legendPosition === "top"
      ? [0, space.height + pad + legendFont * 0.7, z]
      : legendPosition === "trailing"
        ? [space.width / 2 + pad + (unit * TRAILING_LEGEND_FRACTION) / 2, space.height / 2, z]
        : [0, legendY, z];
  const legendWidth = legendPosition === "trailing" ? unit * TRAILING_LEGEND_FRACTION : space.width;

  return (
    <group>
      {showTicks &&
        layout.value.ticks.map((tick) => (
          <ChartLabel
            key={tick.value}
            text={formatChartValue(tick.value, chart.axis.value.format)}
            position={
              vertical
                ? [-space.width / 2 - pad, chartWorldY(space, tick.position), z]
                : [chartWorldX(space, tick.position), bottomTickY ?? -pad, z]
            }
            fontSize={tickFont}
            colour={mutedColour}
            anchorX={vertical ? "right" : "center"}
            anchorY="middle"
            billboard
            alpha={opacity}
          />
        ))}
      {showCategories &&
        layout.category.bands.map((band) => (
          <ChartLabel
            key={band.index}
            text={band.label}
            position={
              vertical
                ? [chartWorldX(space, band.centre), bottomCategoryY ?? -pad, z]
                : [-space.width / 2 - pad, chartWorldY(space, band.centre), z]
            }
            fontSize={catFont}
            colour={textColour}
            anchorX={vertical ? "center" : "right"}
            anchorY="middle"
            alpha={opacity}
          />
        ))}
      {bottomNameY !== null && bottomName && (
        <ChartLabel
          text={bottomName}
          position={[0, bottomNameY, z]}
          fontSize={nameFont}
          colour={textColour}
          anchorX="center"
          anchorY="middle"
          alpha={opacity}
          bold
        />
      )}
      {!pie && sideName && (
        <ChartLabel
          text={sideName}
          position={[sideNameX, space.height / 2, z]}
          fontSize={nameFont}
          colour={textColour}
          anchorX="center"
          anchorY="middle"
          rotation={Math.PI / 2}
          alpha={opacity}
          bold
        />
      )}
      {showValues && (
        <ChartValues3D
          chart={chart}
          layout={layout}
          space={space}
          colour={textColour}
          fontSize={valueFont}
          bold={props.bold}
          reveal={reveal}
          opacity={opacity}
        />
      )}
      {chart.labels.legend.visible && legendEntries.length > 0 && (
        <ChartLegendRow
          entries={legendEntries}
          position={legendAt}
          maxWidth={legendWidth}
          fontSize={legendFont}
          colour={textColour}
          align={legendPosition === "trailing" ? "left" : "center"}
          chrome={props.legendChrome}
          chipColour={chartPillColour(theme)}
          bold={props.bold}
          alpha={opacity}
        />
      )}
    </group>
  );
}

interface ChartValues3DProps {
  chart: ChartConfig;
  layout: ChartLayout;
  space: Chart3DSpace;
  colour: string;
  fontSize: number;
  bold: boolean;
  reveal?: ChartRevealSource;
  opacity: number;
}

/** Value labels for whichever family the layout populated: riding the growing end of a bar, riding a line/area point up out of its baseline, or beyond the rim of a pie slice. The flat renderer places them by the same rules and the same helpers, so a chart's labels never sit differently between dimensions; every counting label prints against the CLAMPED `count` channel, so it can never run past its true value while a mark overshoots. */
function ChartValues3D(props: ChartValues3DProps) {
  const { chart, layout, space, colour, fontSize, bold, reveal, opacity } = props;
  const { format, countUp, location } = chart.labels.values;
  const at = chartRevealFn(reveal);
  const outward = fontSize * 0.75;
  const vertical = layout.valueAxis === "y";
  const z = space.frontZ;

  if (chart.type === "pie" && layout.pie) {
    const radius = pieRadius(space) + space.pad * 0.7;
    const centreY = pieCentreY(space);
    return (
      <>
        {layout.pie.slices.map((slice) => {
          const build = revealAt(at, slice.seriesIndex, slice.categoryIndex);
          return (
            <ChartLabel
              key={slice.categoryIndex}
              text={formatChartValue(countUp ? slice.value * build.count : slice.value, format)}
              position={[
                radius * Math.sin(slice.midAngle),
                centreY + radius * Math.cos(slice.midAngle),
                z,
              ]}
              fontSize={fontSize}
              colour={colour}
              anchorX="center"
              anchorY="middle"
              billboard
              bold={bold}
              alpha={build.alpha * opacity}
            />
          );
        })}
      </>
    );
  }

  if (layout.bars.length > 0) {
    const inside = location === "inside";
    return (
      <>
        {layout.bars.map((mark) => {
          const build = revealAt(at, mark.seriesIndex, mark.categoryIndex);
          const spot = barLabelSpot(
            mark,
            layout.valueAxis,
            location,
            build.grow,
            outward,
            build.drop,
          );
          // The flat renderer's anchor rule: an outside label hangs off the growing end rather than straddling it.
          const away = spot.direction > 0;
          return (
            <ChartLabel
              key={`${mark.seriesIndex}-${mark.categoryIndex}`}
              text={formatChartValue(countUp ? mark.value * build.count : mark.value, format)}
              position={[
                vertical
                  ? chartWorldX(space, spot.across)
                  : chartWorldX(space, spot.along) + spot.nudge,
                vertical
                  ? chartWorldY(space, spot.along) + spot.nudge
                  : chartWorldY(space, spot.across),
                z,
              ]}
              fontSize={fontSize}
              colour={colour}
              anchorX={vertical || inside ? "center" : away ? "left" : "right"}
              anchorY={!vertical || inside ? "middle" : away ? "bottom" : "top"}
              billboard
              bold={bold}
              alpha={build.alpha * opacity}
            />
          );
        })}
      </>
    );
  }

  return (
    <>
      {layout.series.flatMap((series) =>
        series.points.map((point, i) => {
          const build = revealAt(at, series.seriesIndex, point.categoryIndex);
          const rode = revealedPoint(point, series.baseline[i], build.grow, build.drop);
          return (
            <ChartLabel
              key={`${series.seriesIndex}-${point.categoryIndex}`}
              text={formatChartValue(countUp ? point.value * build.count : point.value, format)}
              position={[
                chartWorldX(space, rode.x),
                chartWorldY(space, rode.y) + fontSize * 0.9,
                z,
              ]}
              fontSize={fontSize}
              colour={colour}
              anchorX="center"
              anchorY="middle"
              billboard
              bold={bold}
              alpha={build.alpha * opacity}
            />
          );
        }),
      )}
    </>
  );
}
