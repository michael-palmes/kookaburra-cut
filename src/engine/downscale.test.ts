import { describe, expect, it } from "vitest";
import { downscaleRgba } from "./downscale";

/** Opaque greyscale RGBA from rows of grey levels. */
function grey(rows: number[][]): Uint8Array {
  return Uint8Array.from(rows.flat().flatMap((v) => [v, v, v, 255]));
}

/** Each output pixel's red channel, as rows. */
function reds(out: Uint8ClampedArray, width: number): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i < out.length; i += 4) {
    const px = i / 4;
    if (px % width === 0) rows.push([]);
    rows[rows.length - 1].push(out[i]);
  }
  return rows;
}

describe("downscaleRgba", () => {
  it("copies at 1:1 and flips GL's bottom-up rows on request", () => {
    const src = grey([
      [10, 20],
      [30, 40],
    ]);
    expect(Array.from(downscaleRgba(src, 2, 2, 2, 2))).toEqual(Array.from(src));
    expect(reds(downscaleRgba(src, 2, 2, 2, 2, true), 2)).toEqual([
      [30, 40],
      [10, 20],
    ]);
  });

  it("averages every covered pixel at whole ratios", () => {
    const src = grey([
      [0, 100, 200, 40],
      [20, 60, 0, 0],
    ]);
    expect(reds(downscaleRgba(src, 4, 2, 2, 1), 2)).toEqual([[45, 60]]);
  });

  it("weights partly covered pixels by area at fractional ratios", () => {
    // 3 → 2: each output covers 1.5 source pixels.
    const src = grey([[0, 90, 180]]);
    expect(reds(downscaleRgba(src, 3, 1, 2, 1), 2)).toEqual([[30, 150]]);
  });

  it("keeps a one-pixel line continuous instead of sampling it into dashes", () => {
    const rows = Array.from({ length: 12 }, () => [0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0]);
    const out = reds(downscaleRgba(grey(rows), 12, 12, 3, 3), 3);
    for (const row of out) expect(row).toEqual([0, 64, 0]);
  });

  it("treats the readback as premultiplied, so transparent pixels never darken colour", () => {
    const src = Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]);
    expect(Array.from(downscaleRgba(src, 2, 1, 1, 1))).toEqual([255, 0, 0, 128]);
    expect(Array.from(downscaleRgba(new Uint8Array(8), 2, 1, 1, 1))).toEqual([0, 0, 0, 0]);
  });
});
