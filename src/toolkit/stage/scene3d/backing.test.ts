import { describe, expect, it } from "vitest";
import { bytesToHex, hexToOklch, mixOklch, oklchToBytes } from "../../../theme/oklch";
import { builtinThemes } from "../../../theme/registry";
import type { GradientSpec, Theme } from "../../../theme/tokens";
import { SHADER_BACKGROUNDS } from "../shaders";
import { deriveThemeShaderColors } from "../shaders/themePreset";
import { resolveScene3dBackingTone, SHADER_BACK_SLOT_LABEL } from "./backing";

const theme: Theme = builtinThemes["kookaburra-default"];
const clear = theme.colors.background;
const vertical = (stops: [string, number][], space?: "oklch"): GradientSpec => ({
  type: "linear",
  angleDeg: 180,
  stops,
  ...(space ? { space } : {}),
});

describe("resolveScene3dBackingTone", () => {
  it("falls back to the frame clear colour without a flat or sampled backing", () => {
    expect(resolveScene3dBackingTone(undefined, theme)).toBe(clear);
    expect(resolveScene3dBackingTone({ type: "none" }, theme)).toBe(clear);
    expect(resolveScene3dBackingTone({ type: "image", src: "assets/a.png" }, theme)).toBe(clear);
    expect(resolveScene3dBackingTone({ type: "video", src: "assets/a.mp4" }, theme)).toBe(clear);
  });

  it("passes a flat backing through as is", () => {
    expect(resolveScene3dBackingTone({ type: "color", color: "#0d1219" }, theme)).toBe("#0d1219");
  });

  it("takes a vertical gradient's horizon stop, not the mean of its stops", () => {
    const spec = vertical([
      ["#000000", 0],
      ["#336699", 0.5],
      ["#ffffff", 1],
    ]);
    expect(resolveScene3dBackingTone({ type: "gradient", spec }, theme)).toBe("#336699");
  });

  it("averages the whole row when the gradient runs across it", () => {
    const spec: GradientSpec = {
      type: "linear",
      angleDeg: 90,
      stops: [
        ["#000000", 0],
        ["#ffffff", 1],
      ],
    };
    expect(resolveScene3dBackingTone({ type: "gradient", spec }, theme)).toBe("#808080");
  });

  it("weights a radial gradient toward its centre stop", () => {
    const spec: GradientSpec = {
      type: "radial",
      angleDeg: 0,
      stops: [
        ["#000000", 0],
        ["#ffffff", 1],
      ],
    };
    expect(resolveScene3dBackingTone({ type: "gradient", spec }, theme)).toBe("#5d5d5d");
  });

  it("interpolates perceptually when the gradient asks for OKLCH", () => {
    const spec = vertical(
      [
        ["#1a2b6c", 0],
        ["#f2c14e", 1],
      ],
      "oklch",
    );
    const mid = bytesToHex(
      oklchToBytes(mixOklch(hexToOklch("#1a2b6c"), hexToOklch("#f2c14e"), 0.5)),
    );
    expect(resolveScene3dBackingTone({ type: "gradient", spec }, theme)).toBe(mid);
  });

  it("resolves a named gradient through the theme and falls back when it is missing", () => {
    const named: Theme = {
      ...theme,
      gradients: {
        dusk: vertical([
          ["#101820", 0],
          ["#203040", 1],
        ]),
      },
    };
    expect(resolveScene3dBackingTone({ type: "gradient", gradient: "dusk" }, named)).toBe(
      "#182430",
    );
    expect(resolveScene3dBackingTone({ type: "gradient", gradient: "gone" }, named)).toBe(clear);
  });

  it("takes a shader's Back slot, explicit or fallback", () => {
    const colors = ["#0f141b", "#2e405b", "#416198"];
    expect(resolveScene3dBackingTone({ type: "shader", shader: "dot-grid", colors }, theme)).toBe(
      "#0f141b",
    );
    expect(resolveScene3dBackingTone({ type: "shader", shader: "dot-grid" }, theme)).toBe(
      SHADER_BACKGROUNDS["dot-grid"].colorSlots[0].fallback,
    );
  });

  it("follows a Theme preset shader's derived colours", () => {
    const derived = deriveThemeShaderColors("dot-grid", theme);
    expect(derived).not.toBeNull();
    expect(
      resolveScene3dBackingTone({ type: "shader", shader: "dot-grid", themeColors: true }, theme),
    ).toBe(derived?.[0]);
  });

  it("averages a shader without a Back slot", () => {
    const colors = ["#000000", "#ffffff", "#000000", "#ffffff"];
    expect(
      resolveScene3dBackingTone({ type: "shader", shader: "mesh-gradient", colors }, theme),
    ).toBe("#808080");
    expect(resolveScene3dBackingTone({ type: "shader", shader: "nope" }, theme)).toBe(clear);
  });

  it("pins which shaders carry a Back slot, so a relabel cannot move a fade silently", () => {
    const withBack = Object.values(SHADER_BACKGROUNDS)
      .filter((def) => def.colorSlots.some((slot) => slot.label === SHADER_BACK_SLOT_LABEL))
      .map((def) => def.id)
      .sort();
    expect(withBack).toEqual([
      "dot-grid",
      "graph-grid",
      "hex-grid",
      "horizon-grid",
      "neuro-noise",
      "smoke-ring",
      "swirl",
    ]);
  });
});
