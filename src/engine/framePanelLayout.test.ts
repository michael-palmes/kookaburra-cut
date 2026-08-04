import { describe, expect, it } from "vitest";
import type { Theme } from "../theme/tokens";
import type { FrameSpec } from "../toolkit/frame/types";
import type { FormatInfo } from "../toolkit/types";
import { computeFormat, FORMATS } from "./format";
import {
  CHART_SLOT_GAP_FRACTION,
  CHART_SLOT_HEIGHT_BELOW,
  framePanelChartSlot,
  framePanelLayout,
  frameTextAlign,
} from "./framePanelLayout";
import {
  CHIP_HEIGHT_FRAC,
  HEADER_BODY_GAP,
  solvePanelLayout,
  TITLE_GAP,
  TITLE_HEIGHT_FRACTION,
  TITLE_WIDTH_FRACTION,
} from "./framePanelMeasure";
import type { SceneDoc } from "./sceneDocSchema";

const wide = computeFormat(FORMATS["16:9"]);
const tall = computeFormat(FORMATS["9:16"]);
const startFrame = { cutout: { shape: "rounded-rect", side: "start" } } as const;
const endFrame = { cutout: { shape: "rounded-rect", side: "end" } } as const;

const theme = {
  colors: { background: "#ffffff", text: "#000000", accent: "#ff0000", muted: "#808080" },
  typography: {
    headline: { family: "Inter", weight: 700 },
    body: { family: "Inter", weight: 400 },
  },
} as unknown as Theme;

/** The panel's drawn stack, exactly as `FramePanel` walks it: the solved header, then the body it stacks under it. Mirrored here so the band tests pin the same heights the renderer places against (the solver runs its cold-cache estimate path in node). */
function panelStack(
  format: FormatInfo,
  frame: FrameSpec,
  doc: SceneDoc,
): { header: number; bodyGap: number; body: number; height: number } {
  const col = framePanelLayout(format, frame);
  const { fit, titleH, subH } = solvePanelLayout(format, frame, doc, theme);
  const baseTitle = Math.min(col.width * TITLE_WIDTH_FRACTION, col.height * TITLE_HEIGHT_FRACTION);
  const titleSize = baseTitle * fit;
  const title = (doc.text?.title ?? "").trim();
  const subtitle = (doc.text?.subtitle ?? "").trim();
  const header = titleH + (title && subtitle ? TITLE_GAP * titleSize : 0) + subH;
  const bodyGap = HEADER_BODY_GAP * titleSize;
  const body = frame.chip ? CHIP_HEIGHT_FRAC * format.frame.height * fit : 0;
  return { header, bodyGap, body, height: header + (body > 0 ? bodyGap + body : 0) };
}

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

describe("framePanelChartSlot under the panel's text", () => {
  // The panel-chart fixture: a full-frame panel (so the text centres) with a big title and a wide subtitle.
  const panelFrame = {
    cutout: { shape: "none" },
    chart: { height: 0.62, position: "below" },
  } as FrameSpec;
  const doc = {
    version: 1,
    text: { title: "Net inflows", subtitle: "Custody balances by quarter, AUD millions" },
  } as SceneDoc;
  const col = framePanelLayout(wide, panelFrame);
  const gap = CHART_SLOT_GAP_FRACTION * Math.min(col.width, col.height);
  const topOf = (slot: { rect: { y: number; height: number } } | undefined) =>
    (slot?.rect.y ?? 0) + (slot?.rect.height ?? 0) / 2;

  it("trims the band so a centred title and subtitle keep a full gap above it", () => {
    expect(frameTextAlign(panelFrame)).toBe("center");
    const { header } = panelStack(wide, panelFrame, doc);
    const bare = framePanelChartSlot(col, panelFrame.chart);
    const slot = framePanelChartSlot(col, panelFrame.chart, header);
    // Unreserved, the authored band climbs into the subtitle's gap; reserved, it lands exactly a gap below it.
    expect(topOf(bare)).toBeGreaterThan(col.top - header - gap);
    expect(topOf(slot)).toBeCloseTo(col.top - header - gap);
    expect(slot?.rect.height).toBeLessThan(bare?.rect.height ?? 0);
    expect(slot?.textBottom).toBeCloseTo(col.top - header);
  });

  it("leaves a band that already fits alone", () => {
    const { header } = panelStack(wide, panelFrame, doc);
    const slot = framePanelChartSlot(col, { height: 0.3 }, header);
    expect(slot?.rect.height).toBeCloseTo(col.height * 0.3);
  });

  it("keeps a chip under the same centred subtitle off the text", () => {
    const chipFrame = { ...panelFrame, chip: { label: "Q4 FY26" } } as FrameSpec;
    const { header, bodyGap, body, height } = panelStack(wide, chipFrame, doc);
    const slot = framePanelChartSlot(col, chipFrame.chart, height);
    // FramePanel floors the body at `textBottom`; reserved, that floor no longer lifts the chip into the header.
    expect(body).toBeGreaterThan(0);
    expect((slot?.textBottom ?? 0) + body).toBeLessThanOrEqual(col.top - header - bodyGap + 1e-9);
    // Unreserved it did: the lifted chip top sat inside the subtitle.
    const bare = framePanelChartSlot(col, chipFrame.chart);
    expect((bare?.textBottom ?? 0) + body).toBeGreaterThan(col.top - header);
  });

  it("keeps a band for a chart even when the text fills the column", () => {
    const slot = framePanelChartSlot(col, panelFrame.chart, col.height * 2);
    expect(slot?.rect.height).toBeCloseTo(col.height * 0.1);
  });

  it("ignores the reserve when the chart replaces the text", () => {
    const slot = framePanelChartSlot(col, { position: "replace" }, col.height * 0.8);
    expect(slot?.rect.height).toBeCloseTo(col.height);
    expect(slot?.replaces).toBe(true);
  });
});
