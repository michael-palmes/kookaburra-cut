import { describe, expect, it } from "vitest";
import { hexToRgba } from "./FixedBackdrop";

describe("shader background colours", () => {
  it("hands the shader the hex's own sRGB components, not linear light", () => {
    const [r, g, b, a] = hexToRgba("#efede8");
    expect(Math.round(r * 255)).toBe(0xef);
    expect(Math.round(g * 255)).toBe(0xed);
    expect(Math.round(b * 255)).toBe(0xe8);
    expect(a).toBe(1);
    for (const hex of ["#000000", "#152c21", "#808080", "#ffffff"]) {
      const channel = Number.parseInt(hex.slice(1, 3), 16) / 255;
      expect(hexToRgba(hex)[0]).toBe(channel);
    }
  });
});
