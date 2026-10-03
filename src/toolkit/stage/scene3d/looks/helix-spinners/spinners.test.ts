import { describe, expect, it } from "vitest";
import {
  BAR_GAP,
  barAngle,
  barCount,
  HELIX_B_SCALE,
  layoutSpinners,
  MAX_SPINNERS,
  MIN_SPINNERS,
  SPINNER_LOOP,
  type SpinnerParams,
  spinnerBarAttributes,
} from "./spinners";

const DEFAULTS: SpinnerParams = { count: 26, length: 1, twist: 14, turn: 24, clearance: 12 };
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

describe("layoutSpinners", () => {
  const grove = layoutSpinners(DEFAULTS);

  it("is deterministic and clamps the count", () => {
    expect(layoutSpinners(DEFAULTS)).toEqual(grove);
    expect(grove).toHaveLength(26);
    expect(layoutSpinners({ ...DEFAULTS, count: 2 })).toHaveLength(MIN_SPINNERS);
    expect(layoutSpinners({ ...DEFAULTS, count: 99 })).toHaveLength(MAX_SPINNERS);
  });

  it("hangs every tip at least the clearance above the default eye line, the centre one higher", () => {
    for (const clearance of [9, 12, 18]) {
      const g = layoutSpinners({ ...DEFAULTS, clearance });
      const elev = g.map((s) => Math.atan2(s.bottom, Math.hypot(s.x, s.z - 5)) / DEG);
      for (const e of elev) expect(e).toBeGreaterThanOrEqual(clearance);
      expect(elev[0]).toBeGreaterThanOrEqual(clearance + 6);
    }
    expect(grove[0].x).toBeCloseTo(0.4, 9);
    expect(grove[0].z).toBe(-24);
  });

  it("keeps the band between r 13 and 42 and spreads it round the stage", () => {
    for (const s of grove.slice(1)) {
      expect(s.r).toBeGreaterThanOrEqual(13);
      expect(s.r).toBeLessThanOrEqual(42);
    }
    const quadrants = new Set(grove.map((s) => `${Math.sign(s.x)}${Math.sign(s.z)}`));
    expect(quadrants.size).toBe(4);
  });

  it("turns helix A in whole turns near the requested seconds a turn", () => {
    for (const s of grove) {
      expect(Number.isInteger(s.turnsA)).toBe(true);
      const seconds = SPINNER_LOOP / s.turnsA;
      expect(seconds).toBeGreaterThanOrEqual(18);
      expect(seconds).toBeLessThanOrEqual(31);
    }
  });

  it("builds about 1,700 bars at the defaults", () => {
    const n = barCount(grove);
    expect(n).toBeGreaterThan(1400);
    expect(n).toBeLessThan(2000);
  });
});

describe("spinnerBarAttributes", () => {
  const grove = layoutSpinners(DEFAULTS);
  const { sp, bar } = spinnerBarAttributes(grove);

  it("writes one vec4 pair per bar, spinner-major then helix", () => {
    expect(sp).toHaveLength(barCount(grove) * 4);
    expect(bar).toHaveLength(barCount(grove) * 4);
    const s = grove[0];
    expect(bar[0]).toBeCloseTo(s.bottom, 5);
    expect(bar[4]).toBeCloseTo(s.bottom + BAR_GAP, 5);
    const b0 = s.bars * 4;
    expect(bar[b0]).toBeCloseTo(s.bottom + 0.5 * BAR_GAP, 5);
    expect(bar[b0 + 2]).toBe(1);
    expect(sp[b0 + 2]).toBeCloseTo(s.rad * HELIX_B_SCALE, 5);
  });
});

describe("barAngle", () => {
  const s = layoutSpinners(DEFAULTS)[3];

  it("loops exactly: whole turns over the loop, helix B one more the other way", () => {
    const a0 = barAngle(s, 0, 5, 0);
    const a1 = barAngle(s, 0, 5, TAU);
    const b0 = barAngle(s, 1, 5, 0);
    const b1 = barAngle(s, 1, 5, TAU);
    expect((a1 - a0) / TAU).toBeCloseTo(s.turnsA, 9);
    expect((b1 - b0) / TAU).toBeCloseTo(-(s.turnsA + 1), 9);
  });

  it("twists each bar against the one above, opposite ways per helix", () => {
    expect(barAngle(s, 0, 1, 1) - barAngle(s, 0, 0, 1)).toBeCloseTo(s.twist, 9);
    expect(barAngle(s, 1, 1, 1) - barAngle(s, 1, 0, 1)).toBeCloseTo(-s.twist, 9);
  });
});
