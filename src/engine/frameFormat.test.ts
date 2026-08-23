import { describe, expect, it } from "vitest";
import type { FrameSpec } from "../toolkit/frame/types";
import { FORMATS } from "./format";
import { framesThroughCutout, resolveCutoutRender } from "./frameFormat";
import { frameWorldCutout } from "./stageViewport";

const rounded = { cutout: { shape: "rounded-rect" } } as const;

describe("framesThroughCutout", () => {
  it("follows the shape and nothing else, so every panel fill composes the same world", () => {
    const fills: FrameSpec["background"][] = [
      undefined,
      "accent",
      { type: "color", color: "#ffffff" },
      { type: "gradient", gradient: "backdrop" },
      { type: "image", src: "assets/panel.png" },
      { type: "transparent" },
    ];
    for (const background of fills) {
      expect(framesThroughCutout({ cutout: rounded.cutout, background })).toBe(true);
      expect(framesThroughCutout({ cutout: { shape: "none" }, background })).toBe(false);
    }
  });

  it("is false with no frame at all", () => {
    expect(framesThroughCutout(undefined)).toBe(false);
  });

  it("agrees with the gizmo seam's cutout on every fill", () => {
    for (const background of [undefined, { type: "transparent" } as const]) {
      const frame: FrameSpec = { cutout: rounded.cutout, background };
      expect(frameWorldCutout(frame, 16 / 9) !== null).toBe(framesThroughCutout(frame));
    }
  });
});

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
    for (const name of [
      "16:9",
      "9:16",
      "1:1",
      "4:5",
      "5:4",
      "3:2",
      "2:3",
      "phone",
      "phone-landscape",
    ] as const) {
      const { pixelRect } = resolveCutoutRender(FORMATS[name], rounded);
      expect(pixelRect.x).toBeGreaterThanOrEqual(0);
      expect(pixelRect.y).toBeGreaterThanOrEqual(0);
      expect(pixelRect.x + pixelRect.width).toBeLessThanOrEqual(FORMATS[name].width);
      expect(pixelRect.y + pixelRect.height).toBeLessThanOrEqual(FORMATS[name].height);
    }
  });
});
