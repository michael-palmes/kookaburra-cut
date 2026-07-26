import { describe, expect, it } from "vitest";
import { catmullRom, catmullRomTangent, lerp3 } from "./keyframes";

type V3 = [number, number, number];

// Deliberately asymmetric: a symmetric neighbour pair puts the curve's midpoint back on the chord.
const P0: V3 = [-1, 2, 0];
const P1: V3 = [0, 0, 0];
const P2: V3 = [1, 1, 0];
const P3: V3 = [2, 1, 0];

/** Numeric derivative, only ever used to CHECK the analytic one. */
const fd = (u: number): V3 => {
  const h = 1e-6;
  const a = catmullRom(P0, P1, P2, P3, u - h);
  const b = catmullRom(P0, P1, P2, P3, u + h);
  return [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)];
};

describe("catmullRom", () => {
  it("passes through p1 at u=0 and p2 at u=1", () => {
    expect(catmullRom(P0, P1, P2, P3, 0)).toEqual(P1);
    const end = catmullRom(P0, P1, P2, P3, 1);
    expect(end[0]).toBeCloseTo(1, 12);
    expect(end[1]).toBeCloseTo(1, 12);
  });

  it("curves off the chord in the middle (that IS the smoothing)", () => {
    const mid = catmullRom(P0, P1, P2, P3, 0.5);
    const chord = lerp3(P1, P2, 0.5);
    expect(Math.abs(mid[1] - chord[1])).toBeGreaterThan(1e-3);
  });

  it("a reflected neighbour pair reduces to the straight lerp, exactly", () => {
    // The rig reflects missing end neighbours (sceneRig.ts) precisely so a lone
    // segment stays a straight, evenly timed dolly.
    const reflectBefore: V3 = [2 * P1[0] - P2[0], 2 * P1[1] - P2[1], 2 * P1[2] - P2[2]];
    const reflectAfter: V3 = [2 * P2[0] - P1[0], 2 * P2[1] - P1[1], 2 * P2[2] - P1[2]];
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const point = catmullRom(reflectBefore, P1, P2, reflectAfter, u);
      const straight = lerp3(P1, P2, u);
      expect(point[0]).toBeCloseTo(straight[0], 12);
      expect(point[1]).toBeCloseTo(straight[1], 12);
      expect(point[2]).toBeCloseTo(straight[2], 12);
    }
  });

  it("stays within a tolerance of the chord on unevenly spaced keys (centripetal, no cusps)", () => {
    const far: V3 = [40, 0, 0];
    let worst = 0;
    for (let i = 0; i <= 100; i++) {
      const p = catmullRom(far, P1, P2, P3, i / 100);
      const chord = lerp3(P1, P2, i / 100);
      worst = Math.max(worst, Math.abs(p[1] - chord[1]));
    }
    expect(worst).toBeLessThan(0.5);
  });

  it("degenerate p1 == p2 collapses to that point rather than dividing by zero", () => {
    expect(catmullRom(P0, P1, P1, P3, 0.5)).toEqual(P1);
    expect(catmullRomTangent(P0, P1, P1, P3, 0.5)).toEqual([0, 0, 0]);
  });

  it("duplicated neighbours are finite (the other endpoint convention still evaluates)", () => {
    const p = catmullRom(P1, P1, P2, P2, 0.5);
    expect(p.every(Number.isFinite)).toBe(true);
  });
});

describe("catmullRomTangent", () => {
  it("matches a finite difference across the segment", () => {
    for (const u of [0, 0.2, 0.5, 0.8, 1]) {
      const analytic = catmullRomTangent(P0, P1, P2, P3, u);
      const numeric = fd(u);
      expect(analytic[0]).toBeCloseTo(numeric[0], 4);
      expect(analytic[1]).toBeCloseTo(numeric[1], 4);
      expect(analytic[2]).toBeCloseTo(numeric[2], 4);
    }
  });

  it("points along the chord on a collinear, evenly spaced path", () => {
    const a: V3 = [0, 0, 0];
    const b: V3 = [1, 0, 0];
    const t = catmullRomTangent([-1, 0, 0], a, b, [2, 0, 0], 0.5);
    expect(t[1]).toBeCloseTo(0, 12);
    expect(t[2]).toBeCloseTo(0, 12);
    expect(t[0]).toBeGreaterThan(0);
  });
});
