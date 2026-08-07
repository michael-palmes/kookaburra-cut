/** Chart typography: the two label primitives the 2D and 3D renderers share. Text is troika SDF through the face `chartFace` resolves (the block's `chart.font`, the project's chart font, then the theme's own, the `AnimatedHeadline`/`FrameChip` resolution), never HTML, and every position is a plain prop, so a label is a pure function of its inputs. Billboarding is opt-in for orbiting 3D charts; flat charts keep their labels in the chart plane, where billboarding would be waste. */

import { Text } from "@react-three/drei";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Color,
  DynamicDrawUsage,
  type Group,
  InstancedBufferAttribute,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { useTheme } from "../../theme";
import { fontUrl } from "../../theme/fonts";
import type { FontRef, Theme } from "../../theme/tokens";
import { liftColour } from "../colour";
import { chartLabelBeforeRender } from "./billboardLabel";
import {
  CHART_2D_ORDER,
  CHART_LINE_HEIGHT,
  LABEL_PILL,
  LEGEND_ENTRY_GAP,
  LEGEND_SWATCH,
  LEGEND_SWATCH_GAP,
  legendChipRect,
  legendEntryWidth,
  makeChartRectMaterial,
  PILL_ALPHA,
  packLegendRows,
  type WorldRect,
} from "./chart2dMath";
import { chartFace } from "./mount";
import type { ChartLegendChrome } from "./types";

/** Swatch circle segments; fixed, so the geometry is identical every run. */
const SWATCH_SEGMENTS = 24;

/** How far a pill lifts off the theme background toward its text colour (its weight lives beside the pill proportions, in `chart2dMath`). */
const PILL_LIFT = 0.13;

/** The four theme colour tokens a sidecar may name in place of a hex. */
const COLOUR_TOKENS = ["background", "text", "accent", "muted"] as const;
type ColourToken = (typeof COLOUR_TOKENS)[number];

const IDENTITY = new Quaternion();
const _matrix = new Matrix4();
const _position = new Vector3();
const _scale = new Vector3();
const _colour = new Color();

/** The mounted chart's own face (`chart.font`, parsed), replacing BOTH theme faces for every label under it; null everywhere else, where labels resolve exactly as they did before the field existed. `MountedChart` is its only provider. */
export const ChartFontContext = createContext<FontRef | null>(null);

/** The chip a value label or legend entry sits on, under `labelPill` and `legendChrome: "chips"`. */
export const chartPillColour = (theme: Theme): string =>
  liftColour(theme.colors.background, theme.colors.text, PILL_LIFT);

/** An authored chart colour: a theme token by name, a hex as written, null when unauthored. */
export const chartTokenColour = (theme: Theme, colour: string | null): string | null => {
  if (colour === null) return null;
  return COLOUR_TOKENS.includes(colour as ColourToken)
    ? theme.colors[colour as ColourToken]
    : colour;
};

export interface ChartPillsProps {
  rects: readonly WorldRect[];
  /** Corner radius as a fraction of the pill's height; 0.5 is a capsule. */
  radiusFraction: number;
  colour: string;
  opacity: number;
  /** The chip's own translucency; absent takes the shared default, so every caller lands on the same weight. */
  weight?: number;
  /** Per-pill build alpha, index for index with `rects`; absent leaves every pill at `opacity`. */
  alphas?: readonly number[];
  /** SDF edge softening, world units. */
  feather: number;
  z: number;
}

/** The rounded chips behind a run of labels: ONE instanced mesh behind the shared SDF rect material (the bar family's own), so a chart's pills never cost more than a draw call whatever the label count. */
export function ChartPills(props: ChartPillsProps) {
  const { rects, radiusFraction, colour, opacity, weight = PILL_ALPHA, alphas, feather, z } = props;
  const count = rects.length;
  const mesh = useRef<InstancedMesh>(null);

  const rect = useMemo(() => makeChartRectMaterial(), []);
  useEffect(() => () => rect.material.dispose(), [rect]);

  const geometry = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    const half = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 2), 2);
    const radius = new InstancedBufferAttribute(new Float32Array(Math.max(1, count)), 1);
    const tint = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 4), 4);
    const shine = new InstancedBufferAttribute(new Float32Array(Math.max(1, count)).fill(-1), 1);
    half.setUsage(DynamicDrawUsage);
    radius.setUsage(DynamicDrawUsage);
    tint.setUsage(DynamicDrawUsage);
    g.setAttribute("iHalf", half);
    g.setAttribute("iRadius", radius);
    g.setAttribute("iColour", tint);
    g.setAttribute("iShine", shine);
    return g;
  }, [count]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  rect.feather.value = feather;

  useLayoutEffect(() => {
    const target = mesh.current;
    if (!target) return;
    const half = geometry.getAttribute("iHalf") as InstancedBufferAttribute;
    const radii = geometry.getAttribute("iRadius") as InstancedBufferAttribute;
    const tint = geometry.getAttribute("iColour") as InstancedBufferAttribute;
    _colour.set(colour);
    for (let i = 0; i < rects.length; i++) {
      const { x, y, width, height } = rects[i];
      _position.set(x + width / 2, y + height / 2, z);
      _scale.set(Math.max(width, 0), Math.max(height, 0), 1);
      _matrix.compose(_position, IDENTITY, _scale);
      target.setMatrixAt(i, _matrix);
      half.setXY(i, width / 2, height / 2);
      radii.setX(i, Math.min(height, width) * radiusFraction);
      tint.setXYZW(i, _colour.r, _colour.g, _colour.b, opacity * weight * (alphas?.[i] ?? 1));
    }
    target.instanceMatrix.needsUpdate = true;
    half.needsUpdate = true;
    radii.needsUpdate = true;
    tint.needsUpdate = true;
  }, [alphas, colour, geometry, opacity, radiusFraction, rects, weight, z]);

  if (count === 0 || opacity <= 0) return null;
  return (
    // Instance matrices change every frame; the geometry-derived bounding sphere would cull them.
    <instancedMesh
      key={count}
      ref={mesh}
      args={[geometry, rect.material, count]}
      frustumCulled={false}
      renderOrder={CHART_2D_ORDER.pill}
    />
  );
}

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
  const chartFont = useContext(ChartFontContext);
  const anchorRef = useRef<Group>(null);
  const labelRef = useRef<Mesh>(null);
  // Rewrites the label's matrixWorld from the render camera after the graph's updateMatrixWorld (the FixedBackdrop idiom), delegating to troika's own handler first (see `billboardLabel.ts`).
  const faceCamera = useMemo(
    () =>
      chartLabelBeforeRender(
        () => anchorRef.current,
        () => labelRef.current,
        rotation,
      ),
    [rotation],
  );
  if (!text || alpha <= 0) return null;
  // Every face here is a ref something DECLARES (the block's `chart.font`, the project's chart font, or the theme's own), never a synthesised weight: the export preamble preloads exactly the declared refs, and a face first typeset mid-run claims cells in the shared SDF atlas late (docs/determinism.md, "Fonts").
  const face: FontRef = chartFace(chartFont, theme, bold);
  if (billboard) {
    return (
      <group ref={anchorRef} position={position}>
        <Text
          ref={labelRef}
          font={fontUrl(face)}
          fontSize={fontSize}
          color={colour}
          anchorX={anchorX}
          anchorY={anchorY}
          fillOpacity={alpha}
          renderOrder={renderOrder}
          matrixAutoUpdate={false}
          frustumCulled={false}
          onBeforeRender={faceCamera}
        >
          {text}
        </Text>
      </group>
    );
  }
  return (
    <group position={position} rotation={[0, 0, rotation]}>
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
  /** Plain swatch and label, or each entry on its own chip. */
  chrome?: ChartLegendChrome;
  /** Chip fill under `chrome: "chips"`; the theme's own pill colour when absent. */
  chipColour?: string;
  /** SDF edge softening for the chips, world units. */
  feather?: number;
  /** Take the family's semibold face (the preset's `fontEmphasis`). */
  bold?: boolean;
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
    chrome = "plain",
    chipColour,
    feather = fontSize * 0.02,
    bold = false,
  } = props;
  const theme = useTheme();
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
  const chips: WorldRect[] = [];

  const content = rows.map((row, r) => {
    const width = row.reduce((w, e, i) => w + e.width + (i > 0 ? gap : 0), 0);
    let x = align === "left" ? 0 : -width / 2;
    const y = topY - r * pitch;
    return row.map((entry) => {
      const at = x;
      x += entry.width + gap;
      if (chrome === "chips") chips.push(legendChipRect(entry.width, fontSize, at, y));
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
            bold={bold}
          />
        </group>
      );
    });
  });

  const block = (
    <>
      {chips.length > 0 && (
        <ChartPills
          rects={chips}
          radiusFraction={LABEL_PILL.radius}
          colour={chipColour ?? chartPillColour(theme)}
          opacity={alpha}
          feather={feather}
          z={-fontSize * 0.01}
        />
      )}
      {content}
    </>
  );

  return <group position={position}>{block}</group>;
}
