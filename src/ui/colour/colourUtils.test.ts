import { describe, expect, it } from "vitest";
import { COLOUR_PRESET_GRID } from "./colourPresets";
import { hexToHslString, hexToHsv, hexToRgbString, hsvToHex, normaliseHex } from "./colourUtils";

describe("normaliseHex", () => {
  it("expands 3-digit hex and lowercases", () => {
    expect(normaliseHex("#3AD")).toBe("#33aadd");
    expect(normaliseHex("fff")).toBe("#ffffff");
  });

  it("accepts 6-digit hex with or without the hash", () => {
    expect(normaliseHex("#3AD1C4")).toBe("#3ad1c4");
    expect(normaliseHex("3ad1c4")).toBe("#3ad1c4");
    expect(normaliseHex("  #3ad1c4  ")).toBe("#3ad1c4");
  });

  it("rejects garbage", () => {
    expect(normaliseHex("")).toBeNull();
    expect(normaliseHex("#12")).toBeNull();
    expect(normaliseHex("#12345")).toBeNull();
    expect(normaliseHex("#gggggg")).toBeNull();
    expect(normaliseHex("rgb(0,0,0)")).toBeNull();
    expect(normaliseHex("#3ad1c4ff")).toBeNull();
  });
});

describe("hexToRgbString", () => {
  it("converts known values", () => {
    expect(hexToRgbString("#000000")).toBe("rgb(0, 0, 0)");
    expect(hexToRgbString("#ffffff")).toBe("rgb(255, 255, 255)");
    expect(hexToRgbString("#3ad1c4")).toBe("rgb(58, 209, 196)");
  });
});

describe("hexToHslString", () => {
  it("converts achromatic values without dividing by zero", () => {
    expect(hexToHslString("#000000")).toBe("hsl(0, 0%, 0%)");
    expect(hexToHslString("#ffffff")).toBe("hsl(0, 0%, 100%)");
    expect(hexToHslString("#808080")).toBe("hsl(0, 0%, 50%)");
  });

  it("converts primary hues", () => {
    expect(hexToHslString("#ff0000")).toBe("hsl(0, 100%, 50%)");
    expect(hexToHslString("#00ff00")).toBe("hsl(120, 100%, 50%)");
    expect(hexToHslString("#0000ff")).toBe("hsl(240, 100%, 50%)");
  });
});

describe("hexToHsv", () => {
  it("reads the primaries and secondaries", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#ffff00").h).toBe(60);
    expect(hexToHsv("#00ff00").h).toBe(120);
    expect(hexToHsv("#00ffff").h).toBe(180);
    expect(hexToHsv("#0000ff").h).toBe(240);
    expect(hexToHsv("#ff00ff").h).toBe(300);
  });

  it("collapses achromatic values to hue 0, saturation 0", () => {
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv("#ffffff")).toEqual({ h: 0, s: 0, v: 1 });
    const grey = hexToHsv("#808080");
    expect(grey.h).toBe(0);
    expect(grey.s).toBe(0);
    expect(grey.v).toBeCloseTo(0.50196, 5);
  });

  it("recovers chroma from near-black colours", () => {
    const hsv = hexToHsv("#010203");
    expect(hsv.h).toBeCloseTo(210, 5);
    expect(hsv.s).toBeCloseTo(0.6667, 4);
    expect(hsv.v).toBeCloseTo(0.011765, 6);
  });
});

describe("hsvToHex", () => {
  it("formats the achromatic extremes", () => {
    expect(hsvToHex({ h: 0, s: 0, v: 0 })).toBe("#000000");
    expect(hsvToHex({ h: 0, s: 0, v: 1 })).toBe("#ffffff");
  });

  it("wraps hue in both directions", () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: 720, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: -30, s: 1, v: 1 })).toBe("#ff0080");
  });

  it("clamps saturation and value instead of emitting malformed hex", () => {
    expect(hsvToHex({ h: 0, s: 2, v: 2 })).toBe("#ff0000");
    expect(hsvToHex({ h: 0, s: 0, v: 2 })).toBe("#ffffff");
    expect(hsvToHex({ h: 0, s: -1, v: -1 })).toBe("#000000");
    expect(hsvToHex({ h: 120, s: 0.5, v: 5 })).toBe("#80ff80");
  });

  it("always yields six lowercase hex digits", () => {
    for (const hsv of [
      { h: 0, s: 0, v: 0 },
      { h: 1234, s: 0.3, v: 0.7 },
      { h: -999, s: 5, v: -5 },
      { h: 59.5, s: 0.999, v: 0.001 },
    ]) {
      expect(hsvToHex(hsv)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("hsv round trip", () => {
  it("survives every preset swatch", () => {
    for (const hex of COLOUR_PRESET_GRID) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it("survives a strided sweep of the whole sRGB cube", () => {
    for (let i = 0; i < 0x1000000; i += 997) {
      const hex = `#${i.toString(16).padStart(6, "0")}`;
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it("survives the byte boundaries", () => {
    for (const hex of ["#000000", "#ffffff", "#010101", "#fefefe", "#ff0001", "#0100ff"]) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });
});
