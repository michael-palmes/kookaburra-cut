import { describe, expect, it } from "vitest";
import { glslFloat } from "../../kit";
import { presets } from "./index";
import {
  polarGridGeometry,
  TIDE,
  TIDE_GLSL_SWELL,
  TIDE_SWELLS,
  tideBands,
  tideEnvelope,
  tideWave,
} from "./tide";

describe("seigaiha tide motion", () => {
  it("closes every swell on the 60 s loop", () => {
    for (const s of TIDE_SWELLS) expect(Number.isInteger(s.cycles)).toBe(true);
    for (const [x, z, t] of [
      [3, -4, 1.25],
      [-20, 11, 37.5],
    ]) {
      const a = tideWave(x, z, t);
      const b = tideWave(x, z, t + TIDE.loop);
      expect(b.h).toBeCloseTo(a.h, 9);
      expect(b.quad).toBeCloseTo(a.quad, 9);
    }
  });

  it("moves near fans as much as far ones: the raw wave carries the motion, not the envelope", () => {
    const swing = (x: number, z: number) => {
      const hs = Array.from({ length: 21 }, (_, i) => tideWave(x, z, i * 0.25).h);
      return Math.max(...hs) - Math.min(...hs);
    };
    expect(tideEnvelope(1, 0.45, 3)).toBe(0);
    expect(swing(1, 0)).toBeGreaterThan(0.3);
    expect(swing(30, 10)).toBeGreaterThan(0.3);
  });

  it("calms the swell in the clearing and beyond the far fade, full past radius 20", () => {
    expect(tideEnvelope(1.9, 0.45, 3)).toBe(0);
    expect(tideEnvelope(25, 0.45, 3)).toBeCloseTo(0.45, 10);
    expect(tideEnvelope(120, 0.45, 3)).toBe(0);
    expect(tideEnvelope(10, 0.45, 3)).toBeLessThan(0.45 * 0.4);
  });

  it("emits the same swell constants to GLSL", () => {
    for (const s of TIDE_SWELLS) {
      expect(TIDE_GLSL_SWELL).toContain(glslFloat((Math.PI * 2) / s.wavelength));
      expect(TIDE_GLSL_SWELL).toContain(glslFloat((Math.PI * 2 * s.cycles) / TIDE.loop));
    }
  });

  it("lifts the printed sky bands with a portrait headline", () => {
    expect(tideBands(16 / 9)).toEqual([11, 16.5, 23]);
    expect(tideBands(9 / 16)).toEqual([17.5, 21.5, 27]);
    const square = tideBands(1);
    expect(square[0]).toBeGreaterThan(11);
    expect(square[0]).toBeLessThan(17.5);
  });
});

describe("seigaiha tide floor and presets", () => {
  it("builds the polar grid with its centre fan and quads, reaching the floor radius", () => {
    const g = polarGridGeometry(130, 120, 240, 1.6);
    const pos = g.getAttribute("position");
    expect(pos.count).toBe(1 + 120 * 240);
    expect(g.getIndex()?.count).toBe(240 * 3 + 119 * 240 * 6);
    let max = 0;
    for (let i = 0; i < pos.count; i++) {
      max = Math.max(max, Math.hypot(pos.getX(i), pos.getZ(i)));
      expect(pos.getY(i)).toBe(0);
    }
    expect(max).toBeCloseTo(130, 4);
    g.dispose();
  });

  it("gives each preset its own tuning and whole fan and ring counts", () => {
    const tunings = new Set(presets.map((p) => JSON.stringify(p.params)));
    expect(tunings.size).toBeGreaterThanOrEqual(8);
    for (const p of presets) {
      expect(Number.isInteger(p.params?.fans), p.id).toBe(true);
      expect(Number.isInteger(p.params?.rings), p.id).toBe(true);
    }
  });
});
