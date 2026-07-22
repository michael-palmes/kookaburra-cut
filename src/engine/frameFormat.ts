/** Bridges the overlay cutout geometry to the format system: given an output format and a frame spec, resolves the cutout's own FormatInfo (so a scene lays out as if the cutout were the whole frame), its pixel rect in the full output, and the layout the mask needs. Pure; shared by SceneHost (the React layout override) and the compositor (the render seam) so both agree on the cutout. See docs/overlays.md. */

import { cutoutPixelRect, type FrameLayout, frameLayout } from "../toolkit/frame/frameLayout";
import type { FrameSpec } from "../toolkit/frame/types";
import type { FormatInfo } from "../toolkit/types";
import { computeFormat, type FormatSpec } from "./format";

export interface CutoutRender {
  /** What the scene's `useFormat()` returns: the cutout treated as its own frame. */
  format: FormatInfo;
  /** Where the cutout sits in the full output frame: top-left origin, y-down, pixels. */
  pixelRect: { x: number; y: number; width: number; height: number };
  /** Normalised cutout/content rects plus the SDF radius and exponent for the mask. */
  layout: FrameLayout;
}

export function resolveCutoutRender(format: FormatSpec, frame: FrameSpec): CutoutRender {
  const aspect = format.width / format.height;
  const layout = frameLayout(aspect, frame.cutout);
  const pixelRect = cutoutPixelRect(layout.cutout, format.width, format.height);
  const cutoutFormat = computeFormat({
    name: format.name,
    width: pixelRect.width,
    height: pixelRect.height,
  });
  return { format: cutoutFormat, pixelRect, layout };
}
