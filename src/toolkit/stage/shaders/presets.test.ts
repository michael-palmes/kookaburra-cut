import { describe, expect, it } from "vitest";
import { SHADER_BACKGROUND_IDS, SHADER_BACKGROUNDS } from "./index";
import { SHADER_BACKGROUND_PRESETS } from "./presets";

// Schema clamp bounds from parseBackgroundSpec; a preset outside them would mutate on first save.
const SPEED_MAX = 4;
const SCALE_MIN = 0.1;
const SCALE_MAX = 4;

// The colour contract (docs/backgrounds.md): the fill animates under foreground text, so EVERY
// stop must hold AA alone. The bands guarantee >=6:1 against the preset's pure text colour and
// keep AA for the softest bundled theme text token (#dce4f2 needs dark stops <=0.127).
const LIGHT_MIN_LUMINANCE = 0.3;
const DARK_MAX_LUMINANCE = 0.125;
const MIN_CONTRAST = 4.5;

function relativeLuminance(hex: string): number {
  const lin = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

describe("shader background presets", () => {
  it("covers every shader with exactly 9 presets and no strays", () => {
    expect(Object.keys(SHADER_BACKGROUND_PRESETS).sort()).toEqual(
      [...SHADER_BACKGROUND_IDS].sort(),
    );
    for (const id of SHADER_BACKGROUND_IDS) {
      expect(SHADER_BACKGROUND_PRESETS[id]).toHaveLength(9);
    }
  });

  it("uses unique p1..p9 ids per shader, light first", () => {
    for (const presets of Object.values(SHADER_BACKGROUND_PRESETS)) {
      expect(presets.map((p) => p.id)).toEqual([
        "p1",
        "p2",
        "p3",
        "p4",
        "p5",
        "p6",
        "p7",
        "p8",
        "p9",
      ]);
      expect(presets.map((p) => p.mode)).toEqual([
        ...Array.from({ length: 5 }, () => "light"),
        ...Array.from({ length: 4 }, () => "dark"),
      ]);
    }
  });

  it("fills every colour slot with a valid hex", () => {
    for (const [shader, presets] of Object.entries(SHADER_BACKGROUND_PRESETS)) {
      const def = SHADER_BACKGROUNDS[shader];
      for (const preset of presets) {
        expect(preset.colors, `${shader}/${preset.id}`).toHaveLength(def.colorSlots.length);
        for (const hex of preset.colors) {
          expect(hex, `${shader}/${preset.id}`).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("holds AA contrast against the preset's text colour on every stop", () => {
    for (const [shader, presets] of Object.entries(SHADER_BACKGROUND_PRESETS)) {
      for (const preset of presets) {
        const at = `${shader}/${preset.id}`;
        expect(preset.textColor, at).toBe(preset.mode === "light" ? "#000000" : "#ffffff");
        const textLuminance = preset.mode === "light" ? 0 : 1;
        for (const hex of preset.colors) {
          const luminance = relativeLuminance(hex);
          if (preset.mode === "light") {
            expect(luminance, `${at} ${hex}`).toBeGreaterThanOrEqual(LIGHT_MIN_LUMINANCE);
          } else {
            expect(luminance, `${at} ${hex}`).toBeLessThanOrEqual(DARK_MAX_LUMINANCE);
          }
          expect(contrastRatio(luminance, textLuminance), `${at} ${hex}`).toBeGreaterThanOrEqual(
            MIN_CONTRAST,
          );
        }
      }
    }
  });

  it("seeds every shader's slot fallbacks from its first dark preset", () => {
    for (const [shader, presets] of Object.entries(SHADER_BACKGROUND_PRESETS)) {
      const firstDark = presets.find((p) => p.mode === "dark");
      expect(firstDark, shader).toBeDefined();
      expect(
        SHADER_BACKGROUNDS[shader].colorSlots.map((slot) => slot.fallback),
        shader,
      ).toEqual(firstDark?.colors);
    }
  });

  it("keeps speed/scale inside the schema clamp bounds", () => {
    for (const [shader, presets] of Object.entries(SHADER_BACKGROUND_PRESETS)) {
      for (const preset of presets) {
        const at = `${shader}/${preset.id}`;
        if (preset.speed !== undefined) {
          expect(preset.speed, at).toBeGreaterThanOrEqual(0);
          expect(preset.speed, at).toBeLessThanOrEqual(SPEED_MAX);
        }
        if (preset.scale !== undefined) {
          expect(preset.scale, at).toBeGreaterThanOrEqual(SCALE_MIN);
          expect(preset.scale, at).toBeLessThanOrEqual(SCALE_MAX);
        }
      }
    }
  });

  it("only sets params the shader defines, within their min/max", () => {
    for (const [shader, presets] of Object.entries(SHADER_BACKGROUND_PRESETS)) {
      const def = SHADER_BACKGROUNDS[shader];
      for (const preset of presets) {
        for (const [key, value] of Object.entries(preset.params ?? {})) {
          const p = def.params[key];
          const at = `${shader}/${preset.id}/${key}`;
          expect(p, at).toBeDefined();
          expect(value, at).toBeGreaterThanOrEqual(p.min);
          expect(value, at).toBeLessThanOrEqual(p.max);
        }
      }
    }
  });
});
