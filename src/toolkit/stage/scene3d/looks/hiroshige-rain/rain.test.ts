import { describe, expect, it } from "vitest";
import {
  RAIN_DENSITY_MAX,
  RAIN_FALL_PERIOD,
  RAIN_FLOOR_Y,
  RAIN_PUDDLE_PERIOD,
  RAIN_PUDDLE_SLOTS,
  RAIN_PUDDLES_MAX,
  RAIN_VEILS,
  rainLaps,
  rainPuddleSeeds,
  rainSlants,
  rainSpan,
  rainStrandCount,
  rainStrands,
} from "./rain";

const strands = rainStrands();
const capacity = RAIN_VEILS.reduce((n, v) => n + Math.round(v.count * RAIN_DENSITY_MAX), 0);

describe("hiroshige rain streaks", () => {
  it("builds both veils at the densest setting, same every time", () => {
    expect(strands).toHaveLength(capacity);
    expect(rainStrands()).toEqual(strands);
  });

  it("interleaves the veils so any density prefix keeps their ratio", () => {
    const shown = rainStrandCount(1);
    const near = strands.slice(0, shown).filter((s) => s.data[0] === 0).length;
    expect(Math.abs(near - RAIN_VEILS[0].count)).toBeLessThanOrEqual(2);
    expect(rainStrandCount(RAIN_DENSITY_MAX)).toBe(capacity);
    expect(rainStrandCount(99)).toBe(capacity);
    expect(rainStrandCount(-1)).toBe(0);
  });

  it("draws each streak as one segment, both ends sharing the anchor", () => {
    for (const s of strands) {
      expect(s.points.length).toBe(8);
      expect([s.points[3], s.points[7]]).toEqual([-0.5, 0.5]);
      expect(s.points.subarray(0, 3)).toEqual(s.points.subarray(4, 7));
    }
  });

  it("falls a whole number of spans per period at about the veil's speed, so the fall loops", () => {
    for (const s of strands) {
      const veil = RAIN_VEILS[s.data[0]];
      const laps = s.data[2];
      expect(Number.isInteger(laps)).toBe(true);
      const speed = (laps * rainSpan(veil)) / RAIN_FALL_PERIOD;
      const tolerance = rainSpan(veil) / RAIN_FALL_PERIOD;
      expect(speed).toBeGreaterThanOrEqual(veil.speed[0] - tolerance);
      expect(speed).toBeLessThanOrEqual(veil.speed[1] + tolerance);
    }
    expect(rainLaps(RAIN_VEILS[0], 0)).toBe(1);
  });

  it("wraps every streak below the floor, where it is already faded", () => {
    for (const veil of RAIN_VEILS) {
      const lowestTop = veil.top - rainSpan(veil) + veil.length[1] / 2;
      expect(lowestTop).toBeLessThan(RAIN_FLOOR_Y);
    }
  });
});

describe("hiroshige rain puddles and sway", () => {
  it("cycles each puddle slot over whole seconds that divide the puddle period", () => {
    const seeds = rainPuddleSeeds();
    expect(seeds.length).toBe(RAIN_PUDDLE_SLOTS * RAIN_PUDDLES_MAX * 4);
    for (let i = 0; i < seeds.length / 4; i++) {
      const cycle = seeds[i * 4 + 1];
      expect(cycle).toBeGreaterThanOrEqual(5);
      expect(cycle).toBeLessThanOrEqual(9);
      expect(RAIN_PUDDLE_PERIOD % cycle).toBe(0);
    }
  });

  it("sways the slants on a 30 s loop round the slider angles", () => {
    const a = rainSlants(0, -7, 12);
    expect(a[0]).toBeCloseTo((-7 * Math.PI) / 180, 10);
    const b = rainSlants(37.5, -7, 12);
    const c = rainSlants(7.5, -7, 12);
    expect(b[0]).toBeCloseTo(c[0], 10);
    expect(b[1]).toBeCloseTo(c[1], 10);
    expect(Math.abs(c[0] - a[0])).toBeLessThanOrEqual((2.5 * Math.PI) / 180 + 1e-9);
  });
});
