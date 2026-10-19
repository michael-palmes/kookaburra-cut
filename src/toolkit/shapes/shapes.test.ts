import { describe, expect, it } from "vitest";
import { offsetPolygon, pressScale } from "./Cursor";
import { bracketPoints } from "./DashedRule";
import { dashPolyline } from "./dashes";

const lengths = (pieces: { length: number }[]) => pieces.map((p) => Number(p.length.toFixed(6)));

describe("dashPolyline", () => {
  it("starts and ends a run on a dash", () => {
    const pieces = dashPolyline(
      [
        [0, 0],
        [1, 0],
      ],
      0.2,
      0.2,
    );
    expect(lengths(pieces)).toEqual([0.2, 0.2, 0.2]);
    expect(pieces.map((p) => Number(p.x.toFixed(6)))).toEqual([0.1, 0.5, 0.9]);
    expect(pieces.every((p) => p.y === 0 && p.angle === 0)).toBe(true);
  });

  it("keeps every slot while a draw-on trims the dash it ends inside", () => {
    const line: [number, number][] = [
      [0, 0],
      [1, 0],
    ];
    const pieces = dashPolyline(line, 0.2, 0.2, [0, 0.5]);
    expect(lengths(pieces)).toEqual([0.2, 0.1, 0]);
    expect(pieces[1].x).toBeCloseTo(0.45);
    expect(lengths(dashPolyline(line, 0.2, 0.2, [0, 0]))).toEqual([0, 0, 0]);
  });

  it("lays each segment of a path on its own run and angle", () => {
    const pieces = dashPolyline(
      [
        [0, 0],
        [0, -1],
        [1, -1],
      ],
      0.2,
      0.2,
    );
    expect(pieces).toHaveLength(6);
    expect(pieces[0].angle).toBeCloseTo(-Math.PI / 2);
    expect(pieces[3].angle).toBe(0);
  });

  it("reveals a window of the path for a centre draw-on", () => {
    const pieces = dashPolyline(
      [
        [0, 0],
        [1, 0],
      ],
      0.2,
      0.2,
      [0.45, 0.55],
    );
    expect(lengths(pieces)).toEqual([0, 0.1, 0]);
    expect(pieces[1].x).toBeCloseTo(0.5);
  });
});

describe("bracketPoints", () => {
  it("points the end ticks away from the side the bracket sits on", () => {
    expect(bracketPoints(2, 0.2, "top")).toEqual([
      [-1, -0.2],
      [-1, 0],
      [1, 0],
      [1, -0.2],
    ]);
    expect(bracketPoints(2, 0.2, "left")[0]).toEqual([0.2, 1]);
    expect(bracketPoints(2, 0.2, "right")[0]).toEqual([-0.2, 1]);
    expect(bracketPoints(2, 0.2, "bottom")[0]).toEqual([-1, 0.2]);
  });
});

describe("Cursor helpers", () => {
  it("dips on a press and recovers", () => {
    expect(pressScale(-1)).toBe(1);
    expect(pressScale(0)).toBe(1);
    expect(pressScale(80)).toBeCloseTo(0.86);
    expect(pressScale(160)).toBeGreaterThan(0.86);
    expect(pressScale(240)).toBe(1);
  });

  it("grows a square outward by the offset", () => {
    const square: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const grown = offsetPolygon(square, 0.1);
    expect(grown[0][0]).toBeCloseTo(-0.1);
    expect(grown[0][1]).toBeCloseTo(-0.1);
    expect(grown[2][0]).toBeCloseTo(1.1);
    expect(grown[2][1]).toBeCloseTo(1.1);
  });
});
