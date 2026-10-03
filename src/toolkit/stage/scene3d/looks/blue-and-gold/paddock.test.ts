import { describe, expect, it } from "vitest";
import { DAUB_FIELD, PAINTER_SUN, PAINTER_SUN_ORBIT, placeDaubs } from "./paddock";

describe("placeDaubs", () => {
  const daubs = placeDaubs();

  it("fills the densest pool once, deterministically", () => {
    expect(daubs).toHaveLength(Math.round(DAUB_FIELD.count * DAUB_FIELD.maxDensity));
    expect(new Set(daubs.map((d) => d.id)).size).toBe(daubs.length);
    expect(placeDaubs()).toEqual(daubs);
  });

  it("keeps the clearing, low tilts and a far-to-near draw order", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const d of daubs) {
      const r = Math.hypot(d.x, d.z);
      expect(r).toBeGreaterThanOrEqual(DAUB_FIELD.inner);
      expect(r).toBeLessThanOrEqual(DAUB_FIELD.outer);
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
      const tilt = (Math.abs(d.tilt) * 180) / Math.PI;
      expect(tilt).toBeGreaterThanOrEqual(8);
      expect(tilt).toBeLessThanOrEqual(18.4);
      expect(d.rank).toBeGreaterThanOrEqual(0);
      expect(d.rank).toBeLessThan(1);
    }
  });
});

describe("PAINTER_SUN", () => {
  it("is the unit direction of the companion sun's orbit", () => {
    expect(Math.hypot(...PAINTER_SUN)).toBeCloseTo(1, 3);
    const az = (Math.atan2(PAINTER_SUN[0], PAINTER_SUN[2]) * 180) / Math.PI;
    const el = (Math.asin(PAINTER_SUN[1]) * 180) / Math.PI;
    expect(az).toBeCloseTo(PAINTER_SUN_ORBIT.azimuthDeg, 1);
    expect(el).toBeCloseTo(PAINTER_SUN_ORBIT.elevationDeg, 1);
  });
});
