import { describe, expect, it } from "vitest";
import { type Point, roundPolygon } from "./roundCorners";

const square: Point[] = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
];

describe("roundPolygon", () => {
  it("replaces each sharp corner with a curve that stays inside the outline", () => {
    const out = roundPolygon(square, 0.5);
    expect(out.length).toBe(4 * 7);
    for (const corner of square) {
      expect(out.some((p) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < 1e-9)).toBe(false);
    }
    for (const [x, y] of out) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(4 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(4 + 1e-9);
    }
    expect(out[0]).toEqual([0, 0.5]);
    expect(out[6]).toEqual([0.5, 0]);
  });

  it("caps the fillet so neighbouring corners never meet", () => {
    const out = roundPolygon(square, 10);
    expect(out[0]?.[1]).toBeCloseTo(1.8, 9);
    expect(out[6]?.[0]).toBeCloseTo(1.8, 9);
  });

  it("leaves a smooth outline and a zero radius alone", () => {
    const circle: Point[] = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return [Math.cos(a), Math.sin(a)] as const;
    });
    expect(roundPolygon(circle, 0.2)).toEqual(circle);
    expect(roundPolygon(square, 0)).toEqual(square);
  });

  it("keeps the gentle samples between two corners", () => {
    const tab: Point[] = [
      [0, 0],
      [2, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ];
    const out = roundPolygon(tab, 0.5);
    expect(out.some((p) => p[0] === 2 && p[1] === 0)).toBe(true);
  });
});
