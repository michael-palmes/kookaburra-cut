import { describe, expect, it } from "vitest";
import { TAP_DOT_SIZE_FRACTION, tapDotWidthFraction } from "./tapAnimation";

describe("tapDotWidthFraction", () => {
  it("sizes a source that fills the output against its short side", () => {
    const landscape = { width: 1920, height: 1080 };
    expect(tapDotWidthFraction(landscape, landscape, 1.25)).toBeCloseTo(
      (1080 * TAP_DOT_SIZE_FRACTION * 1.25) / 1920,
    );
    const portrait = { width: 1179, height: 2556 };
    expect(tapDotWidthFraction(portrait, portrait, 1)).toBeCloseTo(TAP_DOT_SIZE_FRACTION);
  });

  it("maps a letterboxed source through ffmpeg's rounded scale, as edit.rs does", () => {
    // edit.rs: a 1080x1920 source in a 1920x1080 render scales to 608 wide, dot 1080 * 0.07.
    const fraction = tapDotWidthFraction(
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 },
      1,
    );
    expect(fraction).toBeCloseTo((1080 * TAP_DOT_SIZE_FRACTION) / 608);
  });

  it("falls back to the plain fraction when dimensions are unknown", () => {
    expect(tapDotWidthFraction({ width: 0, height: 0 }, { width: 1920, height: 1080 }, 2)).toBe(
      TAP_DOT_SIZE_FRACTION * 2,
    );
  });
});
