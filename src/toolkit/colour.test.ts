import { describe, expect, it } from "vitest";
import { cssOpacity, glowColour, liftColour } from "./colour";

describe("cssOpacity", () => {
  it("is the display-domain lift of the room toward the foreground", () => {
    expect(cssOpacity("#ffffff", "#000000", 0.5)).toBe(liftColour("#000000", "#ffffff", 0.5));
    expect(cssOpacity("#ffffff", "#336699", 0)).toBe("#336699");
    expect(cssOpacity("#ffffff", "#336699", 1)).toBe("#ffffff");
  });
});

describe("glowColour", () => {
  it("raises only full channels to the target luminance", () => {
    const glow = glowColour("#ff3366", 1.5);
    const luminance = 0.2126 * glow.r + 0.7152 * glow.g + 0.0722 * glow.b;
    expect(luminance).toBeCloseTo(1.5, 10);
    expect(glow.r).toBeGreaterThan(1);
    const plain = glowColour("#ff3366", 0);
    expect(glow.g).toBe(plain.g);
    expect(glow.b).toBe(plain.b);
    // Clamped back to the display range it is the token exactly.
    expect(glow.clone().setRGB(Math.min(glow.r, 1), glow.g, glow.b).getHexString()).toBe("ff3366");
  });

  it("scales a colour with no full channel whole, and leaves a low target alone", () => {
    expect(glowColour("#808080", 2).r).toBeGreaterThan(1);
    expect(glowColour("#ff3366", 0.1).getHexString()).toBe("ff3366");
  });
});
