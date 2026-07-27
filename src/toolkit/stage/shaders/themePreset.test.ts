import { describe, expect, it } from "vitest";
import { builtinThemes } from "../../../theme/registry";
import { SHADER_BACKGROUNDS } from "./index";
import { deriveThemeShaderColors, themePresetAnchor } from "./themePreset";

/** WCAG 2.x reference maths (mirrors presets.test.ts): the Theme preset must uphold the same bands and AA contract as the hand-tuned packs, for EVERY bundled theme, because it derives at render time where no reviewer eyeballs it. */

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

const themes = Object.values(builtinThemes);
const shaderIds = Object.keys(SHADER_BACKGROUNDS);

describe("deriveThemeShaderColors", () => {
  it("derives a full slot set for every bundled theme and shader", () => {
    for (const theme of themes) {
      for (const id of shaderIds) {
        const colors = deriveThemeShaderColors(id, theme);
        expect(colors, `${theme.id} ${id}`).not.toBeNull();
        expect(colors?.length, `${theme.id} ${id}`).toBe(SHADER_BACKGROUNDS[id].colorSlots.length);
      }
    }
  });

  it("keeps every stop inside the mode's luminance band (docs/backgrounds.md)", () => {
    for (const theme of themes) {
      const mode = theme.mode ?? "dark";
      for (const id of shaderIds) {
        for (const stop of deriveThemeShaderColors(id, theme) ?? []) {
          const l = luminance(stop);
          if (mode === "light") expect(l, `${theme.id} ${id} ${stop}`).toBeGreaterThanOrEqual(0.3);
          else expect(l, `${theme.id} ${id} ${stop}`).toBeLessThanOrEqual(0.125);
        }
      }
    }
  });

  it("holds AA against the theme's own text token and the pure text colour", () => {
    for (const theme of themes) {
      const pure = (theme.mode ?? "dark") === "light" ? "#000000" : "#ffffff";
      for (const id of shaderIds) {
        for (const stop of deriveThemeShaderColors(id, theme) ?? []) {
          expect(
            contrast(stop, theme.colors.text),
            `${theme.id} ${id} ${stop}`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(contrast(stop, pure), `${theme.id} ${id} ${stop}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("is deterministic and null for unknown shaders", () => {
    const theme = themes[0];
    expect(deriveThemeShaderColors("swirl", theme)).toEqual(
      deriveThemeShaderColors("swirl", theme),
    );
    expect(deriveThemeShaderColors("no-such-shader", theme)).toBeNull();
  });
});

describe("themePresetAnchor", () => {
  it("anchors light themes on p1 and dark themes on p6", () => {
    const light = themes.find((t) => t.mode === "light");
    const dark = themes.find((t) => (t.mode ?? "dark") === "dark");
    expect(light && themePresetAnchor("swirl", light)?.id).toBe("p1");
    expect(dark && themePresetAnchor("swirl", dark)?.id).toBe("p6");
  });
});
