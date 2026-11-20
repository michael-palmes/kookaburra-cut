import { describe, expect, it, vi } from "vitest";
import { hexToOklch } from "../../theme/oklch";
import type { Theme } from "../../theme/tokens";
import { SHADER_BACKGROUNDS } from "../stage/shaders";
import {
  accentFluidColours,
  FLUID_FILL_DEFAULT_SCALE,
  FLUID_FILL_DEFAULT_SHADER,
  FLUID_FILL_DEFAULT_SPEED,
  fluidFillFunction,
  fluidTimeSeconds,
  resolveFluidFill,
} from "./fluidFill";

const theme = {
  colors: { background: "#fbfaf7", text: "#0e0e10", accent: "#3a67b8", muted: "#8e8e8a" },
} as Theme;

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("resolveFluidFill", () => {
  it("is off for no fill", () => {
    expect(resolveFluidFill(undefined, theme)).toBeNull();
    expect(resolveFluidFill(false, theme)).toBeNull();
  });

  it("defaults to the mesh gradient in the theme accent's shades", () => {
    const fill = resolveFluidFill(true, theme);
    expect(fill?.def.id).toBe(FLUID_FILL_DEFAULT_SHADER);
    expect(fill?.speed).toBe(FLUID_FILL_DEFAULT_SPEED);
    expect(fill?.scale).toBe(FLUID_FILL_DEFAULT_SCALE);
    expect(fill?.colors).toHaveLength(4);
    expect(resolveFluidFill({}, theme)?.key).toBe(fill?.key);
  });

  it("resolves tokens, drops broken colours and keeps an array shader's count", () => {
    const fill = resolveFluidFill({ colors: ["accent", "nope", "#ffffff"] }, theme);
    expect(fill?.colors).toEqual([
      [58 / 255, 103 / 255, 184 / 255, 1],
      [1, 1, 1, 1],
    ]);
  });

  it("cycles colours through a shader's fixed slots", () => {
    const fill = resolveFluidFill({ shader: "neuro-noise", colors: ["#ff0000"] }, theme);
    const slots = SHADER_BACKGROUNDS["neuro-noise"].colorSlots.length;
    expect(fill?.colors).toHaveLength(slots);
    expect(fill?.colors.every((c) => c[0] === 1 && c[1] === 0)).toBe(true);
  });

  it("clamps params into the shader's range and fills the rest with defaults", () => {
    const fill = resolveFluidFill({ params: { distortion: 9 } }, theme);
    expect(fill?.params.distortion).toBe(1);
    expect(fill?.params.swirl).toBe(SHADER_BACKGROUNDS["mesh-gradient"].params.swirl.default);
  });

  it("degrades an unknown shader to the mesh gradient, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveFluidFill({ shader: "lava-lamp" }, theme)?.def.id).toBe("mesh-gradient");
    resolveFluidFill({ shader: "lava-lamp" }, theme);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("accentFluidColours", () => {
  it("steps deep, mid and highlight around the accent, the same every run", () => {
    const [deep, mid, highlight, shade] = accentFluidColours("#3a67b8");
    expect(hexToOklch(deep).l).toBeLessThan(hexToOklch(mid).l);
    expect(hexToOklch(highlight).l).toBeGreaterThan(0.9);
    expect(shade).not.toBe(mid);
    expect(accentFluidColours("#3a67b8")).toEqual([deep, mid, highlight, shade]);
  });
});

describe("fluidFillFunction", () => {
  it("turns every background fragment into one callable that sets its own varyings", () => {
    for (const [id, def] of Object.entries(SHADER_BACKGROUNDS)) {
      const src = fluidFillFunction(def.fragment);
      expect(count(src, "void main() {"), id).toBe(0);
      expect(count(src, "void kkFluidMain() {"), id).toBe(1);
      expect(count(src, "vec4 kkFluid(vec2 st) {"), id).toBe(1);
      expect(src.includes("out vec4 fragColor;"), id).toBe(false);
      expect(/\bin vec2 v_(object|pattern)UV;/.test(src), id).toBe(false);
      expect(count(src, "vec2 v_objectUV;"), id).toBe(1);
      expect(count(src, "vec2 v_patternUV;"), id).toBe(1);
    }
  });
});

describe("fluidTimeSeconds", () => {
  it("runs on the absolute project clock at the fill's speed", () => {
    expect(fluidTimeSeconds(2500, 0.4)).toBeCloseTo(1);
    expect(fluidTimeSeconds(0, 3)).toBe(0);
  });
});
