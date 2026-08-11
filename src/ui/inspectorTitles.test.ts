import { describe, expect, it } from "vitest";
import { namedInspectorTitle, sceneInspectorScreenTitle } from "./inspectorTitles";

describe("sceneInspectorScreenTitle", () => {
  it("names nested destinations and follows the device-group plurality", () => {
    expect(sceneInspectorScreenTitle("frame.decorations")).toBe("Decorations");
    expect(sceneInspectorScreenTitle("compare.edit")).toBe("Comparison");
    expect(sceneInspectorScreenTitle("image.edit")).toBe("Image");
    expect(sceneInspectorScreenTitle("legacyImage.edit")).toBe("Image");
    expect(sceneInspectorScreenTitle("device.position")).toBe("Arrange devices");
    expect(sceneInspectorScreenTitle("device", { deviceCount: 1 })).toBe("Device");
    expect(sceneInspectorScreenTitle("device", { deviceCount: 3 })).toBe("Devices");
  });
});

describe("namedInspectorTitle", () => {
  it("falls back for absent or blank authored names", () => {
    expect(namedInspectorTitle(undefined, "Point")).toBe("Point");
    expect(namedInspectorTitle("", "Point")).toBe("Point");
    expect(namedInspectorTitle("   ", "Point")).toBe("Point");
    expect(namedInspectorTitle("Key light", "Point")).toBe("Key light");
  });
});
