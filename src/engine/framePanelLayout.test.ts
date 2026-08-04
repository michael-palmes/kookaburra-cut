import { describe, expect, it } from "vitest";
import { computeFormat, FORMATS } from "./format";
import {
  CHART_SLOT_GAP_FRACTION,
  CHART_SLOT_HEIGHT_BELOW,
  framePanelChartSlot,
  framePanelLayout,
} from "./framePanelLayout";

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

describe("framePanelChartSlot", () => {
  const col = framePanelLayout(wide, startFrame);

  it("has no slot without one, or with one switched off", () => {
    expect(framePanelChartSlot(col, undefined)).toBeUndefined();
    expect(framePanelChartSlot(col, { enabled: false })).toBeUndefined();
  });

  it("anchors the default band to the bottom of the padded column, full width", () => {
    const slot = framePanelChartSlot(col, {});
    expect(slot?.rect.height).toBeCloseTo(col.height * CHART_SLOT_HEIGHT_BELOW);
    expect(slot?.rect.width).toBe(col.width);
    expect(slot?.rect.x).toBeCloseTo(col.left + col.width / 2);
    // Rect is centre-based, so its lower edge lands exactly on the column floor.
    expect((slot?.rect.y ?? 0) - (slot?.rect.height ?? 0) / 2).toBeCloseTo(col.bottom);
    expect(slot?.replaces).toBe(false);
  });

  it("gives a replacing chart the whole column", () => {
    const slot = framePanelChartSlot(col, { position: "replace" });
    expect(slot?.rect.height).toBeCloseTo(col.height);
    expect(slot?.replaces).toBe(true);
  });

  it("keeps the text floor a gap above the band", () => {
    const slot = framePanelChartSlot(col, { height: 0.5 });
    const gap = CHART_SLOT_GAP_FRACTION * Math.min(col.width, col.height);
    expect(slot?.textBottom).toBeCloseTo(col.bottom + col.height * 0.5 + gap);
  });

  it("clamps an out-of-range or non-finite height", () => {
    expect(framePanelChartSlot(col, { height: 4 })?.rect.height).toBeCloseTo(col.height);
    expect(framePanelChartSlot(col, { height: -1 })?.rect.height).toBeCloseTo(col.height * 0.1);
    expect(framePanelChartSlot(col, { height: Number.NaN })?.rect.height).toBeCloseTo(
      col.height * CHART_SLOT_HEIGHT_BELOW,
    );
  });

  it("stays inside the column in tall aspects too", () => {
    const tallCol = framePanelLayout(tall, startFrame);
    const slot = framePanelChartSlot(tallCol, { height: 0.9 });
    expect((slot?.rect.y ?? 0) + (slot?.rect.height ?? 0) / 2).toBeLessThanOrEqual(tallCol.top);
    expect((slot?.rect.y ?? 0) - (slot?.rect.height ?? 0) / 2).toBeCloseTo(tallCol.bottom);
  });
});
