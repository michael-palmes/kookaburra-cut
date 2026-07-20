/** Resolves per-scene overlays for the compositor: the panel colour is turned to LINEAR here (on the CPU, where the theme is in hand) since the render seam has no theme, mirroring how the camera/state plans are pre-resolved before `renderComposited`. The cutout geometry is NOT resolved here: it depends on the live drawing-buffer size, so the compositor computes it. Pure. See docs/overlays.md. */

import { Color } from "three";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";

const COLOUR_TOKENS = ["background", "text", "accent", "muted"] as const;
type ColourToken = (typeof COLOUR_TOKENS)[number];

export interface ResolvedOverlay {
  frame: FrameSpec;
  /** Panel fill in linear RGB, ready for the shader uniform. */
  panelColor: [number, number, number];
}

const _c = new Color();

/** A theme token id or hex to linear RGB; `undefined` (no override) falls back to the theme background, the natural panel colour. Inputs are schema-validated upstream (`parseFrameSpec` keeps only a token or a hex), so `Color.set` always resolves. */
function resolvePanelColour(
  background: string | undefined,
  theme: Theme,
): [number, number, number] {
  const hex = COLOUR_TOKENS.includes(background as ColourToken)
    ? theme.colors[background as ColourToken]
    : (background ?? theme.colors.background);
  _c.set(hex);
  return [_c.r, _c.g, _c.b];
}

/** Index-parallel to scenes: a `ResolvedOverlay` where the scene has a frame, else null (the compositor renders that scene full-bleed on the legacy path). Returns null overall when no scene has a frame, so the caller can pass `undefined` and keep the byte-identical path. */
export function resolveOverlays(
  frames: readonly (FrameSpec | undefined)[],
  themes: readonly Theme[],
): (ResolvedOverlay | null)[] | null {
  if (!frames.some(Boolean)) return null;
  return frames.map((frame, i) => {
    const theme = themes[i];
    if (!frame || !theme) return null;
    return { frame, panelColor: resolvePanelColour(frame.background, theme) };
  });
}
