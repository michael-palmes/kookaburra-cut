import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { COMPARE_MASK_CATALOG } from "../../engine/compareCatalog";
import { COMPARE_PRESETS } from "../../engine/comparePresets";
import { COMPARE_MASK_GLYPHS, COMPARE_PRESET_GLYPHS, COMPARE_TOGGLE_GLYPHS } from "./compareIcons";

const sorted = (ids: readonly string[]) => [...ids].sort();

describe("comparison drill glyphs (structure pin)", () => {
  it("one mask glyph per catalogue entry", () => {
    expect(sorted(Object.keys(COMPARE_MASK_GLYPHS))).toEqual(
      sorted(COMPARE_MASK_CATALOG.map((e) => e.id)),
    );
  });

  it("one preset glyph per preset, plus manual", () => {
    expect(sorted(Object.keys(COMPARE_PRESET_GLYPHS))).toEqual(
      sorted(["manual", ...COMPARE_PRESETS.map((p) => p.id)]),
    );
  });

  it("one toggle glyph per divider-chrome toggle", () => {
    expect(sorted(Object.keys(COMPARE_TOGGLE_GLYPHS))).toEqual(sorted(["line", "grip", "chips"]));
  });

  it("every glyph is real markup, never an empty slot", () => {
    const glyphs = [
      ...Object.values(COMPARE_MASK_GLYPHS),
      ...Object.values(COMPARE_PRESET_GLYPHS),
      ...Object.values(COMPARE_TOGGLE_GLYPHS),
    ];
    expect(glyphs).toHaveLength(12);
    for (const glyph of glyphs) expect(isValidElement(glyph)).toBe(true);
  });
});
