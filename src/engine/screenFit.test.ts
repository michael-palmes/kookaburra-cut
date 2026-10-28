import { describe, expect, it } from "vitest";
import { coverCropRect, remapScreenUv, remapUv, screenUvMap } from "./screenFit";

const PHONE = 1179 / 2556; // iPhone 15 Pro display, width/height ≈ 0.4613

describe("coverCropRect", () => {
  it("crops the sides of media wider than the screen (landscape video on a phone)", () => {
    const rect = coverCropRect(16 / 9, PHONE, false);
    expect(rect.v0).toBe(0);
    expect(rect.v1).toBe(1);
    const w = rect.u1 - rect.u0;
    expect(w).toBeCloseTo(PHONE / (16 / 9), 12);
    expect(rect.u0).toBeCloseTo((1 - w) / 2, 12); // centred
  });

  it("crops top/bottom of media taller than the screen", () => {
    const rect = coverCropRect(9 / 22, PHONE, false);
    expect(rect.u0).toBe(0);
    expect(rect.u1).toBe(1);
    const h = rect.v1 - rect.v0;
    expect(h).toBeCloseTo(9 / 22 / PHONE, 12);
    expect(rect.v0).toBeCloseTo((1 - h) / 2, 12);
  });

  it("shows the full media when aspects match exactly", () => {
    expect(coverCropRect(PHONE, PHONE, false)).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 });
  });

  it("flipV swaps the V span (and only the V span)", () => {
    const flat = coverCropRect(16 / 9, PHONE, false);
    const flipped = coverCropRect(16 / 9, PHONE, true);
    expect(flipped).toEqual({ u0: flat.u0, u1: flat.u1, v0: flat.v1, v1: flat.v0 });
  });

  it("degrades to the full rect on degenerate aspects", () => {
    expect(coverCropRect(0, PHONE, false)).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 });
    expect(coverCropRect(16 / 9, 0, false)).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 });
  });
});

describe("remapUv", () => {
  it("maps screen UV corners onto the crop rect", () => {
    const rect = { u0: 0.2, v0: 0.1, u1: 0.8, v1: 0.9 };
    expect(remapUv(0, 0, rect)).toEqual([0.2, 0.1]);
    expect(remapUv(1, 1, rect)).toEqual([0.8, 0.9]);
    expect(remapUv(0.5, 0.5, rect)).toEqual([0.5, 0.5]);
  });

  it("runs V backwards through a flipped rect", () => {
    const rect = coverCropRect(1, 1, true);
    expect(remapUv(0.25, 0, rect)).toEqual([0.25, 1]);
    expect(remapUv(0.25, 1, rect)).toEqual([0.25, 0]);
  });
});

describe("screenUvMap", () => {
  const DUO_COVER = 1398 / 2034;
  const near = (actual: [number, number], expected: [number, number]) => {
    expect(actual[0]).toBeCloseTo(expected[0], 12);
    expect(actual[1]).toBeCloseTo(expected[1], 12);
  };

  it("keeps unturned media on the plain cover crop, flip and all", () => {
    for (const flipV of [false, true]) {
      expect(screenUvMap(16 / 9, PHONE, flipV, 0)).toEqual({
        rect: coverCropRect(16 / 9, PHONE, flipV),
      });
    }
  });

  it("turns a portrait image clockwise onto a landscape screen, the top edge to the right", () => {
    const map = screenUvMap(1 / 2, 2, false, 1);
    // A 1:2 image turned a quarter is 2:1, the screen's own aspect: nothing is cropped.
    expect(map.rect).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 });
    near(remapScreenUv(1, 0, map), [0, 0]);
    near(remapScreenUv(0, 0, map), [0, 1]);
    near(remapScreenUv(1, 1, map), [1, 0]);
  });

  it("fits after the turn, cropping the turned media's long edge", () => {
    const map = screenUvMap(9 / 19.5, DUO_COVER, false, 1);
    const turned = 19.5 / 9;
    expect(map.rect.u1 - map.rect.u0).toBeCloseTo(DUO_COVER / turned, 12);
    expect(map.rect.v0).toBe(0);
  });

  it("flips video's V after the turn, never before", () => {
    const image = screenUvMap(1, 1, false, 3);
    const video = screenUvMap(1, 1, true, 3);
    for (const [u, v] of [
      [0, 0],
      [0.25, 0.75],
      [1, 0.5],
    ] as const) {
      const [x, y] = remapScreenUv(u, v, image);
      near(remapScreenUv(u, v, video), [x, 1 - y]);
    }
  });

  it("brings four quarter turns back round to the start", () => {
    const point: [number, number] = [0.2, 0.7];
    let at = point;
    for (let i = 0; i < 4; i++) at = remapScreenUv(at[0], at[1], screenUvMap(1, 1, false, 1));
    near(at, point);
    near(remapScreenUv(0.2, 0.7, screenUvMap(1, 1, false, 2)), [0.8, 0.3]);
  });
});
