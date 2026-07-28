import type { Theme } from "../../../theme/tokens";
import { SHADER_BACKGROUND_PRESETS } from "./presets";

/** The live "Theme" preset: shader colours derived from the active theme's tokens at resolve time, so a `themeColors: true` spec follows theme switches instead of going stale. Derivation retints the mode's anchor preset (`p1` light, `p6` dark) toward the theme's background and accent hues while preserving each anchor stop's relative luminance EXACTLY, so the docs/backgrounds.md bands (and therefore AA) hold by construction for any theme whose text token respects the theme contract. Pure and deterministic: same shader + theme in, same hexes out, on every machine (docs/determinism.md). */

type Rgb = [number, number, number];

/** Never take a stop all the way to the raw accent: presets stay muted (docs/backgrounds.md). */
const ACCENT_CEILING = 0.7;
/** Linear-space saturation cap; vivid accent tokens get pulled toward grey past this. */
const MAX_SATURATION = 0.6;

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function parseHex(hex: string): Rgb | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = Number.parseInt(hex.slice(1), 16);
  return [lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255)];
}

const luminance = (rgb: Rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

function toHex(rgb: Rgb): string {
  const byte = (c: number) =>
    Math.round(srgb(Math.min(Math.max(c, 0), 1)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Scale to the target luminance; on channel overflow, mix toward same-luminance grey (a luminance-preserving desaturate) just enough to fit. */
function withLuminance(rgb: Rgb, target: number): Rgb {
  const L = luminance(rgb);
  if (L <= 0) return [target, target, target];
  const scaled = rgb.map((c) => (c * target) / L) as Rgb;
  const peak = Math.max(...scaled);
  if (peak <= 1) return scaled;
  const s = (peak - 1) / (peak - target);
  return mix(scaled, [target, target, target], s);
}

function capSaturation(rgb: Rgb): Rgb {
  const peak = Math.max(...rgb);
  if (peak <= 0) return rgb;
  const sat = (peak - Math.min(...rgb)) / peak;
  if (sat <= MAX_SATURATION) return rgb;
  const grey = luminance(rgb);
  return mix(rgb, [grey, grey, grey], 1 - MAX_SATURATION / sat);
}

/** The retint core, shared by the shader and 3D Theme presets: derive stops from ANY anchor palette by preserving its luminances exactly while tinting toward the theme's background and accent hues. Null on a malformed token or anchor. */
export function deriveThemeColorsFromAnchor(anchorColors: string[], theme: Theme): string[] | null {
  const mode = theme.mode ?? "dark";
  const background = parseHex(theme.colors.background);
  const accent = parseHex(theme.colors.accent);
  if (!background || !accent) return null;

  const anchorRgb = anchorColors.map(parseHex);
  if (anchorRgb.some((c) => c === null)) return null;
  const levels = (anchorRgb as Rgb[]).map(luminance);
  // Luminance rank, 0 = darkest stop: dark presets carry the accent in their bright stops, light presets in their deep stops (matching how the hand-tuned packs are built).
  const sorted = [...levels].sort((a, b) => a - b);
  return levels.map((level) => {
    const t = levels.length === 1 ? 1 : sorted.indexOf(level) / (levels.length - 1);
    const accentAmount = ACCENT_CEILING * (mode === "light" ? 1 - t : t);
    return toHex(withLuminance(capSaturation(mix(background, accent, accentAmount)), level));
  });
}

/** Derived slot colours for a `themeColors` shader spec, or null when the shader (or a malformed token) can't derive; callers fall back to slot fallbacks. */
export function deriveThemeShaderColors(shader: string, theme: Theme): string[] | null {
  const anchor = themePresetAnchor(shader, theme);
  return anchor ? deriveThemeColorsFromAnchor(anchor.colors, theme) : null;
}

/** The anchor preset backing the Theme tile's motion (speed, zoom, params): `p1` for light themes, `p6` for dark. */
export function themePresetAnchor(shader: string, theme: Theme) {
  const mode = theme.mode ?? "dark";
  return SHADER_BACKGROUND_PRESETS[shader]?.find((p) => p.id === (mode === "light" ? "p1" : "p6"));
}
