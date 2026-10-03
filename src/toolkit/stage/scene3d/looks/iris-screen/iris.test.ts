import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import { FLOOR_FRAGMENT, IRIS_SUN, SCREEN_FRAGMENT } from "./iris";

describe("iris-screen", () => {
  it("lights devices from the virtual sun's mean, at each preset's own elevation", () => {
    for (const p of presets) {
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(IRIS_SUN.azimuthDeg);
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(p.params?.sunElevation);
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
    }
  });

  it("keeps whole panel counts and a clearing inside the drum", () => {
    for (const p of presets) {
      const params = { ...p.params };
      expect(Number.isInteger(params.panels), p.id).toBe(true);
      expect((params.clearRadius ?? 0) + 3, p.id).toBeLessThan(params.radius ?? 0);
    }
    expect(look.params.panels.step).toBe(1);
  });

  it("builds sound look materials", () => {
    for (const [part, fragmentShader] of [
      ["screen", SCREEN_FRAGMENT],
      ["floor", FLOOR_FRAGMENT],
    ]) {
      expect(lookMaterialProblem({ key: `iris-screen/${part}`, fragmentShader }), part).toBeNull();
    }
  });
});
