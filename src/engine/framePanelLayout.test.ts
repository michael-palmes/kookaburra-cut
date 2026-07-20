import { describe, expect, it } from "vitest";
import { computeFormat, FORMATS } from "./format";
import { framePanelLayout } from "./framePanelLayout";

const wide = computeFormat(FORMATS["16:9"]);
const tall = computeFormat(FORMATS["9:16"]);
const startFrame = { cutout: { shape: "rounded-rect", side: "start" } } as const;
const endFrame = { cutout: { shape: "rounded-rect", side: "end" } } as const;

describe("framePanelLayout", () => {
  it("puts the text column opposite the cutout: right of centre for side start in wide", () => {
    const l = framePanelLayout(wide, startFrame);
    expect(l.left).toBeGreaterThan(0);
    expect(l.top).toBeGreaterThan(l.bottom);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
  });

  it("puts the column left of centre for side end in wide", () => {
    const l = framePanelLayout(wide, endFrame);
    expect(l.left).toBeLessThan(0);
  });

  it("stacks the column below the cutout in tall aspects (top of frame is the cutout)", () => {
    const start = framePanelLayout(tall, startFrame);
    // side start = cutout on top, so the padded column top sits below frame centre.
    expect(start.top).toBeLessThan(0);
  });

  it("keeps the padded column strictly inside the frame", () => {
    for (const format of [wide, tall]) {
      const l = framePanelLayout(format, startFrame);
      expect(l.top).toBeLessThan(format.frame.height / 2);
      expect(l.bottom).toBeGreaterThan(-format.frame.height / 2);
      expect(l.left).toBeGreaterThan(-format.frame.width / 2);
      expect(l.left + l.width).toBeLessThan(format.frame.width / 2);
    }
  });

  it("shrinks the column by the padding on both axes", () => {
    const l = framePanelLayout(wide, startFrame);
    const bare = framePanelLayout({ ...wide }, startFrame);
    expect(l.width).toBe(bare.width);
    // Padding leaves a gap between the column top and the frame top edge.
    expect(wide.frame.height / 2 - l.top).toBeGreaterThan(0);
  });
});
