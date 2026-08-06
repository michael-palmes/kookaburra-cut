/** Chart series colours: an authored override wins, then the chart's named colour scheme, then the theme's curated `chartColors` swatch, then a deterministic OKLCH ramp derived from the theme's accent. The ramp rotates hue in fixed steps and clamps lightness for contrast against the theme background, so a user theme with no curated palette still reads on light and dark alike. Pure: same theme in, same hexes out, on every machine (docs/determinism.md). */

import { bytesToHex, hexToOklch, type Oklch, oklchToBytes } from "../../theme/oklch";
import type { Theme } from "../../theme/tokens";
import { chartPaletteSwatches } from "./paletteSchemes";

/** The curated palette size the theme schema documents; the derived ramp matches it and series indices wrap. */
export const CHART_PALETTE_SIZE = 6;

const HUE_STEP = 60;
/** Lightness bands the ramp sits in, by background: dark themes take bright swatches, light themes deep ones. */
const DARK_BAND = { lo: 0.62, hi: 0.85 };
const LIGHT_BAND = { lo: 0.4, hi: 0.6 };
/** Minimum OKLCH lightness gap from the background, applied even when it pushes a swatch out of its band. */
const MIN_CONTRAST = 0.28;
const L_LIMITS = { lo: 0.2, hi: 0.92 };
const CHROMA_LIMITS = { lo: 0.09, hi: 0.19 };
/** Neighbouring swatches also step away from the background in lightness, so they differ by more than hue. */
const ALT_LIGHTNESS = 0.05;
const ALT_CHROMA = 0.92;
const ACHROMATIC = 1e-3;
/** Hue is numerically meaningless for a near-grey accent, so the ramp starts from a fixed one. */
const NEUTRAL_HUE = 250;
const CHROMA_STEPS = 12;
const L_TOLERANCE = 0.02;

const FALLBACK_BACKGROUND = "#000000";
const FALLBACK_ACCENT = "#3ad1c4";

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const hex = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return HEX.test(trimmed) ? trimmed : null;
};

const wrap = (index: number, length: number): number => {
  const i = Number.isFinite(index) ? Math.trunc(index) : 0;
  return ((i % length) + length) % length;
};

/** sRGB is not lightness-uniform: at a given lightness most hues cap well under the accent's chroma, and `oklchToBytes` clamps channels, which would eat the contrast the band bought. Step chroma down until the round trip holds the lightness. */
function inGamutHex(target: Oklch): string {
  for (let i = 0; i < CHROMA_STEPS; i++) {
    const c = (target.c * (CHROMA_STEPS - i)) / CHROMA_STEPS;
    const swatch = bytesToHex(oklchToBytes({ ...target, c }));
    if (Math.abs(hexToOklch(swatch).l - target.l) <= L_TOLERANCE) return swatch;
  }
  return bytesToHex(oklchToBytes({ ...target, c: 0 }));
}

/** The fallback ramp for themes with no curated `chartColors`: six hexes, derived from `colors.accent` and readable against `colors.background`. */
export function derivedChartPalette(theme: Theme): string[] {
  const background = hexToOklch(hex(theme.colors.background) ?? FALLBACK_BACKGROUND);
  const accent = hexToOklch(hex(theme.colors.accent) ?? FALLBACK_ACCENT);
  const light = background.l >= 0.5;
  const band = light ? LIGHT_BAND : DARK_BAND;
  const banded = clamp(accent.l, band.lo, band.hi);
  const contrasted = light
    ? Math.min(banded, background.l - MIN_CONTRAST)
    : Math.max(banded, background.l + MIN_CONTRAST);
  const base = clamp(contrasted, L_LIMITS.lo, L_LIMITS.hi);
  const chroma = clamp(accent.c, CHROMA_LIMITS.lo, CHROMA_LIMITS.hi);
  const hue = accent.c < ACHROMATIC ? NEUTRAL_HUE : accent.h;
  const away = light ? -ALT_LIGHTNESS : ALT_LIGHTNESS;

  return Array.from({ length: CHART_PALETTE_SIZE }, (_, i) => {
    const alt = i % 2 === 1;
    return inGamutHex({
      l: clamp(base + (alt ? away : 0), L_LIMITS.lo, L_LIMITS.hi),
      c: alt ? chroma * ALT_CHROMA : chroma,
      h: (hue + i * HUE_STEP) % 360,
    });
  });
}

/** The colour at a series (or, for pie, category) index of a resolved palette, wrapping like `resolveSeriesColour` does; an empty palette falls through to the caller's theme token. Every renderer, flat and 3D, indexes the `colours` prop through this, so one mark can never disagree with its legend entry. */
export function chartColourAt(colours: readonly string[], index: number, fallback: string): string {
  if (colours.length === 0) return fallback;
  return colours[wrap(index, colours.length)] ?? fallback;
}

/** The colour for one series: per-series `colour` override, else the chart's named scheme, else the theme swatch at that index, else the derived ramp. Indices wrap at every step, and a malformed hex falls through to the next source rather than painting a broken mark. An absent `scheme` is the pre-scheme path exactly, byte for byte. */
export function resolveSeriesColour(
  theme: Theme,
  index: number,
  override?: string | null,
  scheme?: string | null,
): string {
  const authored = hex(override);
  if (authored) return authored;
  const named = chartPaletteSwatches(scheme);
  if (named) {
    const picked = hex(named[wrap(index, named.length)]);
    if (picked) return picked;
  }
  const swatches = theme.chartColors;
  if (Array.isArray(swatches) && swatches.length > 0) {
    const themed = hex(swatches[wrap(index, swatches.length)]);
    if (themed) return themed;
  }
  const derived = derivedChartPalette(theme);
  return derived[wrap(index, derived.length)];
}
