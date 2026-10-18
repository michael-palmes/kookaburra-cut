import { describe, expect, it } from "vitest";
import { cssOpacity, liftColour } from "./colour";

describe("cssOpacity", () => {
  it("is the display-domain lift of the room toward the foreground", () => {
    expect(cssOpacity("#ffffff", "#000000", 0.5)).toBe(liftColour("#000000", "#ffffff", 0.5));
    expect(cssOpacity("#ffffff", "#336699", 0)).toBe("#336699");
    expect(cssOpacity("#ffffff", "#336699", 1)).toBe("#ffffff");
  });
});
