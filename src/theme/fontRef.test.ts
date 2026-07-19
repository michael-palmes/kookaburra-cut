import { describe, expect, it } from "vitest";
import { formatFontString, parseFontString } from "./fontRef";

describe("parseFontString", () => {
  it("parses bare families at weight 400", () => {
    expect(parseFontString("Georgia")).toEqual({ family: "Georgia", weight: 400 });
  });

  it("parses Family@weight", () => {
    expect(parseFontString("Avenir Next@600")).toEqual({ family: "Avenir Next", weight: 600 });
  });

  it("keeps the whole string as family on a bad weight", () => {
    expect(parseFontString("Weird@name")).toEqual({ family: "Weird@name", weight: 400 });
    expect(parseFontString("X@0")).toEqual({ family: "X@0", weight: 400 });
  });

  it("splits on the last @ for families containing one", () => {
    expect(parseFontString("We@ird@600")).toEqual({ family: "We@ird", weight: 600 });
  });
});

describe("formatFontString", () => {
  it("omits the default weight and round-trips others", () => {
    expect(formatFontString({ family: "Georgia", weight: 400 })).toBe("Georgia");
    expect(formatFontString({ family: "Avenir Next", weight: 600 })).toBe("Avenir Next@600");
    expect(parseFontString(formatFontString({ family: "Avenir Next", weight: 600 }))).toEqual({
      family: "Avenir Next",
      weight: 600,
    });
  });
});
