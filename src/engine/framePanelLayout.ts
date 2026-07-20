/** Pure layout for the overlay panel's text column: maps the frame's normalised `content` rect (the non-cutout region, from frameLayout) into world coordinates at the FULL frame, padded, so the panel primitives place title/subtitle/bullets/chip against real world anchors. No clock, no randomness. See docs/overlays.md. */

import { frameLayout } from "../toolkit/frame/frameLayout";
import type { FrameSpec } from "../toolkit/frame/types";
import type { FormatInfo } from "../toolkit/types";

/** Inner margin of the text column, as a fraction of the column's shorter world edge. */
export const PANEL_PAD_FRACTION = 0.08;

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
