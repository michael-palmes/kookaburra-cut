import { describe, expect, it } from "vitest";
import { coverCropRect, remapUv } from "./screenFit";

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
