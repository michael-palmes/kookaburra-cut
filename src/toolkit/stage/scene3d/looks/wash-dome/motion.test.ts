import { Vector4 } from "three";
import { describe, expect, it } from "vitest";
import { WASH_BLOOM_SLOTS, washCalmBand, washDry, washThreshold, writeWashBlooms } from "./motion";

const slots = () => ({
  centres: Array.from({ length: WASH_BLOOM_SLOTS }, () => new Vector4()),
  amps: new Array<number>(WASH_BLOOM_SLOTS).fill(1),
});

describe("wash dome motion", () => {
  it("keeps the sketch's cloud threshold and fades clouds in over 4 degrees above the calm height", () => {
    expect(washThreshold(0.35)).toBeCloseTo(0.46, 10);
    const [lo, hi] = washCalmBand(9);
    expect(Math.asin(lo) * (180 / Math.PI)).toBeCloseTo(9, 10);
    expect(Math.asin(hi) * (180 / Math.PI)).toBeCloseTo(13, 10);
  });

  it("dries and creeps on a closed 30 s loop", () => {
    expect(washDry(3)).toBeCloseTo(washDry(33), 10);
    expect(Math.abs(washDry(7.5))).toBeCloseTo(0.025, 10);
  });

  it("schedules blooms as a pure function of time, dark past the count", () => {
    const a = slots();
    const b = slots();
    writeWashBlooms(47.25, 5, a.centres, a.amps);
    writeWashBlooms(47.25, 5, b.centres, b.amps);
    expect(a.centres.map((v) => v.toArray())).toEqual(b.centres.map((v) => v.toArray()));
    expect(a.amps).toEqual(b.amps);
    expect(a.amps.slice(5)).toEqual([0, 0, 0]);
    for (let k = 0; k < 5; k++) {
      const c = a.centres[k];
      expect(Math.hypot(c.x, c.y, c.z)).toBeCloseTo(1, 10);
      expect(c.y).toBeGreaterThan(Math.sin(0.24) - 1e-9);
      expect(c.y).toBeLessThan(Math.sin(0.4) + 1e-9);
      expect(a.amps[k]).toBeGreaterThanOrEqual(0);
      expect(a.amps[k]).toBeLessThanOrEqual(1);
    }
  });

  it("opens and closes each bloom from nothing, so a new bearing never pops in", () => {
    const s = slots();
    // Slot 0 (22 s period) starts a cycle at t = 44.
    writeWashBlooms(44, 1, s.centres, s.amps);
    expect(s.amps[0]).toBe(0);
    writeWashBlooms(44 - 1e-6, 1, s.centres, s.amps);
    expect(s.amps[0]).toBeCloseTo(0, 6);
  });
});
