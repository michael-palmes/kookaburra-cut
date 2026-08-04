/** Axis furniture for 3D charts: the floor clearing, the gridline wall behind the marks, and every label (ticks, categories, axis names, value labels, legend) through the shared troika components. Tick and value labels billboard so they stay readable under the camera rig; categories, axis names and the legend stay fixed to the chart plane, which reads as designed rather than as a HUD. */

import { useEffect, useMemo } from "react";
import { BoxGeometry, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry } from "three";
import { barSpan, CHART_2D_APPEARANCE, dashSegments, legendLabels } from "./chart2dMath";
import { ChartLabel, ChartLegendRow } from "./chartText";
import { formatChartValue } from "./format";
import { chartColourAt } from "./palette";
import { pieCentreY, pieRadius } from "./pie3d";
import { revealAt } from "./reveal";
import { type Chart3DSpace, chartWorldX, chartWorldY } from "./space3d";
import type { ChartConfig, ChartLayout, ChartRevealFn } from "./types";

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
  /** Chart's own floor clearing; off when the scene already stages one. */
  floor: boolean;
  floorColour: string;
  gridColour: string;
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
): GridPiece[] {
  const thickness = GRID_THICKNESS * space.unit;
  const run = vertical ? space.width : space.height;
  const origin = vertical ? -space.width / 2 : 0;
  const fixed = vertical ? chartWorldY(space, position) : chartWorldX(space, position);
  const runs: [number, number][] = dashed
    ? dashSegments(
        run,
        CHART_2D_APPEARANCE.dashFraction * space.unit,
        CHART_2D_APPEARANCE.dashGapFraction * space.unit,
      )
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
  const { layout, space, floor, floorColour, gridColour, opacity, shadows } = props;
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
      {layout.value.gridlines.flatMap((position) =>
        gridPieces(space, vertical, position, dashed).map((piece) => (
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

export interface ChartText3DProps {
  chart: ChartConfig;
  layout: ChartLayout;
  space: Chart3DSpace;
  colours: readonly string[];
  textColour: string;
  mutedColour: string;
  reveal?: ChartRevealFn;
  opacity: number;
}

export function ChartText3D(props: ChartText3DProps) {
  const { chart, layout, space, colours, textColour, mutedColour, reveal, opacity } = props;
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

  // Rows stack downward from the floor so nothing overlaps; which rows exist depends on the orientation.
  let below = pad;
  const bottomTickY = !vertical && showTicks ? -(below + tickFont * 0.6) : null;
  if (bottomTickY !== null) below += tickFont * 1.5;
  const bottomCategoryY = vertical && showCategories ? -(below + catFont * 0.6) : null;
  if (bottomCategoryY !== null) below += catFont * 1.5;
  const bottomName = vertical ? layout.category.name : layout.value.name;
  const bottomNameY = !pie && bottomName ? -(below + nameFont * 0.6) : null;
  if (bottomNameY !== null) below += nameFont * 1.6;
  const legendY = -(below + legendFont * 0.7);

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
  reveal?: ChartRevealFn;
  opacity: number;
}

/** Value labels for whichever family the layout populated: outside the growing end of a bar, above a line/area point, or beyond the rim of a pie slice. */
function ChartValues3D(props: ChartValues3DProps) {
  const { chart, layout, space, colour, fontSize, reveal, opacity } = props;
  const { format, countUp } = chart.labels.values;
  const outward = chart.labels.values.location === "above" ? fontSize * 0.75 : 0;
  const vertical = layout.valueAxis === "y";
  const z = space.frontZ;

  if (chart.type === "pie" && layout.pie) {
    const radius = pieRadius(space) + space.pad * 0.7;
    const centreY = pieCentreY(space);
    return (
      <>
        {layout.pie.slices.map((slice) => {
          const build = revealAt(reveal, slice.seriesIndex, slice.categoryIndex);
          return (
            <ChartLabel
              key={slice.categoryIndex}
              text={formatChartValue(countUp ? slice.value * build.grow : slice.value, format)}
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
              alpha={build.alpha * opacity}
            />
          );
        })}
      </>
    );
  }

  if (layout.bars.length > 0) {
    return (
      <>
        {layout.bars.map((mark) => {
          const nudge = outward * barSpan(mark, layout.valueAxis, 1).direction;
          const build = revealAt(reveal, mark.seriesIndex, mark.categoryIndex);
          return (
            <ChartLabel
              key={`${mark.seriesIndex}-${mark.categoryIndex}`}
              text={formatChartValue(countUp ? mark.value * build.grow : mark.value, format)}
              position={[
                chartWorldX(space, mark.labelAnchor.x) + (vertical ? 0 : nudge),
                chartWorldY(space, mark.labelAnchor.y) + (vertical ? nudge : 0),
                z,
              ]}
              fontSize={fontSize}
              colour={colour}
              anchorX="center"
              anchorY="middle"
              billboard
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
        series.points.map((point) => {
          const build = revealAt(reveal, series.seriesIndex, point.categoryIndex);
          return (
            <ChartLabel
              key={`${series.seriesIndex}-${point.categoryIndex}`}
              text={formatChartValue(countUp ? point.value * build.grow : point.value, format)}
              position={[
                chartWorldX(space, point.x),
                chartWorldY(space, point.y) + fontSize * 0.9,
                z,
              ]}
              fontSize={fontSize}
              colour={colour}
              anchorX="center"
              anchorY="middle"
              billboard
              alpha={build.alpha * opacity}
            />
          );
        }),
      )}
    </>
  );
}
