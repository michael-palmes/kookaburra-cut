import { describe, expect, it } from "vitest";
import {
  computeUnitYExtents,
  HIGHLIGHT_PAD_X_EM,
  HIGHLIGHT_PAD_Y_EM,
  highlightQuads,
} from "./HighlightQuads";
import { EDGE_SENTINEL, type StaggerUnits, type TextUnitSample } from "./presets";
import { UNDERLINE_GAP_EM, UNDERLINE_THICKNESS_EM, underlineQuad } from "./UnderlineRule";

const units: StaggerUnits = {
  count: 2,
  startX: new Float32Array([0, 2]),
  endX: new Float32Array([1.5, 3]),
  edgeKey: new Float32Array([1.75, EDGE_SENTINEL]),
  centerY: new Float32Array([0, 0]),
  axis: "x",
};

const sample = (over: Partial<TextUnitSample>): TextUnitSample => ({
  alpha: 1,
  dxEm: 0,
  dyEm: 0,
  scale: 1,
  blurEm: 0,
  sweep: [0, 1],
  rotYRad: 0,
  shineU: -1,
  rotZRad: 0,
  dzEm: 0,
  rotXRad: 0,
  scaleX: 1,
  scaleY: 1,
  clipFinal: false,
  colorMix: 0,
  weightEm: 0,
  softEm: 0,
  chromaEm: 0,
  highlight: [0, 0],
  ...over,
});

describe("computeUnitYExtents", () => {
  it("accumulates per-unit caret extents on the shader's unit walk, skipping whitespace", () => {
    // "ab cd": chars at x 0/0.75 and 2/2.5; caret rows [x0, x1, bottom, top].
    const carets = new Float32Array([
      0, 0.7, -0.2, 0.6, 0.75, 1.5, -0.25, 0.6, 1.6, 1.9, -0.9, 0.9, 2, 2.4, -0.1, 0.5, 2.5, 3,
      -0.3, 0.7,
    ]);
    const boxes = computeUnitYExtents(units, "ab cd", carets);
    expect(Array.from(boxes)).toHaveLength(4);
    expect(boxes[0]).toBeCloseTo(-0.25);
    expect(boxes[1]).toBeCloseTo(0.6);
    expect(boxes[2]).toBeCloseTo(-0.3);
    expect(boxes[3]).toBeCloseTo(0.7);
  });

  it("collapses units that receive no ink to zero", () => {
    const boxes = computeUnitYExtents(units, "  ", new Float32Array(8));
    expect(Array.from(boxes)).toEqual([0, 0, 0, 0]);
  });
});

describe("highlightQuads", () => {
  const boxes = new Float32Array([-0.2, 0.6, -0.3, 0.7]);

  it("returns nothing at the [0, 0] off window", () => {
    expect(highlightQuads(units, boxes, [sample({}), sample({})], 0.5)).toEqual([]);
  });

  it("maps the highlight window over the padded unit extent", () => {
    const quads = highlightQuads(units, boxes, [sample({ highlight: [0, 0.5] }), sample({})], 0.5);
    expect(quads).toHaveLength(1);
    const padX = HIGHLIGHT_PAD_X_EM * 0.5;
    const padY = HIGHLIGHT_PAD_Y_EM * 0.5;
    const left = 0 - padX;
    const w = 1.5 + 2 * padX;
    expect(quads[0].w).toBeCloseTo(w / 2);
    expect(quads[0].x).toBeCloseTo(left + w / 4);
    expect(quads[0].h).toBeCloseTo(0.8 + 2 * padY);
    expect(quads[0].y).toBeCloseTo(0.2);
    expect(quads[0].opacity).toBe(1);
  });

  it("rides the unit's dx/dy and alpha", () => {
    const quads = highlightQuads(
      units,
      boxes,
      [sample({}), sample({ highlight: [0.25, 1], dxEm: 0.4, dyEm: -0.2, alpha: 0.5 })],
      0.5,
    );
    expect(quads).toHaveLength(1);
    expect(quads[0].unit).toBe(1);
    // left 1.93, window width 1.14: window [2.215, 3.07], centre 2.6425, +dx 0.2.
    expect(quads[0].x).toBeCloseTo(2.8425, 4);
    expect(quads[0].y).toBeCloseTo((-0.3 - 0.05 + 0.7 + 0.05) / 2 - 0.1, 4);
    expect(quads[0].opacity).toBe(0.5);
  });
});

describe("underlineQuad", () => {
  const bounds: readonly [number, number, number, number] = [-1, -0.4, 1, 0.4];

  it("returns null when nothing draws", () => {
    expect(underlineQuad(bounds, 0, 0.5)).toBeNull();
    expect(underlineQuad(bounds, -0.2, 0.5)).toBeNull();
  });

  it("draws left-anchored under the block, clamped to full width", () => {
    const half = underlineQuad(bounds, 0.5, 0.5);
    expect(half).not.toBeNull();
    expect(half?.w).toBeCloseTo(1);
    expect(half?.x).toBeCloseTo(-0.5);
    expect(half?.y).toBeCloseTo(-0.4 - (UNDERLINE_GAP_EM + UNDERLINE_THICKNESS_EM / 2) * 0.5);
    expect(half?.h).toBeCloseTo(UNDERLINE_THICKNESS_EM * 0.5);
    const full = underlineQuad(bounds, 1.4, 0.5);
    expect(full?.w).toBeCloseTo(2);
    expect(full?.x).toBeCloseTo(0);
  });
});
