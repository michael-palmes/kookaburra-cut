import { describe, expect, it } from "vitest";
import { computeFormat, FORMATS } from "../../engine/format";
import { layeredScreenshotTitleLayout } from "./LayeredScreenshot";

describe("layeredScreenshotTitleLayout", () => {
  it.each(["16:9", "9:16"] as const)("reserves a clear title band in %s", (aspect) => {
    const format = computeFormat(FORMATS[aspect]);
    const layout = layeredScreenshotTitleLayout(format, true);
    const safeTop = format.frame.height / 2 - format.safe.top;
    const nominalHalfTitle = format.aspect < 1 ? 0.17 : 0.28;
    const titleBottom = layout.position[1] - nominalHalfTitle;
    const stackTop = safeTop - layout.topInset;

    expect(layout.topInset).toBeGreaterThan(0);
    expect(titleBottom).toBeGreaterThan(stackTop);
    expect(layout.maxWidth).toBe(format.frame.width - format.safe.left - format.safe.right);
  });

  it("preserves the legacy full-frame stack when no title is present", () => {
    expect(layeredScreenshotTitleLayout(computeFormat(FORMATS["16:9"]), false)).toEqual({
      position: [0, 0, 0],
      maxWidth: 0,
      topInset: 0,
    });
  });
});
