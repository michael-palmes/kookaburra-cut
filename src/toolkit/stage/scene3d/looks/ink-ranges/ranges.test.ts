import { describe, expect, it } from "vitest";
import { companionLightingProblem, ringBandDrawOrder } from "../../kit";
import { presets } from "./index";
import {
  INK_BANDS,
  INK_FLOOR,
  INK_FLOOR_Y,
  INK_PERIOD,
  INK_RIDGES,
  inkDiscDirection,
  inkRidgeHeight,
  inkVisibleRidges,
} from "./ranges";

describe("ink ranges layout", () => {
  it("draws sky, floor, then ridges far to near", () => {
    expect(ringBandDrawOrder(INK_BANDS, INK_FLOOR)).toEqual([0, INK_BANDS.length, 5, 4, 3, 2, 1]);
  });

  it("keeps the review's slide rates: near 0.8, far 0.2 degrees/s, counter-rotating", () => {
    const rate = (turns: number) => (turns * 360) / INK_PERIOD;
    expect(rate(INK_RIDGES[0].turns)).toBeCloseTo(0.8, 9);
    expect(rate(Math.abs(INK_RIDGES[3].turns))).toBeCloseTo(0.2, 9);
    for (let k = 1; k < INK_RIDGES.length; k++) {
      expect(Math.sign(INK_RIDGES[k].turns)).toBe(-Math.sign(INK_RIDGES[k - 1].turns));
      expect(Number.isInteger(INK_RIDGES[k].turns)).toBe(true);
    }
  });

  it("shows the requested count of ranges, near to far, always keeping a far range", () => {
    for (let n = 2; n <= 5; n++) {
      const set = inkVisibleRidges(n);
      expect(set).toHaveLength(n);
      expect([...set].sort()).toEqual(set);
      expect(set.at(-1)).toBeGreaterThanOrEqual(3);
    }
    expect(inkVisibleRidges(1)).toEqual(inkVisibleRidges(2));
    expect(inkVisibleRidges(9)).toEqual(inkVisibleRidges(5));
    expect(inkVisibleRidges(3.6)).toEqual(inkVisibleRidges(4));
  });

  it("builds every ridge tall enough for the highest horizon, clear of the content volume", () => {
    for (const [k, r] of INK_RIDGES.entries()) {
      const band = INK_BANDS[k + 1];
      expect(band.top).toBeGreaterThan(inkRidgeHeight(r.hi, 1.4));
      expect(band.bottom).toBe(INK_FLOOR_Y);
      expect(r.radius).toBeGreaterThanOrEqual(15);
    }
    expect(INK_FLOOR_Y).toBeLessThan(-2);
    expect(inkRidgeHeight(3, 1)).toBe(3);
  });

  it("places the disc upper right behind the stage, above the far crests", () => {
    const [x, y, z] = inkDiscDirection(1);
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
    expect(x).toBeGreaterThan(0);
    expect(z).toBeLessThan(0);
    const far = INK_RIDGES[3];
    expect(Math.asin(y)).toBeGreaterThan(Math.atan(inkRidgeHeight(far.hi, 1) / far.radius));
  });

  it("gives a matching rig exactly to the presets that show a disc", () => {
    for (const p of presets) {
      expect(Boolean(p.lighting), p.id).toBe((p.params?.discSize ?? 1) > 0);
      if (p.lighting) expect(companionLightingProblem(p.lighting), p.id).toBeNull();
    }
  });
});
