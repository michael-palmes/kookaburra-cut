import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { hillsInversion } from "./EngravedHills";
import {
  buildHills,
  HILL_RANGES,
  HILLS_COLUMNS,
  HILLS_FLOOR_Y,
  HILLS_ROWS,
  HILLS_SUN,
  hillsClearance,
  hillsData,
} from "./hills";
import { presets } from "./index";

const data = hillsData();

describe("engraved hills terrain", () => {
  it("builds the same terrain every time (seeded, export contract)", () => {
    const again = buildHills();
    expect(again.positions).toEqual(data.positions);
    expect(again.hill).toEqual(data.hill);
    expect(again.crests).toEqual(data.crests);
  });

  it("lays out a closed polar grid", () => {
    expect(data.positions.length).toBe((HILLS_ROWS + 1) * HILLS_COLUMNS * 3);
    expect(data.index.length).toBe(HILLS_ROWS * HILLS_COLUMNS * 6);
    expect(data.index.reduce((m, i) => Math.max(m, i), 0)).toBe(
      (HILLS_ROWS + 1) * HILLS_COLUMNS - 1,
    );
  });

  it("stands down to the floor inside the content footprint", () => {
    for (let v = 0; v < data.positions.length / 3; v++) {
      const [x, y, z] = data.positions.subarray(v * 3, v * 3 + 3);
      if (hillsClearance(x, z) === 0) expect(y).toBeCloseTo(HILLS_FLOOR_Y, 5);
    }
  });

  it("keeps the hill attributes in 0..1", () => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const a of data.hill) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("closes every crest loop seamlessly and stacks the ranges higher outward", () => {
    let prevPeak = Number.NEGATIVE_INFINITY;
    for (const [k, crest] of data.crests.entries()) {
      expect(crest.length).toBe(HILLS_COLUMNS * 4);
      const step = (j: number) => {
        const a = crest.subarray(j * 4, j * 4 + 3);
        const b = crest.subarray(((j + 1) % HILLS_COLUMNS) * 4, ((j + 1) % HILLS_COLUMNS) * 4 + 3);
        return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      };
      const typical = (HILL_RANGES[k].radius * 2 * Math.PI) / HILLS_COLUMNS;
      expect(step(HILLS_COLUMNS - 1)).toBeLessThan(typical * 3);
      let peak = Number.NEGATIVE_INFINITY;
      for (let j = 0; j < HILLS_COLUMNS; j++) peak = Math.max(peak, crest[j * 4 + 1]);
      expect(peak).toBeGreaterThan(prevPeak);
      prevPeak = peak;
    }
  });
});

describe("engraved hills printing", () => {
  it("prints black line on light paper and white line on dark paper", () => {
    expect(hillsInversion(0.32, 0.88)).toBe(0);
    expect(hillsInversion(0.11, 0.005)).toBe(1);
    expect(hillsInversion(0.2, 0.2)).toBeCloseTo(0.5, 5);
  });
});

describe("engraved hills presets", () => {
  it("carries a companion key from the engraving sun's mean bearing on every preset", () => {
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      if (!p.lighting) continue;
      expect(companionLightingProblem(p.lighting), p.id).toBeNull();
      expect(p.lighting.sun?.azimuthDeg, p.id).toBe(HILLS_SUN.azimuthDeg);
      expect(p.lighting.sun?.elevationDeg, p.id).toBe(HILLS_SUN.elevationDeg);
    }
  });
});
