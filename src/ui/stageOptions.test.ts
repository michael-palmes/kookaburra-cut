import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseBackgroundSpec } from "../theme/schema";
import type { Theme } from "../theme/tokens";
import { backgroundMatches, backgroundOptions, DRIFT_PARALLAX, toggleDrift } from "./stageOptions";

/** Structure pins: every sidecar shape the popover/wizard chips can write must round-trip the schema parsers, or a drifted shape would silently degrade to "no override" (warn + drop) while the chip looks applied. */

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const themed = {
  colors: { background: "#0b0f14", text: "#fff", accent: "#3ad1c4", muted: "#888" },
  gradients: {
    brand: { type: "linear", angleDeg: 135, stops: [] },
    backdrop: { type: "linear", angleDeg: 180, stops: [] },
  },
} as unknown as Theme;

describe("backgroundOptions (v11 · M2)", () => {
  it("emits parser-valid shapes seeded from the theme", () => {
    const options = backgroundOptions(themed);
    expect(options.map((o) => o.label)).toEqual(["Theme default", "None", "Colour", "Gradient"]);
    for (const o of options) {
      if (o.value === undefined) continue;
      expect(parseBackgroundSpec(o.value, "pin"), o.label).toEqual(o.value);
    }
    expect(options.find((o) => o.label === "Colour")?.value).toEqual({
      type: "color",
      color: "#0b0f14",
    });
    expect(options.find((o) => o.label === "Gradient")?.value).toEqual({
      type: "gradient",
      gradient: "backdrop",
    });
  });

  it("falls back without a theme (no Gradient chip, seeded colour)", () => {
    const options = backgroundOptions(undefined);
    expect(options.map((o) => o.label)).toEqual(["Theme default", "None", "Colour"]);
    expect(options.find((o) => o.label === "Colour")?.value).toEqual({
      type: "color",
      color: "#101418",
    });
  });

  it("matches on type; theme-default matches absence", () => {
    expect(backgroundMatches(undefined, undefined)).toBe(true);
    expect(backgroundMatches({ type: "none" }, undefined)).toBe(false);
    expect(
      backgroundMatches({ type: "color", color: "#123456" }, { type: "color", color: "#000000" }),
    ).toBe(true);
  });
});

describe("toggleDrift", () => {
  it("stamps and strips the pinned parallax, and the result stays parser-valid", () => {
    const on = toggleDrift({ type: "image", src: "assets/bg.jpg" }, true);
    expect(on).toEqual({ type: "image", src: "assets/bg.jpg", parallax: DRIFT_PARALLAX });
    expect(parseBackgroundSpec(on, "pin")).toEqual(on);
    const off = toggleDrift(on, false);
    expect(off).toEqual({ type: "image", src: "assets/bg.jpg" });
    expect(parseBackgroundSpec(off, "pin")).toEqual(off);
  });

  it("passes `none` through untouched", () => {
    expect(toggleDrift({ type: "none" }, true)).toEqual({ type: "none" });
  });
});
