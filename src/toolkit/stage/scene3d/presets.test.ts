import { describe, expect, it } from "vitest";
import { SHADER_BACKGROUND_PRESETS } from "../shaders/presets";
import { SCENE3D_BACKGROUNDS } from "./index";
import { SCENE3D_BACKGROUND_PRESETS } from "./presets";

/** The 3D packs follow the shader-pack contract (docs/backgrounds.md): 9 presets (p1-p5 light, p6-p9 dark), every geometry colour AND the backing inside the mode's luminance band, fallbacks pinned to p6, params inside the def's bounds, names unique across every background pack. */

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = lin(((n >> 16) & 255) / 255);
  const g = lin(((n >> 8) & 255) / 255);
  const b = lin((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("SCENE3D_BACKGROUND_PRESETS", () => {
  it("covers every look with 9 presets in light-then-dark order", () => {
    expect(Object.keys(SCENE3D_BACKGROUND_PRESETS).sort()).toEqual(
      Object.keys(SCENE3D_BACKGROUNDS).sort(),
    );
    for (const [look, presets] of Object.entries(SCENE3D_BACKGROUND_PRESETS)) {
      expect(
        presets.map((p) => p.id),
        look,
      ).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
      expect(
        presets.map((p) => p.mode),
        look,
      ).toEqual([...Array(5).fill("light"), ...Array(4).fill("dark")]);
    }
  });

  it("keeps every stop and backing inside the mode's luminance band, AA text colour pinned", () => {
    for (const [look, presets] of Object.entries(SCENE3D_BACKGROUND_PRESETS)) {
      for (const p of presets) {
        expect(p.textColor, `${look} ${p.id}`).toBe(p.mode === "light" ? "#000000" : "#ffffff");
        for (const stop of [...p.colors, p.backing]) {
          const l = luminance(stop);
          if (p.mode === "light") expect(l, `${look} ${p.id} ${stop}`).toBeGreaterThanOrEqual(0.3);
          else expect(l, `${look} ${p.id} ${stop}`).toBeLessThanOrEqual(0.125);
        }
      }
    }
  });

  it("pins each look's colorSlots fallbacks to its p6 preset", () => {
    for (const [look, def] of Object.entries(SCENE3D_BACKGROUNDS)) {
      const p6 = SCENE3D_BACKGROUND_PRESETS[look]?.find((p) => p.id === "p6");
      expect(p6, look).toBeDefined();
      expect(
        def.colorSlots.map((s) => s.fallback),
        look,
      ).toEqual(p6?.colors);
    }
  });

  it("keeps preset params inside the def's slider bounds", () => {
    for (const [look, presets] of Object.entries(SCENE3D_BACKGROUND_PRESETS)) {
      const def = SCENE3D_BACKGROUNDS[look];
      for (const p of presets) {
        for (const [key, value] of Object.entries(p.params ?? {})) {
          const bound = def.params[key];
          expect(bound, `${look} ${p.id} ${key}`).toBeDefined();
          expect(value, `${look} ${p.id} ${key}`).toBeGreaterThanOrEqual(bound.min);
          expect(value, `${look} ${p.id} ${key}`).toBeLessThanOrEqual(bound.max);
        }
      }
    }
  });

  it("keeps preset names unique across the shader and 3D packs", () => {
    const names = [
      ...Object.values(SHADER_BACKGROUND_PRESETS).flat(),
      ...Object.values(SCENE3D_BACKGROUND_PRESETS).flat(),
    ].map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
