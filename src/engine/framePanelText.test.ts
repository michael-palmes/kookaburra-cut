import { describe, expect, it } from "vitest";
import { charAdvance, estimateTitleLines, TITLE_MAX_LINES } from "./framePanelText";

/** A column 8 em wide at size 1, the shape FramePanel feeds in (width in world units / size). */
const WIDTH = 8;
const SIZE = 1;

describe("estimateTitleLines", () => {
  it("short titles stay one line", () => {
    expect(estimateTitleLines("New", SIZE, WIDTH)).toBe(1);
    expect(estimateTitleLines("Ship faster", SIZE, WIDTH)).toBe(1);
  });

  it("wraps whole words, never mid-word", () => {
    // Two words of ~5.5 em each cannot share a 10 em line.
    expect(estimateTitleLines("Repository Standard", SIZE, WIDTH)).toBe(2);
  });

  it("narrow and wide glyphs budget differently for the same length", () => {
    const narrow = "iiiiiiiiii iiiiiiiiii"; // 2 x ~3.2 em, one line
    const wide = "mmmmmmmmmm mmmmmmmmmm"; // 2 x 9 em, two lines
    expect(estimateTitleLines(narrow, SIZE, WIDTH)).toBe(1);
    expect(estimateTitleLines(wide, SIZE, WIDTH)).toBe(2);
  });

  it("emoji count as full-width glyphs", () => {
    expect(charAdvance("🚀")).toBeGreaterThan(1);
    expect(estimateTitleLines("🚀🚀🚀🚀🚀 🚀🚀🚀🚀🚀", SIZE, WIDTH)).toBe(2);
  });

  it("caps at TITLE_MAX_LINES with the fit scale absorbing the rest", () => {
    const long = Array.from({ length: 12 }, () => "wordyword").join(" ");
    expect(estimateTitleLines(long, SIZE, WIDTH)).toBe(TITLE_MAX_LINES);
  });

  it("a single word wider than the column still counts one line per word", () => {
    expect(estimateTitleLines("Hyperconfiguration", SIZE, 4)).toBe(1);
    expect(estimateTitleLines("Hyperconfiguration Management", SIZE, 4)).toBe(2);
  });

  it("explicit newlines are hard breaks, each segment wrapping on its own", () => {
    expect(estimateTitleLines("Example:\nfeat/overlay-polish", SIZE, WIDTH)).toBe(2);
    expect(estimateTitleLines("Line one\nLine two\nLine three", SIZE, WIDTH)).toBe(3);
    expect(estimateTitleLines("a\n\nb", SIZE, WIDTH)).toBe(3);
    expect(estimateTitleLines("mmmmmmmmmm mmmmmmmmmm\nmore", SIZE, WIDTH)).toBe(3);
  });
});
