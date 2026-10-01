import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { presets } from "./index";
import {
  isDarkStock,
  polarGrid,
  RISO_GRID,
  RISO_SUN_AZIMUTH,
  RISO_SUN_PERIOD,
  risoClearingRings,
  risoPhases,
  risoSun,
} from "./model";
import { RISO_CLEARING_FRAGMENT, RISO_FRAGMENT, RISO_VERTEX } from "./shaders";

const azimuthDeg = (v: Vector3) => ((Math.atan2(v.x, v.z) * 180) / Math.PI + 360) % 360;

describe("riso dunes", () => {
  it("passes the look material rules", () => {
    for (const fragmentShader of [RISO_FRAGMENT, RISO_CLEARING_FRAGMENT]) {
      expect(
        lookMaterialProblem({ key: "riso-dunes/floor", vertexShader: RISO_VERTEX, fragmentShader }),
      ).toBeNull();
    }
  });

  it("hands the clearing material only rings no dune or slipped plate reaches", () => {
    const { rings, radius, power } = RISO_GRID;
    for (const clear of [5, 8, 12.5, 16]) {
      for (const mis of [0, 0.1, 0.3]) {
        const k = risoClearingRings(clear, mis);
        expect(k, `${clear} ${mis}`).toBeGreaterThan(0);
        expect(radius * (k / rings) ** power, `${clear} ${mis}`).toBeLessThanOrEqual(
          clear - 0.5 - mis / 2,
        );
        expect(radius * ((k + 1) / rings) ** power).toBeGreaterThan(clear - 0.5 - mis / 2 - 0.1);
      }
    }
    expect(risoClearingRings(0.5, 0.3)).toBe(0);
  });

  it("reads every preset's stock from its colours", () => {
    for (const p of presets) {
      expect(isDarkStock(p.colors[0], p.colors[2]), p.id).toBe(p.mode === "dark");
    }
  });

  it("builds an upward-facing polar floor bunched toward the centre", () => {
    const g = polarGrid(4, 8, 100, 1.5);
    const pos = g.getAttribute("position");
    expect(pos.count).toBe(5 * 9);
    expect(g.getIndex()?.count).toBe(4 * 8 * 6);
    expect(Math.hypot(pos.getX(4 * 9), pos.getZ(4 * 9))).toBeCloseTo(100, 4);
    expect(Math.hypot(pos.getX(9), pos.getZ(9))).toBeCloseTo(100 * 0.25 ** 1.5, 4);
    const index = g.getIndex();
    const p = (i: number) =>
      new Vector3(pos.getX(index?.getX(i) ?? 0), 0, pos.getZ(index?.getX(i) ?? 0));
    const ring1 = 8 * 6;
    const n = p(ring1 + 1)
      .sub(p(ring1))
      .cross(p(ring1 + 2).sub(p(ring1)));
    expect(n.y).toBeGreaterThan(0);
  });

  it("wraps each band's phase exactly and holds still with no drift", () => {
    const a = risoPhases(3, 0.05, 17);
    const b = risoPhases(3 + 17 / 0.05, 0.05, 17);
    expect(b.big).toBeCloseTo(a.big, 9);
    for (const v of Object.values(risoPhases(1e7 + 0.3, 0.05, 17))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(risoPhases(42, 0, 17)).toEqual({ big: 0, small: 0, ripple: 0 });
    const d = risoPhases(1, 0.05, 17);
    expect(d.small * 6).toBeGreaterThan(d.big * 17);
  });

  it("swings the sun either side of the stock's azimuth over 48 s", () => {
    const v = new Vector3();
    risoSun(0, 20, false, v);
    expect(v.length()).toBeCloseTo(1, 9);
    expect((Math.asin(v.y) * 180) / Math.PI).toBeCloseTo(22, 9);
    expect(azimuthDeg(v)).toBeCloseTo(RISO_SUN_AZIMUTH.light, 6);
    expect(azimuthDeg(risoSun(RISO_SUN_PERIOD / 4, 20, false, v))).toBeCloseTo(246, 6);
    expect(azimuthDeg(risoSun((3 * RISO_SUN_PERIOD) / 4, 20, true, v))).toBeCloseTo(26, 6);
    expect(azimuthDeg(risoSun(RISO_SUN_PERIOD * 1000, 20, true, v))).toBeCloseTo(46, 6);
  });

  it("aims each companion sun along its stock's painted sun", () => {
    for (const p of presets) {
      const az = ((p.lighting?.sun?.azimuthDeg ?? Number.NaN) + 360) % 360;
      expect(az, p.id).toBe(RISO_SUN_AZIMUTH[p.mode]);
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(22);
    }
  });
});
