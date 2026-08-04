/** Chart typography: the two label primitives the 2D and 3D renderers share. Text is troika SDF through the theme's `typography` (the `AnimatedHeadline`/`FrameChip` font resolution), never HTML, and every position is a plain prop, so a label is a pure function of its inputs. Billboarding is opt-in for orbiting 3D charts; flat charts keep their labels in the chart plane, where billboarding would be waste. */

import { Billboard, Text } from "@react-three/drei";
import { useTheme } from "../../theme";
import { fontUrl } from "../../theme/fonts";
import type { FontRef } from "../../theme/tokens";
import {
  CHART_2D_ORDER,
  CHART_LINE_HEIGHT,
  LEGEND_ENTRY_GAP,
  LEGEND_SWATCH,
  LEGEND_SWATCH_GAP,
  legendEntryWidth,
  packLegendRows,
} from "./chart2dMath";

/** Swatch circle segments; fixed, so the geometry is identical every run. */
const SWATCH_SEGMENTS = 24;

export interface ChartLabelProps {
  text: string;
  position: [number, number, number];
  fontSize: number;
  colour: string;
  anchorX?: "left" | "center" | "right";
  anchorY?: "top" | "middle" | "bottom";
  /** Face the camera every frame (orbiting or staged 3D charts only). */
  billboard?: boolean;
  alpha?: number;
  /** Take the family's semibold face: axis names and emphasised value labels. */
  bold?: boolean;
  /** Z rotation, radians: the value-axis name runs up the side of a column chart. */
  rotation?: number;
  renderOrder?: number;
}

/** One chart label: a tick, a category, an axis name, a value or a legend entry. */
export function ChartLabel(props: ChartLabelProps) {
  const {
    text,
    position,
    fontSize,
    colour,
    anchorX = "center",
    anchorY = "middle",
    billboard = false,
    alpha = 1,
    bold = false,
    rotation = 0,
    renderOrder = CHART_2D_ORDER.label,
  } = props;
  const theme = useTheme();
  if (!text || alpha <= 0) return null;
  // Both faces are refs the theme DECLARES, never a synthesised weight: the export preamble preloads exactly the declared refs, and a face first typeset mid-run claims cells in the shared SDF atlas late (docs/determinism.md, "Fonts").
  const face: FontRef = bold ? theme.typography.headline : theme.typography.body;
  const label = (
    <Text
      font={fontUrl(face)}
      fontSize={fontSize}
      color={colour}
      anchorX={anchorX}
      anchorY={anchorY}
      fillOpacity={alpha}
      renderOrder={renderOrder}
    >
      {text}
    </Text>
  );
  if (billboard) {
    return (
      <Billboard position={position}>
        <group rotation={[0, 0, rotation]}>{label}</group>
      </Billboard>
    );
  }
  return (
    <group position={position} rotation={[0, 0, rotation]}>
      {label}
    </group>
  );
}

export interface ChartLegendEntry {
  label: string;
  colour: string;
}

export interface ChartLegendRowProps {
  entries: ChartLegendEntry[];
  /** The block's anchor: its centre when centred, its left edge when left-aligned; vertically centred either way. */
  position: [number, number, number];
  /** Wrap width, world units; entries pack into as many rows as they need. */
  maxWidth: number;
  fontSize: number;
  colour: string;
  alpha?: number;
  /** Row alignment inside the block (default centred; a trailing legend wants "left"). */
  align?: "center" | "left";
  billboard?: boolean;
}

interface PackedEntry extends ChartLegendEntry {
  width: number;
}

/** The series (or slice) key: a colour swatch and a label per entry, packed into rows and centred on `position`. Widths are estimated rather than measured, so the block's layout is a pure function of its inputs with no typeset round trip. */
export function ChartLegendRow(props: ChartLegendRowProps) {
  const {
    entries,
    position,
    maxWidth,
    fontSize,
    colour,
    alpha = 1,
    align = "center",
    billboard = false,
  } = props;
  if (entries.length === 0 || alpha <= 0) return null;

  const swatch = fontSize * LEGEND_SWATCH;
  const gap = fontSize * LEGEND_ENTRY_GAP;
  const packed: PackedEntry[] = entries.map((entry) => ({
    ...entry,
    width: legendEntryWidth(entry.label, fontSize),
  }));
  const rows = packLegendRows(packed, maxWidth, gap);
  const pitch = fontSize * CHART_LINE_HEIGHT;
  const topY = ((rows.length - 1) * pitch) / 2;

  const content = rows.map((row, r) => {
    const width = row.reduce((w, e, i) => w + e.width + (i > 0 ? gap : 0), 0);
    let x = align === "left" ? 0 : -width / 2;
    const y = topY - r * pitch;
    return row.map((entry) => {
      const at = x;
      x += entry.width + gap;
      return (
        <group key={`${entry.label}-${at}`} position={[at, y, 0]}>
          <mesh position={[swatch / 2, 0, 0]} renderOrder={CHART_2D_ORDER.label}>
            <circleGeometry args={[swatch / 2, SWATCH_SEGMENTS]} />
            <meshBasicMaterial
              color={entry.colour}
              transparent
              opacity={alpha}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <ChartLabel
            text={entry.label}
            position={[swatch + fontSize * LEGEND_SWATCH_GAP, 0, 0]}
            fontSize={fontSize}
            colour={colour}
            anchorX="left"
            alpha={alpha}
          />
        </group>
      );
    });
  });

  if (billboard) return <Billboard position={position}>{content}</Billboard>;
  return <group position={position}>{content}</group>;
}
