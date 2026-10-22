import { describe, expect, it } from "vitest";
import { SCENE3D_BACKGROUNDS } from "../toolkit/stage/scene3d";
import { SHADER_BACKGROUNDS } from "../toolkit/stage/shaders";
import { filterThemeCatalogue, THEME_CATEGORIES, type ThemeCatalogueEntry } from "./catalogue";
import { BUILTIN_THEME_CATALOGUE } from "./registry";

const lin = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * lin(((value >> 16) & 255) / 255) +
    0.7152 * lin(((value >> 8) & 255) / 255) +
    0.0722 * lin((value & 255) / 255)
  );
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const lineup = filterThemeCatalogue(BUILTIN_THEME_CATALOGUE);

/** Readability first: headline text, secondary labels and accents hold these over every colour the background can show. */
const MIN_TEXT = 10;
const MIN_MUTED = { light: 5.5, dark: 7 } as const;
const MIN_ACCENT = 4.5;
const MIN_CHART = 3;
/** A calm background: its darkest and lightest stops stay this close, so motion never competes with the copy. */
const MAX_BACKGROUND_SPREAD = 1.35;

function visibleColours({ theme }: ThemeCatalogueEntry): string[] {
  const colours = [theme.colors.background];
  const background = theme.background;
  if (background?.type === "gradient") {
    const spec = background.spec ?? theme.gradients?.[background.gradient ?? ""];
    colours.push(...(spec?.stops.map(([colour]) => colour) ?? []));
  }
  if (background?.type === "shader") colours.push(...(background.colors ?? []));
  if (background?.type === "scene3d") {
    colours.push(...(background.colors ?? []));
    if (background.backing?.type === "color") colours.push(background.backing.color);
  }
  return [...new Set(colours)];
}

describe("bundled theme lineup", () => {
  it("ships twenty-two visible themes across Essentials, Studio, Colour and Retro", () => {
    expect(lineup).toHaveLength(22);
    const sizes = Object.fromEntries(
      THEME_CATEGORIES.map(({ id }) => [
        id,
        lineup.filter(({ catalogue }) => catalogue.category === id).length,
      ]),
    );
    expect(sizes).toEqual({ essentials: 4, studio: 6, colour: 6, retro: 6 });
    expect(lineup.filter(({ theme }) => theme.mode === "light")).toHaveLength(14);
    for (const { id, theme, catalogue } of lineup) {
      expect(catalogue.stage, id).toBe("lighting-only");
      expect(theme.lighting, id).toBeDefined();
      expect(theme.environment, id).toBeDefined();
      expect(theme.backdrop, id).toBeUndefined();
      expect(theme.effects, id).toBeUndefined();
    }
  });

  it("keeps animated backgrounds to known looks with every slot filled", () => {
    for (const { id, theme } of lineup) {
      const background = theme.background;
      expect(background, id).toBeDefined();
      if (background?.type === "shader") {
        expect(background.colors, id).toHaveLength(
          SHADER_BACKGROUNDS[background.shader]?.colorSlots.length ?? -1,
        );
        expect(background.speed ?? 1, id).toBeLessThanOrEqual(0.5);
      }
      if (background?.type === "scene3d") {
        expect(background.colors, id).toHaveLength(
          SCENE3D_BACKGROUNDS[background.look]?.colorSlots.length ?? -1,
        );
      }
      expect(["gradient", "shader", "scene3d"], id).toContain(background?.type);
    }
  });

  it("holds text, labels, accents and charts over every background colour", () => {
    const failures: string[] = [];
    for (const entry of lineup) {
      const { colors, chartColors = [], mode = "dark" } = entry.theme;
      const checks: [string, string, number][] = [
        ["text", colors.text, MIN_TEXT],
        ["muted", colors.muted, MIN_MUTED[mode]],
        ["accent", colors.accent, MIN_ACCENT],
        ...chartColors.map((swatch): [string, string, number] => ["chart", swatch, MIN_CHART]),
      ];
      for (const colour of visibleColours(entry)) {
        for (const [role, value, minimum] of checks) {
          const ratio = contrast(value, colour);
          if (ratio < minimum) {
            failures.push(`${entry.id} ${role} ${value} on ${colour}: ${ratio.toFixed(2)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps every background calm", () => {
    for (const entry of lineup) {
      const levels = visibleColours(entry).map(luminance);
      const spread = (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05);
      expect(spread, entry.id).toBeLessThanOrEqual(MAX_BACKGROUND_SPREAD);
    }
  });
});
