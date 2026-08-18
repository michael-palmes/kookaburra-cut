import { describe, expect, it } from "vitest";
import { hexToOklch } from "./oklch";
import { builtinThemes } from "./registry";

/** The curation contract for the bundled `chartColors` palettes. They are hand-picked, so nothing but this file stops a later tweak quietly shipping a series colour that vanishes into its own background: chart marks are graphical objects, so 3:1 (WCAG 2.x non-text) against `colors.background` is the bar, on every theme. Mirrors the reference maths in themePreset.test.ts. */

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = lin(((n >> 16) & 255) / 255);
  const g = lin(((n >> 8) & 255) / 255);
  const b = lin((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Shortest arc between two OKLCH hues, in degrees. */
const hueGap = (a: string, b: string): number => {
  const d = Math.abs(hexToOklch(a).h - hexToOklch(b).h) % 360;
  return d > 180 ? 360 - d : d;
};

const perceptualGap = (a: string, b: string): number => {
  const first = hexToOklch(a);
  const second = hexToOklch(b);
  const firstA = first.c * Math.cos((first.h * Math.PI) / 180);
  const firstB = first.c * Math.sin((first.h * Math.PI) / 180);
  const secondA = second.c * Math.cos((second.h * Math.PI) / 180);
  const secondB = second.c * Math.sin((second.h * Math.PI) / 180);
  return Math.hypot(first.l - second.l, firstA - secondA, firstB - secondB);
};

const PALETTE_SIZE = 6;
/** A neighbouring pair must step in tone or saturation, not hue alone: hue-only steps collapse for the ~8% of viewers with a colour vision deficiency, and read as one block on a projector. */
const MIN_LIGHTNESS_STEP = 0.03;
const MIN_CHROMA_STEP = 0.02;
const MIN_PAIR_GAP = 0.04;
/** How far a hand-picked first swatch may drift from the theme accent before it stops reading as the same brand colour. */
const MAX_ACCENT_HUE_DRIFT = 12;

const themes = Object.values(builtinThemes);

describe("bundled chartColors palettes", () => {
  it("gives every bundled theme six well-formed, distinct swatches", () => {
    for (const theme of themes) {
      const palette = theme.chartColors;
      expect(palette, theme.id).toBeDefined();
      expect(palette?.length, theme.id).toBe(PALETTE_SIZE);
      for (const swatch of palette ?? []) expect(swatch, theme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(new Set(palette).size, theme.id).toBe(PALETTE_SIZE);
    }
  });

  it("clears 3:1 against its own theme background, every swatch", () => {
    for (const theme of themes) {
      for (const swatch of theme.chartColors ?? []) {
        expect(
          contrast(swatch, theme.colors.background),
          `${theme.id} ${swatch}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("steps neighbouring swatches in lightness or chroma, not hue alone", () => {
    for (const theme of themes) {
      const palette = theme.chartColors ?? [];
      for (let i = 1; i < palette.length; i++) {
        const prev = hexToOklch(palette[i - 1]);
        const next = hexToOklch(palette[i]);
        const step =
          Math.abs(next.l - prev.l) >= MIN_LIGHTNESS_STEP ||
          Math.abs(next.c - prev.c) >= MIN_CHROMA_STEP;
        expect(step, `${theme.id} ${palette[i - 1]} -> ${palette[i]}`).toBe(true);
      }
    }
  });

  it("keeps every pair in a palette perceptually distinct", () => {
    for (const theme of themes) {
      const palette = theme.chartColors ?? [];
      for (let first = 0; first < palette.length; first++) {
        for (let second = first + 1; second < palette.length; second++) {
          expect(
            perceptualGap(palette[first], palette[second]),
            `${theme.id} ${palette[first]} vs ${palette[second]}`,
          ).toBeGreaterThanOrEqual(MIN_PAIR_GAP);
        }
      }
    }
  });

  it("harmonises the first swatch with the theme accent", () => {
    for (const theme of themes) {
      const first = theme.chartColors?.[0] ?? "";
      const accent = theme.colors.accent;
      if (first === accent) continue;
      // Only Sunrise and Loft deepen their accent, and only because the accent itself misses the bar on their pale backgrounds.
      expect(contrast(accent, theme.colors.background), theme.id).toBeLessThan(3);
      expect(hueGap(first, accent), `${theme.id} ${first} vs ${accent}`).toBeLessThanOrEqual(
        MAX_ACCENT_HUE_DRIFT,
      );
    }
  });
});
