import { describe, expect, it } from "vitest";
import { presetStillApplied } from "./backgroundPresetMatch";

const defaults = { count: { default: 600 }, twinkle: { default: 0.5 } };
const preset = {
  colors: ["#B8A060", "#C8955A"],
  backing: "#F4EEDC",
  speed: 1,
  params: { count: 900 },
};
const applied = {
  colors: ["#b8a060", "#c8955a"],
  speed: 1,
  params: { count: 900 },
  backing: { type: "color", color: "#f4eedc" },
};

describe("presetStillApplied", () => {
  it("matches the values a preset stamps, ignoring hex case", () => {
    expect(presetStillApplied(applied, preset, defaults)).toBe(true);
  });

  it("treats a param left at its default as matching an absent one", () => {
    expect(
      presetStillApplied({ ...applied, params: { count: 900, twinkle: 0.5 } }, preset, defaults),
    ).toBe(true);
  });

  it("reads any colour, motion or backing edit as custom", () => {
    expect(
      presetStillApplied({ ...applied, colors: ["#000000", "#c8955a"] }, preset, defaults),
    ).toBe(false);
    expect(presetStillApplied({ ...applied, speed: 1.5 }, preset, defaults)).toBe(false);
    expect(presetStillApplied({ ...applied, params: { count: 400 } }, preset, defaults)).toBe(
      false,
    );
    expect(
      presetStillApplied({ ...applied, backing: { type: "gradient" } }, preset, defaults),
    ).toBe(false);
  });

  it("compares zoom for animated fills, whose presets carry no backing", () => {
    const shaderPreset = { colors: ["#111111"], speed: 0.5, scale: 1.2 };
    expect(
      presetStillApplied({ colors: ["#111111"], speed: 0.5, scale: 1.2 }, shaderPreset, {}),
    ).toBe(true);
    expect(presetStillApplied({ colors: ["#111111"], speed: 0.5 }, shaderPreset, {})).toBe(false);
  });

  it("never matches theme-derived colours, which store none", () => {
    expect(presetStillApplied({ ...applied, colors: undefined }, preset, defaults)).toBe(false);
  });
});
