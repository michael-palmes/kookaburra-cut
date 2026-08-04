/** The flat chart renderer: all eight types as unlit geometry in the one WebGL canvas, never DOM and never canvas-2D. The plot rect is CENTRED on the group origin (plot space 0..1 maps to -size/2..+size/2, y up) and the axis furniture hangs outside it in the bands `chart2dInsets` reserves, so a mount can shrink its rect by the same maths the renderer draws with. Everything renders its FINAL state when `reveal` is absent; every mark, label and fill already applies its own `ChartReveal`, which is the seam the build-in animation phase threads real sampling through. */

import { useEffect, useMemo } from "react";
import { useFormat } from "../../engine/format";
import { useTheme } from "../../theme";
import { Bars2D } from "./Bars2D";
import {
  CHART_2D_APPEARANCE,
  CHART_2D_ORDER,
  CHART_2D_Z_STEP,
  type Chart2DAppearance,
  type Chart2DBands,
  type Chart2DMetrics,
  type ChartSize,
  chart2dBands,
  chart2dMetrics,
  gridlineRects,
  legendLabels,
  plotToWorldX,
  plotToWorldY,
  rectsGeometry,
  withGap,
} from "./chart2dMath";
import { ChartLabel, type ChartLegendEntry, ChartLegendRow } from "./chartText";
import { formatChartValue } from "./format";
import { Lines2D } from "./Lines2D";
import { Pie2D } from "./Pie2D";
import { chartColourAt } from "./palette";
import type { ChartConfig, ChartLayout, ChartRendererProps, ChartValueFormat } from "./types";

/** SDF edges soften over about this many export pixels. */
const FEATHER_PIXELS = 0.75;

export interface Chart2DProps extends ChartRendererProps {
  /** Flat-look overrides; the appearance-preset phase fills this in. */
  look?: Partial<Chart2DAppearance>;
}

export function Chart2D(props: Chart2DProps) {
  const { chart, layout, colours, size, reveal, opacity = 1 } = props;
  const theme = useTheme();
  const format = useFormat();
  const look = useMemo<Chart2DAppearance>(
    () => ({ ...CHART_2D_APPEARANCE, ...props.look }),
    [props.look],
  );
  const metrics = useMemo(() => chart2dMetrics(size, look), [size, look]);
  const bands = useMemo(() => chart2dBands(chart, layout, size, look), [chart, layout, size, look]);

  // Pixels per world unit at the export frame: fixed per aspect, so a stroke or an SDF edge is the same fraction of the frame in preview and in export.
  const pixelsPerUnit = format.height / format.frame.height;
  const resolution = useMemo(
    () => ({ width: format.width, height: format.height }),
    [format.width, format.height],
  );

  const pie = layout.type === "pie";
  const bars = layout.bars.length > 0;

  return (
    <group>
      {!pie && (
        <Gridlines2D
          layout={layout}
          size={size}
          metrics={metrics}
          look={look}
          colour={theme.colors.muted}
          opacity={opacity}
        />
      )}
      {bars && (
        <Bars2D
          layout={layout}
          colours={colours}
          size={size}
          metrics={metrics}
          cornerRadius={chart.style.cornerRadius}
          labels={chart.labels.values}
          reveal={reveal}
          opacity={opacity}
          feather={FEATHER_PIXELS / pixelsPerUnit}
          z={CHART_2D_Z_STEP * 2}
        />
      )}
      {layout.series.length > 0 && (
        <Lines2D
          layout={layout}
          colours={colours}
          size={size}
          metrics={metrics}
          look={look}
          labels={chart.labels.values}
          reveal={reveal}
          opacity={opacity}
          resolution={resolution}
          pixelsPerUnit={pixelsPerUnit}
          z={CHART_2D_Z_STEP * 2}
        />
      )}
      {pie && (
        <Pie2D
          layout={layout}
          colours={colours}
          metrics={metrics}
          look={look}
          labels={chart.labels.values}
          reveal={reveal}
          opacity={opacity}
          z={CHART_2D_Z_STEP * 2}
        />
      )}
      {!pie && (
        <AxisFurniture
          layout={layout}
          size={size}
          metrics={metrics}
          bands={bands}
          format={chart.axis.value.format}
          opacity={opacity}
        />
      )}
      <Legend
        chart={props.chart}
        layout={layout}
        colours={colours}
        size={size}
        metrics={metrics}
        bands={bands}
        opacity={opacity}
      />
    </group>
  );
}

/** Value-axis gridlines as thin quads, never `gl.LINE` (unreliable AA, ropey under motion); dashed styles are segmented quads, so no extra program joins the render path. */
function Gridlines2D(props: {
  layout: ChartLayout;
  size: ChartSize;
  metrics: Chart2DMetrics;
  look: Chart2DAppearance;
  colour: string;
  opacity: number;
}) {
  const { layout, size, metrics, look, colour, opacity } = props;
  const rects = useMemo(
    () =>
      gridlineRects(
        layout.value.gridlines,
        layout.valueAxis,
        layout.value.gridlineStyle,
        size,
        metrics,
      ),
    [layout.value.gridlines, layout.valueAxis, layout.value.gridlineStyle, size, metrics],
  );
  const geometry = useMemo(() => (rects.length > 0 ? rectsGeometry(rects) : null), [rects]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <mesh geometry={geometry} position={[0, 0, 0]} renderOrder={CHART_2D_ORDER.grid}>
      <meshBasicMaterial
        color={colour}
        transparent
        opacity={look.gridOpacity * opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/** Tick labels, category labels and axis names, laid out from the reserved bands: ticks and categories in the muted token, axis names in the text token at the semibold face. */
function AxisFurniture(props: {
  layout: ChartLayout;
  size: ChartSize;
  metrics: Chart2DMetrics;
  bands: Chart2DBands;
  format: ChartValueFormat;
  opacity: number;
}) {
  const { layout, size, metrics, bands, format, opacity } = props;
  const theme = useTheme();
  const vertical = layout.valueAxis === "y";
  const gap = metrics.gap;
  const left = -size.width / 2;
  const bottom = -size.height / 2;
  const z = CHART_2D_Z_STEP;

  const valueNameOffset = withGap(bands.tick, gap) + gap + bands.valueName / 2;
  const categoryNameOffset = withGap(bands.category, gap) + gap + bands.categoryName / 2;

  return (
    <>
      {layout.value.labels &&
        layout.value.ticks.map((tick) => (
          <ChartLabel
            key={tick.value}
            text={formatChartValue(tick.value, format)}
            position={
              vertical
                ? [left - gap, plotToWorldY(size, tick.position), z]
                : [plotToWorldX(size, tick.position), bottom - gap, z]
            }
            fontSize={metrics.tick}
            colour={theme.colors.muted}
            anchorX={vertical ? "right" : "center"}
            anchorY={vertical ? "middle" : "top"}
            alpha={opacity}
          />
        ))}
      {layout.category.labels &&
        layout.category.bands.map((band) => (
          <ChartLabel
            key={band.index}
            text={band.label}
            position={
              vertical
                ? [plotToWorldX(size, band.centre), bottom - gap, z]
                : [left - gap, plotToWorldY(size, band.centre), z]
            }
            fontSize={metrics.tick}
            colour={theme.colors.muted}
            anchorX={vertical ? "center" : "right"}
            anchorY={vertical ? "top" : "middle"}
            alpha={opacity}
          />
        ))}
      {layout.value.name && (
        <ChartLabel
          text={layout.value.name}
          position={vertical ? [left - valueNameOffset, 0, z] : [0, bottom - valueNameOffset, z]}
          fontSize={metrics.axisName}
          colour={theme.colors.text}
          rotation={vertical ? Math.PI / 2 : 0}
          bold
          alpha={opacity}
        />
      )}
      {layout.category.name && (
        <ChartLabel
          text={layout.category.name}
          position={
            vertical ? [0, bottom - categoryNameOffset, z] : [left - categoryNameOffset, 0, z]
          }
          fontSize={metrics.axisName}
          colour={theme.colors.text}
          rotation={vertical ? 0 : Math.PI / 2}
          bold
          alpha={opacity}
        />
      )}
    </>
  );
}

/** The series (or slice) key, parked outside whichever edge the block asked for. */
function Legend(props: {
  chart: ChartConfig;
  layout: ChartLayout;
  colours: string[];
  size: ChartSize;
  metrics: Chart2DMetrics;
  bands: Chart2DBands;
  opacity: number;
}) {
  const { chart, layout, colours, size, metrics, bands, opacity } = props;
  const theme = useTheme();
  const entries = useMemo<ChartLegendEntry[]>(
    () =>
      legendLabels(chart, layout).map((label, i) => ({
        label,
        colour: chartColourAt(colours, i, theme.colors.accent),
      })),
    [chart, layout, colours, theme.colors.accent],
  );
  if (!chart.labels.legend.visible || entries.length === 0) return null;

  const gap = metrics.gap;
  const half = bands.legend / 2;
  const vertical = layout.valueAxis === "y";
  // The bottom legend clears whatever furniture already sits under the plot.
  const belowPlot =
    withGap(vertical ? bands.category : bands.tick, gap) +
    withGap(vertical ? bands.categoryName : bands.valueName, gap);

  if (chart.labels.legend.position === "trailing") {
    return (
      <ChartLegendRow
        entries={entries}
        position={[size.width / 2 + gap, 0, CHART_2D_Z_STEP]}
        maxWidth={0}
        fontSize={metrics.legend}
        colour={theme.colors.text}
        align="left"
        alpha={opacity}
      />
    );
  }
  const y =
    chart.labels.legend.position === "top"
      ? size.height / 2 + gap + half
      : -size.height / 2 - belowPlot - gap - half;
  return (
    <ChartLegendRow
      entries={entries}
      position={[0, y, CHART_2D_Z_STEP]}
      maxWidth={size.width}
      fontSize={metrics.legend}
      colour={theme.colors.text}
      alpha={opacity}
    />
  );
}
