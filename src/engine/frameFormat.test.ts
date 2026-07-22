import { describe, expect, it } from "vitest";
import { FORMATS } from "./format";
import { resolveCutoutRender } from "./frameFormat";

const rounded = { cutout: { shape: "rounded-rect" } } as const;

describe("resolveCutoutRender", () => {
  it("gives the scene the cutout's aspect, not the frame's", () => {
    const { format, pixelRect } = resolveCutoutRender(FORMATS["16:9"], rounded);
    expect(format.aspect).toBeCloseTo(pixelRect.width / pixelRect.height, 6);
    expect(format.aspect).not.toBeCloseTo(16 / 9, 2);
  });

  it("matches the cutout pixel rect against the real output resolution", () => {
    const { pixelRect } = resolveCutoutRender(FORMATS["16:9"], rounded);
    // 3840x2160 frame, default 0.515w x 0.92h cutout at 0.0225 inset.
    expect(pixelRect).toEqual({ x: 86, y: 86, width: 1978, height: 1987 });
  });

  it("carries the cutout's own safe area, sized off its shorter edge", () => {
    const { format } = resolveCutoutRender(FORMATS["16:9"], rounded);
    const shorter = Math.min(format.frame.width, format.frame.height);
    expect(format.safe.left).toBeCloseTo(0.06 * shorter, 6);
  });

  it("restacks with the aspect: the same frame yields a different cutout in 9:16", () => {
    const wide = resolveCutoutRender(FORMATS["16:9"], rounded);
    const tall = resolveCutoutRender(FORMATS["9:16"], rounded);
    // Wide frames split left/right (cutout taller than wide-ish), tall frames split top/bottom.
    expect(wide.layout.axis).toBe("horizontal");
    expect(tall.layout.axis).toBe("vertical");
    expect(tall.pixelRect.width).toBeGreaterThan(tall.pixelRect.height);
  });

  it("keeps the cutout strictly inside the output frame", () => {
    for (const name of ["16:9", "9:16", "1:1", "4:5"] as const) {
      const { pixelRect } = resolveCutoutRender(FORMATS[name], rounded);
      expect(pixelRect.x).toBeGreaterThanOrEqual(0);
      expect(pixelRect.y).toBeGreaterThanOrEqual(0);
      expect(pixelRect.x + pixelRect.width).toBeLessThanOrEqual(FORMATS[name].width);
      expect(pixelRect.y + pixelRect.height).toBeLessThanOrEqual(FORMATS[name].height);
    }
  });
});
