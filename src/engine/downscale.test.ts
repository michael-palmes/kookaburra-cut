import { describe, expect, it } from "vitest";
import { downscaleRgba, downscaleScratchLength, pageFromReadback } from "./downscale";

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

  it("composites over black and ignores alpha, as the export encode does", () => {
    const src = Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]);
    expect(Array.from(downscaleRgba(src, 2, 1, 1, 1))).toEqual([128, 0, 0, 255]);
    // Additive glow over a zero-alpha clear: un-premultiplying by that alpha zeroed the whole tile.
    const glow = Uint8Array.from([90, 160, 200, 0, 30, 60, 90, 0]);
    expect(Array.from(downscaleRgba(glow, 2, 1, 1, 1))).toEqual([60, 110, 145, 255]);
  });
});

/** A deterministic premultiplied readback with varied alpha. */
function noise(width: number, height: number, seed: number): Uint8Array {
  return Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 37 + seed * 101) % 256);
}

describe("pageFromReadback", () => {
  it("flip-copies a native-size page byte for byte as the box filter would", () => {
    const src = noise(7, 5, 1);
    const fast = pageFromReadback(src, 7, 5, 7, 5);
    expect(Array.from(fast)).toEqual(Array.from(downscaleRgba(src, 7, 5, 7, 5, true)));
  });

  it("downscales smaller pages through the box filter, flipped", () => {
    const src = noise(12, 8, 2);
    expect(Array.from(pageFromReadback(src, 12, 8, 5, 3))).toEqual(
      Array.from(downscaleRgba(src, 12, 8, 5, 3, true)),
    );
  });

  it("reuses its buffers across pages without carrying anything over", () => {
    const out = new Uint8ClampedArray(5 * 3 * 4);
    const scratch = new Float64Array(downscaleScratchLength(8, 5));
    const first = pageFromReadback(noise(12, 8, 3), 12, 8, 5, 3, out, scratch);
    expect(first).toBe(out);
    const second = Array.from(pageFromReadback(noise(12, 8, 4), 12, 8, 5, 3, out, scratch));
    expect(second).toEqual(Array.from(downscaleRgba(noise(12, 8, 4), 12, 8, 5, 3, true)));
    const native = new Uint8ClampedArray(12 * 8 * 4);
    pageFromReadback(noise(12, 8, 5), 12, 8, 12, 8, native);
    expect(Array.from(pageFromReadback(noise(12, 8, 6), 12, 8, 12, 8, native))).toEqual(
      Array.from(downscaleRgba(noise(12, 8, 6), 12, 8, 12, 8, true)),
    );
  });
});
