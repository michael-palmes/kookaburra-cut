/** Pure layout for the overlay panel's text column: maps the frame's normalised `content` rect (the non-cutout region, from frameLayout) into world coordinates at the FULL frame, padded, so the panel primitives place title/subtitle/bullets/chip against real world anchors. No clock, no randomness. See docs/overlays.md. */

import { frameLayout } from "../toolkit/frame/frameLayout";
import type { FrameChartSlot, FrameSpec } from "../toolkit/frame/types";
import type { FormatInfo } from "../toolkit/types";

/** Inner margin of the text column, as a fraction of the column's shorter world edge. */
export const PANEL_PAD_FRACTION = 0.08;

/** Share of the column a chart slot takes when the author names no height: a little over half under the text, the whole column when it replaces it. */
export const CHART_SLOT_HEIGHT_BELOW = 0.55;
const CHART_SLOT_HEIGHT_MIN = 0.1;

/** Gap between the panel text and the chart band beneath it, as a fraction of the column's shorter world edge. */
export const CHART_SLOT_GAP_FRACTION = 0.04;

/** The panel's resolved text alignment: the author's pick, else centred for the full-panel `"none"` shape and left elsewhere. One helper so the measure solver and the renderer can never disagree. */
export function frameTextAlign(frame: FrameSpec): "left" | "center" | "right" {
  return frame.textAlign ?? (frame.cutout.shape === "none" ? "center" : "left");
}

export interface FramePanelLayout {
  /** Left edge of the padded column, world X (anchorX="left" origin). */
  left: number;
  /** Top edge of the padded column, world Y (y-up). */
  top: number;
  /** Bottom edge of the padded column, world Y. */
  bottom: number;
  /** Column width in world units (title/bullet wrap width). */
  width: number;
  /** Column height in world units (title-to-chip span). */
  height: number;
}

export interface FramePanelChartSlot {
  /** The chart's world rect by its CENTRE (the `ChartRect` shape a chart mount places against). */
  rect: { x: number; y: number; width: number; height: number };
  /** World y the panel's text has to stay above. */
  textBottom: number;
  /** The chart owns the column, so the panel draws no icon, title, subtitle, bullets or chip. */
  replaces: boolean;
}

/** The authored height, bounded; a missing or unusable one falls back to the position's default. */
function slotFraction(height: number | undefined, replaces: boolean): number {
  if (height === undefined || !Number.isFinite(height)) {
    return replaces ? 1 : CHART_SLOT_HEIGHT_BELOW;
  }
  return Math.min(1, Math.max(CHART_SLOT_HEIGHT_MIN, height));
}

/** The chart band inside an already-padded panel column: full column width, bottom-anchored so the text keeps the top whatever height the slot asks for, and the same `PANEL_PAD_FRACTION` margin the text has. Undefined when the frame has no slot or the scene switched it off. */
export function framePanelChartSlot(
  col: FramePanelLayout,
  slot: FrameChartSlot | undefined,
): FramePanelChartSlot | undefined {
  if (!slot || slot.enabled === false) return undefined;
  const replaces = slot.position === "replace";
  const height = col.height * slotFraction(slot.height, replaces);
  return {
    rect: { x: col.left + col.width / 2, y: col.bottom + height / 2, width: col.width, height },
    textBottom: col.bottom + height + CHART_SLOT_GAP_FRACTION * Math.min(col.width, col.height),
    replaces,
  };
}

export function framePanelLayout(format: FormatInfo, frame: FrameSpec): FramePanelLayout {
  const c = frameLayout(format.aspect, frame.cutout).content;
  const worldW = c.width * format.frame.width;
  const worldH = c.height * format.frame.height;
  // Normalised rect is y-down from the top-left; world is y-up centred on the frame.
  const contentLeft = (c.x - 0.5) * format.frame.width;
  const contentTop = (0.5 - c.y) * format.frame.height;
  const contentBottom = (0.5 - (c.y + c.height)) * format.frame.height;
  const pad = PANEL_PAD_FRACTION * Math.min(worldW, worldH);
  return {
    left: contentLeft + pad,
    top: contentTop - pad,
    bottom: contentBottom + pad,
    width: Math.max(0, worldW - 2 * pad),
    height: Math.max(0, worldH - 2 * pad),
  };
}
