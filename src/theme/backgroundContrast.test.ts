import { describe, expect, it } from "vitest";
import { SCENE3D_BACKGROUND_PRESETS, SCENE3D_BACKGROUNDS } from "../toolkit/stage/scene3d";
import { SHADER_BACKGROUND_PRESETS, SHADER_BACKGROUNDS } from "../toolkit/stage/shaders";
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

const newThemes = filterThemeCatalogue(BUILTIN_THEME_CATALOGUE).filter(
  ({ catalogue }) => catalogue.category !== "essentials",
);

function visibleColours(entry: ThemeCatalogueEntry): string[] {
  const { theme } = entry;
  const colours = [theme.colors.background];
  const background = theme.background;
  if (background?.type === "shader") colours.push(...(background.colors ?? []));
  if (background?.type === "scene3d") {
    colours.push(...(background.colors ?? []));
    if (background.backing?.type === "color") colours.push(background.backing.color);
  }
  return [...new Set(colours)];
}

function chartSurfaceColours(entry: ThemeCatalogueEntry): string[] {
  const background = entry.theme.background;
  if (background?.type !== "scene3d") return visibleColours(entry);
  const colours = [entry.theme.colors.background];
  if (background.backing?.type === "color") colours.push(background.backing.color);
  return [...new Set(colours)];
}

const STATIC_BACKGROUND_SOURCES = [
  "kookaburra:linen-intelligence",
  "kookaburra:velvet-physics",
] as const;

describe("expanded theme library", () => {
  it("ships four stage-free themes in every new use-case category", () => {
    expect(newThemes).toHaveLength(24);
    for (const category of THEME_CATEGORIES.filter(({ id }) => id !== "essentials")) {
      const entries = newThemes.filter(({ catalogue }) => catalogue.category === category.id);
      expect(entries, category.label).toHaveLength(4);
      expect(
        entries.map(({ catalogue }) => catalogue.order),
        category.label,
      ).toEqual([10, 20, 30, 40]);
    }
    for (const { id, theme, catalogue } of newThemes) {
      expect(catalogue.stage, id).toBe("lighting-only");
      expect(theme.lighting, id).toBeDefined();
      expect(theme.environment, id).toBeUndefined();
      expect(theme.backdrop, id).toBeUndefined();
    }
  });

  it("uses every shipped procedural background family and two static artworks", () => {
    const shaders = new Set<string>();
    const scene3d = new Set<string>();
    const images = new Set<string>();
    for (const { theme } of newThemes) {
      if (theme.background?.type === "shader") shaders.add(theme.background.shader);
      if (theme.background?.type === "scene3d") scene3d.add(theme.background.look);
      if (theme.background?.type === "image") images.add(theme.background.src);
    }
    expect([...shaders].sort()).toEqual(Object.keys(SHADER_BACKGROUNDS).sort());
    expect([...scene3d].sort()).toEqual(Object.keys(SCENE3D_BACKGROUNDS).sort());
    expect([...images].sort()).toEqual([...STATIC_BACKGROUND_SOURCES].sort());
  });

  it("copies every procedural preset exactly and matches its declared mode", () => {
    for (const { id, theme } of newThemes) {
      const background = theme.background;
      if (background?.type === "shader") {
        const preset = SHADER_BACKGROUND_PRESETS[background.shader]?.find(
          ({ id }) => id === background.preset,
        );
        expect(preset, id).toBeDefined();
        expect(theme.mode, id).toBe(preset?.mode);
        expect(background.colors, id).toEqual(preset?.colors);
        expect(background.speed, id).toBe(preset?.speed);
        expect(background.scale, id).toBe(preset?.scale);
        expect(background.params, id).toEqual(preset?.params);
        expect(background.colors, id).toHaveLength(
          SHADER_BACKGROUNDS[background.shader]?.colorSlots.length,
        );
      }
      if (background?.type === "scene3d") {
        const preset = SCENE3D_BACKGROUND_PRESETS[background.look]?.find(
          ({ id }) => id === background.preset,
        );
        expect(preset, id).toBeDefined();
        expect(theme.mode, id).toBe(preset?.mode);
        expect(background.colors, id).toEqual(preset?.colors);
        expect(background.speed, id).toBe(preset?.speed);
        expect(background.params, id).toEqual(preset?.params);
        expect(background.backing, id).toEqual({ type: "color", color: preset?.backing });
        expect(background.colors, id).toHaveLength(
          SCENE3D_BACKGROUNDS[background.look]?.colorSlots.length,
        );
      }
    }
  });

  it("holds AA text and muted contrast over every procedural colour", () => {
    const failures: string[] = [];
    for (const entry of newThemes) {
      if (entry.theme.background?.type === "image") continue;
      for (const colour of visibleColours(entry)) {
        const textContrast = contrast(entry.theme.colors.text, colour);
        if (textContrast < 4.5) {
          failures.push(`${entry.id} text on ${colour}: ${textContrast.toFixed(2)}`);
        }
        const mutedContrast = contrast(entry.theme.colors.muted, colour);
        if (mutedContrast < 4.5) {
          failures.push(`${entry.id} muted on ${colour}: ${mutedContrast.toFixed(2)}`);
        }
      }
      for (const colour of chartSurfaceColours(entry)) {
        for (const swatch of entry.theme.chartColors ?? []) {
          const chartContrast = contrast(swatch, colour);
          if (chartContrast < 3) {
            failures.push(`${entry.id} chart ${swatch} on ${colour}: ${chartContrast.toFixed(2)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
