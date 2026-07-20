import { describe, expect, it } from "vitest";
import {
  cutoutPixelRect,
  DEFAULT_CUTOUT_INSET,
  DEFAULT_CUTOUT_SIZE,
  frameAxis,
  frameLayout,
} from "./frameLayout";
import type { FrameCutoutSpec } from "./types";

const WIDE = 16 / 9;
const TALL = 9 / 16;
const SQUARE = 1;
const PORTRAIT = 4 / 5;

const rounded: FrameCutoutSpec = { shape: "rounded-rect" };

/** Physical margin (frame height = 1) between a rect edge and the frame edge. */
function physicalMargins(rect: { x: number; y: number; width: number; height: number }, a: number) {
  return {
    left: rect.x * a,
    right: (1 - rect.x - rect.width) * a,
    top: rect.y,
    bottom: 1 - rect.y - rect.height,
  };
}

describe("frameAxis", () => {
  it("splits wide frames left/right", () => {
    expect(frameAxis(WIDE)).toBe("horizontal");
  });

  it("splits square and taller frames top/bottom so the text column never gets squeezed", () => {
    expect(frameAxis(SQUARE)).toBe("vertical");
    expect(frameAxis(PORTRAIT)).toBe("vertical");
    expect(frameAxis(TALL)).toBe("vertical");
  });
});

describe("frameLayout placement", () => {
  it("pins the 16:9 default cutout", () => {
    const { cutout } = frameLayout(WIDE, rounded);
    expect(cutout.x).toBeCloseTo(0.0225, 6);
    expect(cutout.y).toBeCloseTo(0.04, 6);
    expect(cutout.width).toBeCloseTo(0.515, 6);
    expect(cutout.height).toBeCloseTo(0.92, 6);
  });

  it("keeps the margin visually equal on all four sides at any aspect", () => {
    for (const aspect of [WIDE, SQUARE, PORTRAIT, TALL]) {
      const { cutout } = frameLayout(aspect, rounded);
      const m = physicalMargins(cutout, aspect);
      const expected = DEFAULT_CUTOUT_INSET * Math.min(aspect, 1);
      expect(m.left).toBeCloseTo(expected, 6);
      expect(m.top).toBeCloseTo(expected, 6);
      // The trailing edge meets the content column, not the frame, on the split axis.
      if (aspect > 1) expect(m.bottom).toBeCloseTo(expected, 6);
      else expect(m.right).toBeCloseTo(expected, 6);
    }
  });

  it("puts the cutout before the content for side start, and after it for side end", () => {
    const start = frameLayout(WIDE, { ...rounded, side: "start" });
    expect(start.cutout.x).toBeLessThan(start.content.x);

    const end = frameLayout(WIDE, { ...rounded, side: "end" });
    expect(end.cutout.x).toBeGreaterThan(end.content.x);
  });

  it("mirrors side onto the vertical axis in tall frames", () => {
    const start = frameLayout(TALL, { ...rounded, side: "start" });
    expect(start.cutout.y).toBeLessThan(start.content.y);
    expect(start.cutout.x).toBeCloseTo(start.content.x, 6);

    const end = frameLayout(TALL, { ...rounded, side: "end" });
    expect(end.cutout.y).toBeGreaterThan(end.content.y);
  });

  it("leaves a double margin gutter between cutout and content, never an overlap", () => {
    const { cutout, content } = frameLayout(WIDE, rounded);
    const gutter = content.x - (cutout.x + cutout.width);
    expect(gutter).toBeGreaterThan(0);
    expect(gutter).toBeCloseTo(2 * cutout.x, 6);
  });

  it("gives the content column the rest of the split axis", () => {
    const { cutout, content } = frameLayout(WIDE, rounded);
    expect(cutout.width + content.width).toBeCloseTo(1 - 4 * cutout.x, 6);
  });

  it("grows the cutout and shrinks the content as size rises", () => {
    const small = frameLayout(WIDE, { ...rounded, size: 0.3 });
    const large = frameLayout(WIDE, { ...rounded, size: 0.8 });
    expect(large.cutout.width).toBeGreaterThan(small.cutout.width);
    expect(large.content.width).toBeLessThan(small.content.width);
  });
});

describe("frameLayout shapes", () => {
  it("squares the circle cutout physically, not in normalised units", () => {
    const { cutout } = frameLayout(WIDE, { shape: "circle" });
    expect(cutout.width * WIDE).toBeCloseTo(cutout.height, 6);
  });

  it("keeps the squared circle centred in the column it came from", () => {
    const base = frameLayout(WIDE, rounded).cutout;
    const circle = frameLayout(WIDE, { shape: "circle" }).cutout;
    expect(circle.x + circle.width / 2).toBeCloseTo(base.x + base.width / 2, 6);
    expect(circle.y + circle.height / 2).toBeCloseTo(base.y + base.height / 2, 6);
  });

  it("leaves rect and squircle without a corner radius", () => {
    expect(frameLayout(WIDE, { shape: "rect" }).radius).toBe(0);
    expect(frameLayout(WIDE, { shape: "squircle" }).radius).toBe(0);
  });

  it("fully rounds capsule and circle to half the shorter edge", () => {
    const { cutout, radius } = frameLayout(WIDE, { shape: "capsule" });
    expect(radius).toBeCloseTo(Math.min((cutout.width * WIDE) / 2, cutout.height / 2), 6);

    const circle = frameLayout(WIDE, { shape: "circle" });
    expect(circle.radius).toBeCloseTo(circle.cutout.height / 2, 6);
  });

  it("scales the rounded-rect radius off the shorter half edge", () => {
    const half = frameLayout(WIDE, { ...rounded, radius: 0.5 });
    const full = frameLayout(WIDE, { ...rounded, radius: 1 });
    expect(half.radius).toBeCloseTo(full.radius / 2, 6);
  });

  it("clamps a radius beyond a capsule back to a capsule", () => {
    const over = frameLayout(WIDE, { ...rounded, radius: 4 });
    const capsule = frameLayout(WIDE, { shape: "capsule" });
    expect(over.radius).toBeCloseTo(capsule.radius, 6);
  });

  it("reports the classic superellipse exponent", () => {
    expect(frameLayout(WIDE, { shape: "squircle" }).exponent).toBe(4);
  });
});

describe("frameLayout guards", () => {
  it("clamps size and inset into range", () => {
    const huge = frameLayout(WIDE, { ...rounded, size: 9, inset: 9 });
    expect(huge.cutout.width).toBeGreaterThan(0);
    expect(huge.cutout.height).toBeGreaterThan(0);

    const tiny = frameLayout(WIDE, { ...rounded, size: -3, inset: -3 });
    expect(tiny.cutout.x).toBe(0);
    expect(tiny.cutout.width).toBeCloseTo(0.1, 6);
  });

  it("never returns a zero-area rect for a degenerate spec", () => {
    const degenerate = frameLayout(WIDE, { ...rounded, size: 0.1, inset: 0.2 });
    expect(degenerate.cutout.width).toBeGreaterThan(0);
    expect(degenerate.content.width).toBeGreaterThan(0);
  });

  it("falls back to the documented defaults", () => {
    const explicit = frameLayout(WIDE, {
      ...rounded,
      size: DEFAULT_CUTOUT_SIZE,
      inset: DEFAULT_CUTOUT_INSET,
      side: "start",
    });
    expect(frameLayout(WIDE, rounded)).toEqual(explicit);
  });
});

describe("cutoutPixelRect", () => {
  it("rounds onto the pixel grid", () => {
    const { cutout } = frameLayout(WIDE, rounded);
    const px = cutoutPixelRect(cutout, 1920, 1080);
    expect(px).toEqual({ x: 43, y: 43, width: 989, height: 994 });
  });

  it("keeps the target at least a pixel in each direction", () => {
    const px = cutoutPixelRect({ x: 0, y: 0, width: 1e-6, height: 1e-6 }, 1920, 1080);
    expect(px.width).toBe(1);
    expect(px.height).toBe(1);
  });
});
