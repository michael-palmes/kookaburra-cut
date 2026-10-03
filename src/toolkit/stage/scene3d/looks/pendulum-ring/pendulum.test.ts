import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  PENDULUM,
  PENDULUM_CAPACITY,
  pendulumAngle,
  pendulumAt,
  pendulumPhase,
  pendulumTotal,
  pendulumTri,
  railCount,
  swingBase,
  writeSunDirection,
} from "./pendulum";

describe("pendulum ring layout", () => {
  it("hangs 168 bobs on the default three rails, rail-major", () => {
    expect(pendulumTotal(48, 3)).toBe(168);
    expect([0, 1, 2].map((k) => railCount(48, k))).toEqual([48, 56, 64]);
    expect(PENDULUM_CAPACITY).toBe(pendulumTotal(PENDULUM.maxCount, PENDULUM.maxRails));
  });

  it("maps every drawn index to one rail slot, in order", () => {
    for (const [count, rails] of [
      [48, 3],
      [24, 4],
      [72, 1],
    ]) {
      const seen = new Set<string>();
      for (let s = 0; s < pendulumTotal(count, rails); s++) {
        const { rail, index, n } = pendulumAt(s, count);
        expect(rail).toBeLessThan(rails);
        expect(n).toBe(railCount(count, rail));
        expect(index).toBeLessThan(n);
        seen.add(`${rail}:${index}`);
      }
      expect(seen.size).toBe(pendulumTotal(count, rails));
    }
  });

  it("mirrors lengths and frequencies round the ring, so the snakes have no seam", () => {
    for (let i = 1; i < 48; i++) expect(pendulumTri(i, 48)).toBe(pendulumTri(48 - i, 48));
    expect(pendulumTri(24, 48)).toBe(24);
  });
});

describe("pendulum ring motion", () => {
  const period = 480;
  const swings = (tri: number) => swingBase(period) + tri;

  it("swings every 6 to 10 s at the defaults, the back arc fastest", () => {
    expect(period / swings(0)).toBeCloseTo(10, 6);
    expect(period / swings(32)).toBeCloseTo(6, 6);
  });

  it("realigns every bob exactly once per period, and the start pattern offsets it", () => {
    const at = (t: number, epoch: number) => {
      const phase = pendulumPhase(t, period, epoch);
      return Array.from({ length: 33 }, (_, tri) => pendulumAngle(tri, 64, phase, period, 0.5));
    };
    const aligned = at(period - 40, 40);
    for (let tri = 0; tri <= 32; tri++) {
      expect(aligned[tri]).toBeCloseTo(Math.asin(0.5 / (5.2 - (0.8 * tri) / 32)), 9);
    }
    const a = at(123.4, 40);
    const b = at(123.4 + period * 5, 40);
    for (let tri = 0; tri <= 32; tri++) expect(b[tri]).toBeCloseTo(a[tri], 9);
    expect(new Set(at(100, 40).map((v) => v.toFixed(3))).size).toBeGreaterThan(20);
  });

  it("caps the linear swing at the bob", () => {
    const amp = pendulumAngle(0, 48, 0, period, 0.7);
    expect(Math.sin(amp) * PENDULUM.lengthMax).toBeCloseTo(0.7, 9);
  });

  it("turns the virtual sun a whole number of times per period", () => {
    const a = new Vector3();
    const b = new Vector3();
    writeSunDirection(a, 77, period);
    writeSunDirection(b, 77 + period, period);
    expect(a.distanceTo(b)).toBeLessThan(1e-9);
    expect(a.length()).toBeCloseTo(1, 9);
  });
});
