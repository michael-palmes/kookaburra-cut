import { describe, expect, it } from "vitest";
import { hexToBytes } from "../../theme/oklch";
import { COLOUR_PRESET_COLUMNS, COLOUR_PRESET_GRID } from "./colourPresets";
import { normaliseHex } from "./colourUtils";

describe("COLOUR_PRESET_GRID", () => {
  it("is 96 unique, already-normalised six-digit hexes", () => {
    expect(COLOUR_PRESET_GRID).toHaveLength(96);
    expect(new Set(COLOUR_PRESET_GRID).size).toBe(96);
    for (const hex of COLOUR_PRESET_GRID) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(normaliseHex(hex)).toBe(hex);
    }
  });

  it("fills 12 columns across 8 rows", () => {
    expect(COLOUR_PRESET_COLUMNS).toBe(12);
    expect(COLOUR_PRESET_GRID.length % COLOUR_PRESET_COLUMNS).toBe(0);
    expect(COLOUR_PRESET_GRID.length / COLOUR_PRESET_COLUMNS).toBe(8);
  });

  it("opens with a monotonic greyscale ramp from black to white", () => {
    const row = COLOUR_PRESET_GRID.slice(0, COLOUR_PRESET_COLUMNS);
    expect(row[0]).toBe("#000000");
    expect(row[row.length - 1]).toBe("#ffffff");
    let previous = -1;
    for (const hex of row) {
      const [r, g, b] = hexToBytes(hex);
      expect(r).toBe(g);
      expect(g).toBe(b);
      expect(r).toBeGreaterThan(previous);
      previous = r;
    }
  });

  it("keeps the previous grid's vivid values so existing picks still light up", () => {
    for (const hex of [
      "#ff3b30",
      "#ff9500",
      "#ffcc00",
      "#34c759",
      "#00c7be",
      "#007aff",
      "#af52de",
      "#ff2d55",
    ]) {
      expect(COLOUR_PRESET_GRID).toContain(hex);
    }
  });
});
