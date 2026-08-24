/** Bridges the overlay cutout geometry to the format system: given an output format and a frame spec, resolves the cutout's own FormatInfo (so a scene lays out as if the cutout were the whole frame), its pixel rect in the full output, and the layout the mask needs. Pure; shared by SceneHost (the React layout override) and the compositor (the render seam) so both agree on the cutout. See docs/overlays.md. */

import { cutoutPixelRect, type FrameLayout, frameLayout } from "../toolkit/frame/frameLayout";
import type { FrameSpec } from "../toolkit/frame/types";
import type { FormatInfo } from "../toolkit/types";
import { computeFormat, type FormatSpec } from "./format";

/** Whether the scene's world renders through a cutout instead of filling the frame. THE rule, read by `SceneHost`'s `useFormat()` narrowing, the compositor's scene target and the gizmo seam's `frameWorldCutout`, so layout and render cannot disagree: the SHAPE decides and the panel fill never does, a transparent panel included (docs/decisions.md, 2026-08-23). */
export function framesThroughCutout(frame: FrameSpec | undefined): boolean {
  return !!frame && frame.cutout.shape !== "none";
}

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
