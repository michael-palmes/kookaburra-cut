import { describe, expect, it } from "vitest";
import { hexToHslString, hexToRgbString, normaliseHex } from "./colourUtils";

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
