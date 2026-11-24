import { describe, expect, it } from "vitest";
import { type DustShape, dustPuffAt, dustPuffs } from "./DustBurst";

const SHAPE: DustShape = {
  footprint: [3, 0.6],
  reach: 1.6,
  lift: 0.2,
  size: 0.3,
  flatten: 0.6,
  durationMs: 800,
};

describe("dust burst", () => {
  it("draws the same puffs from the same seed", () => {
    expect(dustPuffs(8, 3)).toEqual(dustPuffs(8, 3));
    expect(dustPuffs(8, 3)).not.toEqual(dustPuffs(8, 4));
  });

  it("is invisible before a puff starts and once it has cleared", () => {
    for (const puff of dustPuffs(32, 1)) {
      expect(dustPuffAt(puff, -1, SHAPE).alpha).toBe(0);
      expect(dustPuffAt(puff, puff.delayMs - 0.01, SHAPE).alpha).toBe(0);
      expect(dustPuffAt(puff, SHAPE.durationMs + 60, SHAPE).alpha).toBe(0);
    }
  });

  it("throws each puff outwards from the footprint's edge and never back", () => {
    for (const puff of dustPuffs(32, 1)) {
      let last = 0;
      for (let ms = 0; ms <= 900; ms += 50) {
        const p = dustPuffAt(puff, ms, SHAPE);
        const out = Math.hypot(p.x, p.z);
        expect(out).toBeGreaterThanOrEqual(last - 1e-9);
        expect(p.y).toBeGreaterThan(0);
        expect(p.alpha).toBeGreaterThanOrEqual(0);
        expect(p.alpha).toBeLessThanOrEqual(1);
        last = out;
      }
      const start = dustPuffAt(puff, puff.delayMs, SHAPE);
      expect(Math.abs(start.x)).toBeLessThanOrEqual(SHAPE.footprint[0] / 2 + 1e-9);
      expect(Math.abs(start.z)).toBeLessThanOrEqual(SHAPE.footprint[1] / 2 + 1e-9);
    }
  });

  it("does most of its travel in the first quarter of its life", () => {
    const puff = dustPuffs(1, 5)[0];
    const life = puff.life * SHAPE.durationMs;
    const reach = (ms: number) => {
      const p = dustPuffAt(puff, puff.delayMs + ms, SHAPE);
      return Math.hypot(p.x, p.z);
    };
    const from = reach(0);
    expect((reach(life / 4) - from) / (reach(life) - from)).toBeGreaterThan(0.6);
  });
});
