import { describe, expect, it } from "vitest";
import { hexToOklch } from "../../theme/oklch";
import { builtinThemes } from "../../theme/registry";
import { CHART_PALETTE_SIZE } from "./palette";
import {
  CHART_PALETTE_SCHEME_IDS,
  CHART_PALETTE_SCHEMES,
  chartPaletteSwatches,
  isChartPaletteSchemeId,
} from "./paletteSchemes";

/** The curation contract for the named schemes. A scheme is background-agnostic (unlike a theme palette, curated against ONE background), so it must clear the graphical-object bar on the darkest AND the lightest bundled theme, which is what pins every swatch into a mid-tone band. Nothing but this file stops a later tweak shipping a scheme that vanishes on white or reads as one colour in a two-series chart. WCAG 2.x reference maths mirrors themePreset.test.ts. */

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

/** OKLab distance: the perceptual gap between two swatches, lightness and both chroma axes together. */
const gap = (a: string, b: string): number => {
  const x = hexToOklch(a);
  const y = hexToOklch(b);
  const ax = x.c * Math.cos((x.h * Math.PI) / 180);
  const bx = x.c * Math.sin((x.h * Math.PI) / 180);
  const ay = y.c * Math.cos((y.h * Math.PI) / 180);
  const by = y.c * Math.sin((y.h * Math.PI) / 180);
  return Math.hypot(x.l - y.l, ax - ay, bx - by);
};

const SCHEME_COUNT = 10;
/** Neighbouring indices are the two-series case, so they separate hardest; any two swatches in a set still have to be tellable apart in a legend. */
const MIN_NEIGHBOUR_GAP = 0.06;
const MIN_PAIR_GAP = 0.04;
/** Two schemes may share a temperature (Harbour and Slate are the saturated and the greyed blues), but never collapse onto each other index for index. */
const MIN_SCHEME_GAP = 0.045;
/** A neighbouring pair must also step in tone or saturation, not hue alone (the bundled-palette rule, chartColors.test.ts). */
const MIN_LIGHTNESS_STEP = 0.03;
const MIN_CHROMA_STEP = 0.02;

const backgrounds = Object.values(builtinThemes).map((t) => ({
  id: t.id,
  background: t.colors.background,
}));
const schemes = CHART_PALETTE_SCHEME_IDS.map((id) => CHART_PALETTE_SCHEMES[id]);

describe("chart palette schemes", () => {
  it("ships ten schemes, ids and catalogue agreeing", () => {
    expect(CHART_PALETTE_SCHEME_IDS.length).toBe(SCHEME_COUNT);
    expect(new Set(CHART_PALETTE_SCHEME_IDS).size).toBe(SCHEME_COUNT);
    expect(Object.keys(CHART_PALETTE_SCHEMES).sort()).toEqual([...CHART_PALETTE_SCHEME_IDS].sort());
    for (const id of CHART_PALETTE_SCHEME_IDS) {
      expect(CHART_PALETTE_SCHEMES[id].id).toBe(id);
      expect(CHART_PALETTE_SCHEMES[id].label.length).toBeGreaterThan(0);
    }
  });

  it("gives every scheme six well-formed, distinct swatches", () => {
    for (const scheme of schemes) {
      expect(scheme.swatches.length, scheme.id).toBe(CHART_PALETTE_SIZE);
      for (const swatch of scheme.swatches) expect(swatch, scheme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(new Set(scheme.swatches).size, scheme.id).toBe(CHART_PALETTE_SIZE);
    }
  });

  it("clears 3:1 against every bundled theme background, light and dark", () => {
    for (const scheme of schemes) {
      for (const swatch of scheme.swatches) {
        for (const { id, background } of backgrounds) {
          expect(contrast(swatch, background), `${scheme.id} ${swatch} on ${id}`).toBeGreaterThan(
            3,
          );
        }
      }
    }
  });

  it("separates neighbouring swatches, so a two-series chart never reads as one", () => {
    for (const scheme of schemes) {
      for (let i = 1; i < scheme.swatches.length; i++) {
        const prev = scheme.swatches[i - 1];
        const next = scheme.swatches[i];
        expect(gap(prev, next), `${scheme.id} ${prev} -> ${next}`).toBeGreaterThanOrEqual(
          MIN_NEIGHBOUR_GAP,
        );
        const a = hexToOklch(prev);
        const b = hexToOklch(next);
        const step =
          Math.abs(b.l - a.l) >= MIN_LIGHTNESS_STEP || Math.abs(b.c - a.c) >= MIN_CHROMA_STEP;
        expect(step, `${scheme.id} ${prev} -> ${next}`).toBe(true);
      }
    }
  });

  it("keeps every pair in a scheme tellable apart", () => {
    for (const scheme of schemes) {
      for (let i = 0; i < scheme.swatches.length; i++) {
        for (let j = i + 1; j < scheme.swatches.length; j++) {
          expect(
            gap(scheme.swatches[i], scheme.swatches[j]),
            `${scheme.id} ${scheme.swatches[i]} vs ${scheme.swatches[j]}`,
          ).toBeGreaterThanOrEqual(MIN_PAIR_GAP);
        }
      }
    }
  });

  it("keeps the ten schemes apart, so the picker offers ten looks and not five", () => {
    for (let i = 0; i < schemes.length; i++) {
      for (let j = i + 1; j < schemes.length; j++) {
        const a = schemes[i].swatches;
        const b = schemes[j].swatches;
        const mean = a.reduce((n, swatch, k) => n + gap(swatch, b[k]), 0) / a.length;
        expect(mean, `${schemes[i].id} vs ${schemes[j].id}`).toBeGreaterThanOrEqual(MIN_SCHEME_GAP);
      }
    }
  });
});

describe("chartPaletteSwatches", () => {
  it("returns the catalogue swatches for a known id", () => {
    expect(chartPaletteSwatches("harbour")).toEqual(CHART_PALETTE_SCHEMES.harbour.swatches);
    expect(chartPaletteSwatches(" harbour ")).toEqual(CHART_PALETTE_SCHEMES.harbour.swatches);
  });

  it("is null for absent, blank or unknown ids", () => {
    expect(chartPaletteSwatches(undefined)).toBeNull();
    expect(chartPaletteSwatches(null)).toBeNull();
    expect(chartPaletteSwatches("")).toBeNull();
    expect(chartPaletteSwatches("   ")).toBeNull();
    expect(chartPaletteSwatches("not-a-scheme")).toBeNull();
  });

  it("knows its own ids", () => {
    expect(isChartPaletteSchemeId("reef")).toBe(true);
    expect(isChartPaletteSchemeId("Reef")).toBe(false);
    expect(isChartPaletteSchemeId("nope")).toBe(false);
  });
});
