/** Resolves per-scene overlays for the compositor: the panel colour is turned to LINEAR here (on the CPU, where the theme is in hand) since the render seam has no theme, mirroring how the camera/state plans are pre-resolved before `renderComposited`. The cutout geometry is NOT resolved here: it depends on the live drawing-buffer size, so the compositor computes it. Pure. See docs/overlays.md. */

import { Color, SRGBColorSpace } from "three";
import type { GradientSpec, Theme, ThemeBackground } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import type { SceneDoc } from "./sceneDocSchema";

const COLOUR_TOKENS = ["background", "text", "accent", "muted"] as const;
type ColourToken = (typeof COLOUR_TOKENS)[number];

/** How far the default panel lifts from the theme background toward the text colour, in DISPLAY (sRGB) space: a neutral surface (dark grey on dark themes, light grey on light) so an overlay reads as a distinct panel without the author picking a colour. Blended in sRGB, not linear, so the lift is perceptually even and symmetric between modes. */
const PANEL_SURFACE_LIFT = 0.08;

/** How the slide pass fills the panel. `colour` is the flat fill `panelColor` carries (every legacy frame, and the unset default); `gradient`/`image` sample a texture the compositor resolves through `overlayPanelTexture.ts`; `transparent` paints no surface of its own, so with `shape: "none"` the scene renders full-bleed behind the overlay's content, and behind a shaped cutout the panel region takes the backdrop `panelColor` proxies. */
export type ResolvedPanelFill =
  | { kind: "colour" }
  | { kind: "transparent" }
  /** `key` is the texture cache's identity for `spec` (built once here, not per frame). */
  | { kind: "gradient"; key: string; spec: GradientSpec }
  | { kind: "image"; projectId: string; src: string };

const COLOUR_FILL: ResolvedPanelFill = { kind: "colour" };
const TRANSPARENT_FILL: ResolvedPanelFill = { kind: "transparent" };

export interface ResolvedOverlay {
  frame: FrameSpec;
  /** Panel fill in linear RGB, ready for the shader uniform; also what a gradient/image panel falls back to before its texture lands, and what a transparent panel fills the region outside a shaped cutout with. */
  panelColor: [number, number, number];
  panel: ResolvedPanelFill;
}

/** Cache identity for a baked gradient: the fields `gradientTexture` rasterises, nothing else. */
export function gradientCacheKey(spec: GradientSpec): string {
  return JSON.stringify([spec.type, spec.angleDeg, spec.space ?? "srgb", spec.stops]);
}

const _c = new Color();
const _bg = { r: 0, g: 0, b: 0 };
const _tx = { r: 0, g: 0, b: 0 };
const _stop = { r: 0, g: 0, b: 0 };

/** Unweighted sRGB mean of the gradient's stops: a cheap deterministic stand-in, not a perceptual sample. */
function meanStopHex(stops: GradientSpec["stops"]): string {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [hex] of stops) {
    _c.set(hex).getRGB(_stop, SRGBColorSpace);
    r += _stop.r;
    g += _stop.g;
    b += _stop.b;
  }
  const n = stops.length;
  _c.setRGB(r / n, g / n, b / n, SRGBColorSpace);
  return `#${_c.getHexString(SRGBColorSpace)}`;
}

/** The sRGB hex that best stands in for the VISIBLE backdrop: a colour fill is itself, a gradient averages its stops, and asset/procedural fills (image/video/shader/scene3d/none) fall back to the flat `colors.background` token. */
function backgroundProxyColour(bg: ThemeBackground | undefined, theme: Theme): string {
  if (bg?.type === "color") return bg.color;
  if (bg?.type === "gradient") {
    const spec = bg.spec ?? (bg.gradient ? theme.gradients?.[bg.gradient] : undefined);
    if (spec && spec.stops.length > 0) return meanStopHex(spec.stops);
  }
  return theme.colors.background;
}

/** The default panel: the scene's visible backdrop (proxied) nudged toward the theme's text colour in sRGB space, so it sits just off what is actually behind it, theme-aware in both modes. Returns LINEAR for the shader. */
function defaultPanelColour(
  theme: Theme,
  background: ThemeBackground | undefined,
): [number, number, number] {
  _c.set(backgroundProxyColour(background, theme)).getRGB(_bg, SRGBColorSpace);
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

/** A theme token id or hex to linear RGB; `undefined` (no override) takes the neutral surface default, and so do the sampled fills (their texture is the panel; this is only what shows before it lands). A transparent panel takes the backdrop PROXY with no lift: behind a shaped cutout the slide pass still has to fill everything outside the window, and the honest fill is the backdrop the panel is declining to cover (docs/decisions.md, 2026-08-23); a `shape: "none"` frame never paints it. Inputs are schema-validated upstream (`parseFrameSpec` keeps only a token or a hex), so `Color.set` always resolves. */
function resolvePanelColour(
  background: FrameSpec["background"],
  theme: Theme,
  sceneBackground: ThemeBackground | undefined,
): [number, number, number] {
  if (typeof background === "object" && background.type === "transparent") {
    _c.set(backgroundProxyColour(sceneBackground, theme));
    return [_c.r, _c.g, _c.b];
  }
  const colour =
    typeof background === "object"
      ? background.type === "color"
        ? background.color
        : undefined
      : background;
  if (colour === undefined) return defaultPanelColour(theme, sceneBackground);
  const hex = COLOUR_TOKENS.includes(colour as ColourToken)
    ? theme.colors[colour as ColourToken]
    : colour;
  _c.set(hex);
  return [_c.r, _c.g, _c.b];
}

/** Which fill route the slide pass takes. A plain string (and `{type:"color"}`) is the flat colour path, byte-identical to v1; a gradient bakes from an inline spec or the theme's named one; an image needs the project id to resolve its asset. An unresolvable gradient/image degrades to the flat colour, never to nothing. */
function resolvePanelFill(
  background: FrameSpec["background"],
  theme: Theme,
  projectId: string | undefined,
): ResolvedPanelFill {
  if (background === undefined || typeof background === "string") return COLOUR_FILL;
  switch (background.type) {
    case "transparent":
      return TRANSPARENT_FILL;
    case "gradient": {
      const spec =
        background.spec ??
        (background.gradient ? theme.gradients?.[background.gradient] : undefined);
      if (!spec) {
        console.warn(
          `[frame] panel gradient "${background.gradient ?? "?"}" not found in the theme`,
        );
        return COLOUR_FILL;
      }
      return { kind: "gradient", key: gradientCacheKey(spec), spec };
    }
    case "image":
      if (!projectId) return COLOUR_FILL;
      return { kind: "image", projectId, src: background.src };
    default:
      return COLOUR_FILL;
  }
}

/** Every project-relative image a panel fill references, for the preload barrier. */
export function overlayPanelImageSources(frames: readonly (FrameSpec | undefined)[]): string[] {
  const sources = new Set<string>();
  for (const frame of frames) {
    const background = frame?.background;
    if (background && typeof background === "object" && background.type === "image") {
      sources.add(background.src);
    }
  }
  return [...sources];
}

/** Index-parallel to scenes: a `ResolvedOverlay` where the scene has a frame, else null (the compositor renders that scene full-bleed on the legacy path). Returns null overall when no scene has a frame, so the caller can pass `undefined` and keep the byte-identical path. `docs` feeds the default panel its scene backdrop (`doc.background ?? theme.background`, the SceneBackground resolution); `projectId` is what an image panel resolves its asset against. */
export function resolveOverlays(
  frames: readonly (FrameSpec | undefined)[],
  themes: readonly Theme[],
  docs: readonly (SceneDoc | undefined)[] = [],
  projectId?: string,
): (ResolvedOverlay | null)[] | null {
  if (!frames.some(Boolean)) return null;
  return frames.map((frame, i) => {
    const theme = themes[i];
    if (!frame || !theme) return null;
    const background = docs[i]?.background ?? theme.background;
    return {
      frame,
      panelColor: resolvePanelColour(frame.background, theme, background),
      panel: resolvePanelFill(frame.background, theme, projectId),
    };
  });
}
