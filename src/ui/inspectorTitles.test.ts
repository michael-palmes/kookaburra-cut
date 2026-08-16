import { describe, expect, it } from "vitest";
import {
  chartInspectorScreenForRoute,
  chartSeriesInspectorRoute,
  namedInspectorTitle,
  sceneInspectorScreenTitle,
  textIconInspectorRoute,
  textIconInspectorScreenForRoute,
} from "./inspectorTitles";

describe("sceneInspectorScreenTitle", () => {
  it("names nested destinations and follows the device-group plurality", () => {
    expect(sceneInspectorScreenTitle("frame.decorations")).toBe("Decorations");
    expect(sceneInspectorScreenTitle("frame.icon")).toBe("Panel icon");
    expect(sceneInspectorScreenTitle("compare.edit")).toBe("Comparison");
    expect(sceneInspectorScreenTitle("image.edit")).toBe("Image");
    expect(sceneInspectorScreenTitle("media.picker")).toBe("Choose image");
    expect(sceneInspectorScreenTitle("legacyImage.edit")).toBe("Image");
    expect(sceneInspectorScreenTitle("objects")).toBe("Objects");
    expect(sceneInspectorScreenTitle("objects.picker")).toBe("Choose object");
    expect(sceneInspectorScreenTitle("device.position")).toBe("Arrange devices");
    expect(sceneInspectorScreenTitle("chart.font")).toBe("Chart font");
    expect(sceneInspectorScreenTitle(chartSeriesInspectorRoute("s1"))).toBe("Series");
    expect(sceneInspectorScreenTitle(textIconInspectorRoute("emoji", "icon"))).toBe("Emoji");
    expect(sceneInspectorScreenTitle(textIconInspectorRoute("image", "icon"))).toBe("Image");
    expect(sceneInspectorScreenTitle("device", { deviceCount: 1 })).toBe("Device");
    expect(sceneInspectorScreenTitle("device", { deviceCount: 3 })).toBe("Devices");
  });
});

describe("text icon inspector routes", () => {
  it("round-trips image and emoji item keys as total UTF-16", () => {
    for (const itemKey of ["icon", "", `before\ud800after\udfff`]) {
      for (const kind of ["emoji", "image"] as const) {
        const route = textIconInspectorRoute(kind, itemKey);
        expect(textIconInspectorScreenForRoute(route)).toEqual({ kind, itemKey });
      }
    }
  });

  it("rejects unrelated and malformed routes", () => {
    expect(textIconInspectorScreenForRoute("text.icon.emoji:u16:123")).toBeNull();
    expect(textIconInspectorScreenForRoute("text.icon.other:u16:0069")).toBeNull();
    expect(textIconInspectorScreenForRoute("text.motion:icon")).toBeNull();
    expect(textIconInspectorScreenForRoute(null)).toBeNull();
  });
});

describe("chart inspector routes", () => {
  it("maps the overview, font and stable encoded series routes", () => {
    const seriesRoute = chartSeriesInspectorRoute("revenue/APAC:2026");

    expect(seriesRoute).toMatch(/^chart\.series:u16:(?:[0-9a-f]{4})+$/);
    expect(seriesRoute).not.toContain("/");
    expect(chartInspectorScreenForRoute("chart.edit")).toEqual({ kind: "overview" });
    expect(chartInspectorScreenForRoute("chart.font")).toEqual({ kind: "font" });
    expect(chartInspectorScreenForRoute(seriesRoute)).toEqual({
      kind: "series",
      seriesId: "revenue/APAC:2026",
    });
  });

  it("round-trips every string, including empty and lone surrogates", () => {
    for (const seriesId of ["", `before\ud800after\udfff`]) {
      const route = chartSeriesInspectorRoute(seriesId);

      expect(chartInspectorScreenForRoute(route)).toEqual({ kind: "series", seriesId });
    }
  });

  it("rejects non-chart and malformed series routes", () => {
    expect(chartInspectorScreenForRoute("chart.position")).toBeNull();
    expect(chartInspectorScreenForRoute("chart.series:u16:123")).toBeNull();
    expect(chartInspectorScreenForRoute("chart.series:u16:xyz1")).toBeNull();
    expect(chartInspectorScreenForRoute(null)).toBeNull();
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
