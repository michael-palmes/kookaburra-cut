import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { skyDomeMaterial } from "../../kit/skyDome";
import { presets } from "./index";
import { LAND_FRAGMENT, LAND_VERTEX, MIST_FRAGMENT, MIST_VERTEX, SKY_FRAGMENT } from "./shaders";
import {
  MEZZO,
  MEZZO_GLOW,
  mezzotintCells,
  mezzotintCoverShift,
  mezzotintGlow,
  mezzotintKey,
} from "./tone";

describe("mezzotint sky", () => {
  it("passes the look material rules", () => {
    expect(
      lookMaterialProblem(
        skyDomeMaterial({ key: "mezzotint-sky/dome", fragmentShader: SKY_FRAGMENT }),
      ),
    ).toBeNull();
    for (const [part, vertexShader, fragmentShader] of [
      ["land", LAND_VERTEX, LAND_FRAGMENT],
      ["mist", MIST_VERTEX, MIST_FRAGMENT],
    ]) {
      expect(
        lookMaterialProblem({ key: `mezzotint-sky/${part}`, vertexShader, fragmentShader }),
        part,
      ).toBeNull();
    }
  });

  it("sways the glow on the Drift loop, low over -z, so the land catches light where the dome glows", () => {
    const a = mezzotintGlow(0, 240);
    expect(a.azimuth).toBe(0);
    expect(a.direction[0]).toBeCloseTo(0, 12);
    expect(a.direction[1]).toBe(MEZZO_GLOW.sinElevation);
    expect(a.direction[2]).toBeCloseTo(-Math.sqrt(1 - MEZZO_GLOW.sinElevation ** 2), 12);
    const b = mezzotintGlow(60, 240);
    expect(b.azimuth).toBeCloseTo(MEZZO_GLOW.sway, 12);
    expect(Math.hypot(...b.direction)).toBeCloseTo(1, 12);
    const c = mezzotintGlow(60 + 240 * 3, 240);
    expect(c.azimuth).toBeCloseTo(b.azimuth, 9);
    expect(c.breathe).toBeCloseTo(b.breathe, 9);
    for (let t = 0; t < 240; t += 7) {
      const { breathe } = mezzotintGlow(t, 240);
      expect(breathe).toBeGreaterThanOrEqual(1 - 2 * MEZZO_GLOW.breath - 1e-12);
      expect(breathe).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it("keys the plate from where the backing sits between the inks, clamped", () => {
    expect(mezzotintKey("#9f94b5", "#f7f4ef", "#cccad8")).toBeCloseTo(0.479, 3);
    expect(mezzotintKey("#171522", "#715f44", "#201d31")).toBeCloseTo(0.051, 3);
    expect(mezzotintKey("#171522", "#715f44", "#000000")).toBe(MEZZO.keyMin);
    expect(mezzotintKey("#171522", "#715f44", "#ffffff")).toBe(MEZZO.keyMax);
    expect(mezzotintKey("#808080", "#808080", "#808080")).toBe(MEZZO.keyMin);
  });

  it("prints light presets as a burnished dawn and dark presets as a rocked night", () => {
    for (const p of presets) {
      const k = mezzotintKey(p.colors[0], p.colors[1], p.backing);
      if (p.mode === "light") expect(k, p.id).toBeGreaterThan(0.3);
      else expect(k, p.id).toBeLessThan(0.2);
    }
  });

  it("maps Grain size to burr cells and Cloud cover to a threshold shift", () => {
    expect(mezzotintCells(4)).toBe(MEZZO.cellsAtGrain4);
    expect(mezzotintCells(8)).toBeCloseTo(MEZZO.cellsAtGrain4 / 2, 10);
    expect(mezzotintCells(2)).toBeGreaterThan(mezzotintCells(4));
    expect(mezzotintCoverShift(0.5)).toBe(0);
    expect(mezzotintCoverShift(1)).toBeLessThan(0);
    expect(mezzotintCoverShift(0)).toBeCloseTo(MEZZO.coverSlide / 2, 10);
  });
});
