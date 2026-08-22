import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COMPARE_GRIP_CATALOG, COMPARE_MASK_CATALOG } from "../../engine/compareCatalog";
import { COMPARE_PRESETS } from "../../engine/comparePresets";
import {
  COMPARE_GRIP_GLYPHS,
  COMPARE_MASK_GLYPHS,
  COMPARE_PRESET_GLYPHS,
  COMPARE_TOGGLE_GLYPHS,
  CompareGripIcon,
  CompareMaskIcon,
  ComparePresetIcon,
  CompareToggleIcon,
} from "./compareIcons";

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

  it("one grip glyph per catalogue entry", () => {
    expect(sorted(Object.keys(COMPARE_GRIP_GLYPHS))).toEqual(
      sorted(COMPARE_GRIP_CATALOG.map((e) => e.id)),
    );
  });

  it("every glyph is real markup, never an empty slot", () => {
    const glyphs = [
      ...Object.values(COMPARE_MASK_GLYPHS),
      ...Object.values(COMPARE_PRESET_GLYPHS),
      ...Object.values(COMPARE_TOGGLE_GLYPHS),
      ...Object.values(COMPARE_GRIP_GLYPHS),
    ];
    expect(glyphs).toHaveLength(16);
    for (const glyph of glyphs) expect(isValidElement(glyph)).toBe(true);
  });

  it("draws at the house geometry, at the size the caller asks for", () => {
    const html = renderToStaticMarkup(createElement(CompareMaskIcon, { id: "linear", size: 17 }));
    expect(html).toContain('viewBox="0 0 16 16"');
    expect(html).toContain('width="17"');
    expect(html).toContain('height="17"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="1.5"');
    expect(html).toContain('fill="none"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("falls back to the 16px grid size", () => {
    for (const element of [
      createElement(CompareMaskIcon, { id: "blend" }),
      createElement(ComparePresetIcon, { id: "manual" }),
      createElement(CompareToggleIcon, { id: "chips" }),
      createElement(CompareGripIcon, { id: "dot" }),
    ]) {
      expect(renderToStaticMarkup(element)).toContain('width="16"');
    }
  });
});
