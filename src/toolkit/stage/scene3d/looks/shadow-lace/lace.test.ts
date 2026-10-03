import { describe, expect, it } from "vitest";
import { FPS } from "../../../../../engine/format";
import { companionLightingProblem } from "../../kit/companion";
import { goboSunDirection } from "../../kit/gobo";
import { presets } from "./index";
import {
  BOUGH_GAP,
  DENSITY_MAX,
  isQuiet,
  lacePlantCount,
  laceRing,
  laceStepSeconds,
  lampDirection,
  lampOrbitAzimuth,
  PLANTS,
  placeLace,
  SWAY_LOOP,
  wrapAngle,
} from "./lace";

describe("placeLace", () => {
  const plants = placeLace();

  it("fills every ring's pool once, deterministically", () => {
    for (const ring of ["near", "far", "boughs"] as const) {
      expect(plants.filter((p) => p.ring === ring)).toHaveLength(
        Math.round(PLANTS[ring] * DENSITY_MAX),
      );
    }
    expect(placeLace()).toEqual(plants);
  });

  it("keeps the quiet sector low and the boughs clear of it", () => {
    for (const p of plants) {
      const top = Math.max(
        ...p.strands.flatMap((s) => Array.from(s.points.filter((_, i) => i % 4 === 1))),
      );
      if (p.ring === "near" && isQuiet(p.th)) expect(top).toBeLessThan(1.6);
      if (p.ring === "far" && isQuiet(p.th)) expect(p.height).toBeLessThanOrEqual(6 * 0.6);
      if (p.ring === "boughs") expect(Math.abs(wrapAngle(p.th))).toBeGreaterThanOrEqual(BOUGH_GAP);
    }
  });

  it("sways in whole cycles per loop, weights in 0..1", () => {
    for (const p of plants) {
      expect(Number.isInteger(p.freq)).toBe(true);
      for (const s of p.strands) {
        expect(Math.floor((s.data[3] ?? 0) / 8)).toBe(p.freq);
        expect((s.data[3] ?? 0) - p.freq * 8).toBeLessThan(2 * Math.PI);
        for (let i = 3; i < s.points.length; i += 4) {
          expect(s.points[i]).toBeGreaterThanOrEqual(0);
          expect(s.points[i]).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("thins by whole plants in pool order", () => {
    const { strands, plantEnds } = laceRing(plants, "near");
    expect(plantEnds.at(-1)).toBe(strands.length);
    expect(lacePlantCount("near", 1)).toBe(PLANTS.near);
    expect(lacePlantCount("near", DENSITY_MAX)).toBe(plantEnds.length);
    expect(lacePlantCount("boughs", 0.3)).toBe(2);
  });
});

describe("laceStepSeconds", () => {
  it("holds between steps and loops", () => {
    const frame = (n: number) => (n * 1000) / FPS;
    expect(laceStepSeconds(frame(0), 10, 1)).toBe(0);
    expect(laceStepSeconds(frame(5), 10, 1)).toBe(0);
    expect(laceStepSeconds(frame(6), 10, 1)).toBeCloseTo(0.1, 9);
    expect(laceStepSeconds(frame(FPS * SWAY_LOOP), 10, 1)).toBe(0);
    expect(laceStepSeconds(frame(6), 10, 2)).toBeCloseTo(0.2, 9);
  });
});

describe("lamp", () => {
  it("puts the companion sun where the lamp disc sits", () => {
    for (const az of [-150, -40, 0, 36, 120]) {
      const disc = lampDirection(az);
      const sun = goboSunDirection(lampOrbitAzimuth(az), 5.7);
      for (let i = 0; i < 3; i++) expect(sun[i]).toBeCloseTo(disc[i], 6);
    }
  });
});

describe("companion lighting", () => {
  it("is a cheap whole rig with its sun at each preset's lamp", () => {
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      if (!p.lighting) continue;
      expect(companionLightingProblem(p.lighting), p.id).toBeNull();
      expect(p.lighting.sun?.azimuthDeg).toBe(
        Math.round(lampOrbitAzimuth(p.params?.lampAzimuth ?? 0)),
      );
    }
  });
});
