/** Resolves per-scene overlays for the compositor: the panel colour is turned to LINEAR here (on the CPU, where the theme is in hand) since the render seam has no theme, mirroring how the camera/state plans are pre-resolved before `renderComposited`. The cutout geometry is NOT resolved here: it depends on the live drawing-buffer size, so the compositor computes it. Pure. See docs/overlays.md. */

import { Color, SRGBColorSpace } from "three";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";

const COLOUR_TOKENS = ["background", "text", "accent", "muted"] as const;
type ColourToken = (typeof COLOUR_TOKENS)[number];

/** How far the default panel lifts from the theme background toward the text colour, in DISPLAY (sRGB) space: a neutral surface (dark grey on dark themes, light grey on light) so an overlay reads as a distinct panel without the author picking a colour. Blended in sRGB, not linear, so the lift is perceptually even and symmetric between modes. */
const PANEL_SURFACE_LIFT = 0.08;

export interface ResolvedOverlay {
  frame: FrameSpec;
  /** Panel fill in linear RGB, ready for the shader uniform. */
  panelColor: [number, number, number];
}

const _c = new Color();
const _bg = { r: 0, g: 0, b: 0 };
const _tx = { r: 0, g: 0, b: 0 };

/** The default panel: the theme background nudged toward its text colour in sRGB space, so it sits just off the scene background as a neutral surface, theme-aware in both modes. Returns LINEAR for the shader. */
function defaultPanelColour(theme: Theme): [number, number, number] {
  _c.set(theme.colors.background).getRGB(_bg, SRGBColorSpace);
  _c.set(theme.colors.text).getRGB(_tx, SRGBColorSpace);
  const f = PANEL_SURFACE_LIFT;
  _c.setRGB(
    _bg.r + f * (_tx.r - _bg.r),
    _bg.g + f * (_tx.g - _bg.g),
    _bg.b + f * (_tx.b - _bg.b),
    SRGBColorSpace,
  );
  return [_c.r, _c.g, _c.b];
}

/** A theme token id or hex to linear RGB; `undefined` (no override) takes the neutral surface default. Inputs are schema-validated upstream (`parseFrameSpec` keeps only a token or a hex), so `Color.set` always resolves. */
function resolvePanelColour(
  background: string | undefined,
  theme: Theme,
): [number, number, number] {
  if (background === undefined) return defaultPanelColour(theme);
  const hex = COLOUR_TOKENS.includes(background as ColourToken)
    ? theme.colors[background as ColourToken]
    : background;
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
