import { describe, expect, it } from "vitest";
import { builtinThemes } from "../../theme/registry";
import type { Theme } from "../../theme/tokens";
import {
  CHART_PALETTE_SIZE,
  chartColourAt,
  derivedChartPalette,
  resolveSeriesColour,
} from "./palette";
import { CHART_PALETTE_SCHEMES } from "./paletteSchemes";

/** WCAG 2.x reference maths (mirrors themePreset.test.ts): chart marks are graphical objects, so 3:1 against the theme background is the bar every derived swatch must clear, on every theme, because it derives at render time where no reviewer eyeballs it. */
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * lin(((n >> 16) & 255) / 255) +
    0.7152 * lin(((n >> 8) & 255) / 255) +
    0.0722 * lin((n & 255) / 255)
  );
};
const contrast = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const themes = Object.values(builtinThemes);
const dark = builtinThemes["kookaburra-default"];
const light = builtinThemes["kookaburra-pacific"];

const withColours = (theme: Theme, background: string, accent: string): Theme => ({
  ...theme,
  colors: { ...theme.colors, background, accent },
});

const withSwatches = (theme: Theme, chartColors: string[]): Theme => ({
  ...theme,
  chartColors,
});

/** Every bundled theme now ships a curated palette, so the derived-ramp fallback needs a theme stripped of one. */
const bare = (theme: Theme): Theme => ({ ...theme, chartColors: undefined });

describe("derivedChartPalette", () => {
  it("pins the ramp for a dark theme", () => {
    expect(derivedChartPalette(dark)).toEqual([
      "#3ad1c4",
      "#88cfff",
      "#cca2f6",
      "#ffa8bc",
      "#eda75b",
      "#b5d583",
    ]);
  });

  it("pins the ramp for a light theme", () => {
    expect(derivedChartPalette(light)).toEqual([
      "#1e43b8",
      "#6f0875",
      "#a1000c",
      "#6d3500",
      "#006a00",
      "#00525f",
    ]);
  });

  it("is deterministic: same theme in, same hexes out", () => {
    for (const theme of themes) {
      expect(derivedChartPalette(theme)).toEqual(derivedChartPalette({ ...theme }));
    }
  });

  it("gives every bundled theme six distinct, well-formed swatches", () => {
    for (const theme of themes) {
      const palette = derivedChartPalette(theme);
      expect(palette.length, theme.id).toBe(CHART_PALETTE_SIZE);
      for (const swatch of palette) expect(swatch, theme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(new Set(palette).size, theme.id).toBe(CHART_PALETTE_SIZE);
    }
  });

  it("clears 3:1 against every bundled theme's background", () => {
    for (const theme of themes) {
      for (const swatch of derivedChartPalette(theme)) {
        expect(
          contrast(swatch, theme.colors.background),
          `${theme.id} ${swatch}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("holds contrast on hostile themes: mid grey, and tokens with no hue at all", () => {
    const hostile = [
      withColours(dark, "#777777", "#3ad1c4"),
      withColours(dark, "#808080", "#888888"),
      withColours(dark, "#ffffff", "#ffffff"),
      withColours(dark, "#000000", "#000000"),
    ];
    for (const theme of hostile) {
      for (const swatch of derivedChartPalette(theme)) {
        expect(contrast(swatch, theme.colors.background), swatch).toBeGreaterThanOrEqual(2.5);
      }
    }
  });

  it("keeps colour when the accent is a neutral", () => {
    const palette = derivedChartPalette(withColours(dark, "#0b0f14", "#9a9a9a"));
    for (const swatch of palette) {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(swatch.slice(i, i + 2), 16));
      expect(Math.max(r, g, b) - Math.min(r, g, b), swatch).toBeGreaterThan(20);
    }
  });

  it("follows the background: the same accent ramps bright on dark and deep on light", () => {
    const onDark = derivedChartPalette(withColours(dark, "#0b0f14", "#3ad1c4"));
    const onLight = derivedChartPalette(withColours(dark, "#ffffff", "#3ad1c4"));
    expect(onDark).not.toEqual(onLight);
    expect(luminance(onDark[0])).toBeGreaterThan(luminance(onLight[0]));
  });

  it("degrades a malformed token to a readable ramp instead of throwing", () => {
    const broken = withColours(dark, "not-a-colour", "");
    expect(derivedChartPalette(broken).length).toBe(CHART_PALETTE_SIZE);
  });
});

describe("resolveSeriesColour", () => {
  it("takes the derived ramp when the theme has no palette", () => {
    const palette = derivedChartPalette(dark);
    expect(resolveSeriesColour(bare(dark), 0)).toBe(palette[0]);
    expect(resolveSeriesColour(bare(dark), 2)).toBe(palette[2]);
  });

  it("prefers a bundled theme's curated palette over the derived ramp", () => {
    expect(resolveSeriesColour(dark, 2)).toBe(dark.chartColors?.[2]);
  });

  it("prefers the theme palette over the derived ramp", () => {
    const themed = withSwatches(dark, ["#112233", "#445566"]);
    expect(resolveSeriesColour(themed, 0)).toBe("#112233");
    expect(resolveSeriesColour(themed, 1)).toBe("#445566");
  });

  it("prefers a per-series override over everything", () => {
    const themed = withSwatches(dark, ["#112233", "#445566"]);
    expect(resolveSeriesColour(themed, 0, "#f0a848")).toBe("#f0a848");
    expect(resolveSeriesColour(dark, 0, "#fff")).toBe("#fff");
  });

  it("ignores an absent or malformed override", () => {
    const palette = derivedChartPalette(dark);
    const plain = bare(dark);
    expect(resolveSeriesColour(plain, 0, null)).toBe(palette[0]);
    expect(resolveSeriesColour(plain, 0, undefined)).toBe(palette[0]);
    expect(resolveSeriesColour(plain, 0, "rebeccapurple")).toBe(palette[0]);
    expect(resolveSeriesColour(plain, 0, "#12345")).toBe(palette[0]);
  });

  it("falls through to the derived ramp on a malformed theme swatch", () => {
    const themed = withSwatches(dark, ["#112233", "oops"]);
    expect(resolveSeriesColour(themed, 1)).toBe(derivedChartPalette(dark)[1]);
  });

  it("wraps the index past the end of either palette", () => {
    const palette = derivedChartPalette(dark);
    const plain = bare(dark);
    expect(resolveSeriesColour(plain, CHART_PALETTE_SIZE)).toBe(palette[0]);
    expect(resolveSeriesColour(plain, CHART_PALETTE_SIZE + 1)).toBe(palette[1]);
    expect(resolveSeriesColour(plain, -1)).toBe(palette[CHART_PALETTE_SIZE - 1]);
    const themed = withSwatches(dark, ["#112233", "#445566"]);
    expect(resolveSeriesColour(themed, 4)).toBe("#112233");
    expect(resolveSeriesColour(themed, 5)).toBe("#445566");
  });

  it("survives a broken index or an empty palette", () => {
    const palette = derivedChartPalette(dark);
    expect(resolveSeriesColour(bare(dark), Number.NaN)).toBe(palette[0]);
    expect(resolveSeriesColour(withSwatches(dark, []), 3)).toBe(palette[3]);
  });
});

/** The named-scheme rung of the ladder: override > scheme > theme chartColors > derived ramp. The unset case is the whole determinism argument, so it is pinned against the pre-scheme answer rather than a literal. */
describe("resolveSeriesColour with a named scheme", () => {
  const reef = CHART_PALETTE_SCHEMES.reef.swatches;

  it("resolves identically to the theme path when no scheme is set", () => {
    for (const theme of themes) {
      for (let i = 0; i < CHART_PALETTE_SIZE + 2; i++) {
        expect(resolveSeriesColour(theme, i, null, null), theme.id).toBe(
          resolveSeriesColour(theme, i),
        );
        expect(resolveSeriesColour(theme, i, null, undefined), theme.id).toBe(
          resolveSeriesColour(theme, i),
        );
        expect(resolveSeriesColour(theme, i, null, ""), theme.id).toBe(
          resolveSeriesColour(theme, i),
        );
      }
    }
  });

  it("prefers the scheme over the theme palette and the derived ramp", () => {
    expect(resolveSeriesColour(dark, 0, null, "reef")).toBe(reef[0]);
    expect(resolveSeriesColour(dark, 2, null, "reef")).toBe(reef[2]);
    expect(resolveSeriesColour(bare(light), 3, null, "reef")).toBe(reef[3]);
    expect(resolveSeriesColour(withSwatches(dark, ["#112233"]), 0, null, "reef")).toBe(reef[0]);
  });

  it("still lets a per-series override win", () => {
    expect(resolveSeriesColour(dark, 1, "#f0a848", "reef")).toBe("#f0a848");
  });

  it("wraps the scheme index like every other source", () => {
    expect(resolveSeriesColour(dark, CHART_PALETTE_SIZE, null, "reef")).toBe(reef[0]);
    expect(resolveSeriesColour(dark, -1, null, "reef")).toBe(reef[CHART_PALETTE_SIZE - 1]);
    expect(resolveSeriesColour(dark, Number.NaN, null, "reef")).toBe(reef[0]);
  });

  it("falls through to the theme on an unknown scheme id", () => {
    expect(resolveSeriesColour(dark, 2, null, "not-a-scheme")).toBe(resolveSeriesColour(dark, 2));
    expect(resolveSeriesColour(bare(dark), 2, null, "not-a-scheme")).toBe(
      derivedChartPalette(dark)[2],
    );
  });
});

describe("chartColourAt", () => {
  it("wraps the palette", () => {
    expect(chartColourAt(["#111111", "#222222"], 3, "#000000")).toBe("#222222");
    expect(chartColourAt(["#111111", "#222222"], -1, "#000000")).toBe("#222222");
  });

  it("falls back on an empty palette or a broken index", () => {
    expect(chartColourAt([], 0, "#abcdef")).toBe("#abcdef");
    expect(chartColourAt(["#111111", "#222222"], Number.NaN, "#000000")).toBe("#111111");
  });
});
