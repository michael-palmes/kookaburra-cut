import { describe, expect, it } from "vitest";
import { OUTLINE_ARM_FRACTION, outlineBracketSegments } from "./gizmoOutline";

const axis = (v: Float32Array, i: 0 | 1 | 2): number[] => {
  const out: number[] = [];
  for (let k = i; k < v.length; k += 3) out.push(v[k]);
  return out;
};

describe("outlineBracketSegments", () => {
  it("draws three arms at each of a box's eight corners, symmetric about the origin", () => {
    const v = outlineBracketSegments([2, 4, 6]);
    expect(v.length).toBe(8 * 3 * 2 * 3);
    expect(Math.max(...axis(v, 0))).toBeCloseTo(1, 6);
    expect(Math.min(...axis(v, 0))).toBeCloseTo(-1, 6);
    expect(Math.max(...axis(v, 1))).toBeCloseTo(2, 6);
    expect(Math.min(...axis(v, 1))).toBeCloseTo(-2, 6);
    expect(Math.max(...axis(v, 2))).toBeCloseTo(3, 6);
    expect(Math.min(...axis(v, 2))).toBeCloseTo(-3, 6);
  });

  it("draws a flat rectangle when the depth is zero", () => {
    const v = outlineBracketSegments([3.3, 2.2, 0]);
    expect(v.length).toBe(4 * 2 * 2 * 3);
    expect(axis(v, 2).every((z) => z === 0)).toBe(true);
  });

  it("derives the arm from the shortest half-extent, so a thin item's arms stay inside it", () => {
    const v = outlineBracketSegments([1.2, 2.6, 0.07]);
    const shortest = 0.07 / 2;
    const arm = shortest * OUTLINE_ARM_FRACTION;
    // The z arm runs inward from ±hz, so its inner end lands exactly hz - arm from the face.
    const zs = [...new Set(axis(v, 2).map((z) => Math.abs(Math.round(z * 1e6) / 1e6)))].sort();
    expect(zs[0]).toBeCloseTo(shortest - arm, 6);
    expect(arm).toBeLessThanOrEqual(shortest);
  });
});
