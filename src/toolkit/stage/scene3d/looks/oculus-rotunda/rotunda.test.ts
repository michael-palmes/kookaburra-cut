import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import {
  AZIMUTH_SWING,
  cappedMaxElevation,
  DISC_FLOOR_Y,
  discLowestY,
  drumBays,
  ELEVATION_SWING,
  rotundaSunAzimuth,
  rotundaSunElevation,
  writeRotundaBeam,
} from "./rotunda";
import { DOME_FRAGMENT, DRUM_FRAGMENT, FLOOR_FRAGMENT, OCULUS_FRAGMENT } from "./shaders";

const param = (p: (typeof presets)[number], key: string) =>
  p.params?.[key] ?? look.params[key].default;

describe("oculus-rotunda sun", () => {
  it("swings like a sundial: centred and lowest at the back, rising toward the sides", () => {
    expect(rotundaSunAzimuth(0, 90)).toBeCloseTo(0, 9);
    expect(rotundaSunElevation(0, 90, 52)).toBeCloseTo(52, 9);
    expect(rotundaSunAzimuth(45, 90)).toBeCloseTo(-AZIMUTH_SWING, 9);
    expect(rotundaSunElevation(45, 90, 52)).toBeCloseTo(52 - ELEVATION_SWING, 9);
    expect(rotundaSunAzimuth(180, 90)).toBeCloseTo(0, 9);
    expect(rotundaSunElevation(180, 90, 52)).toBeCloseTo(52, 9);
  });

  it("casts the beam down onto the back wall when centred", () => {
    const beam = new Vector3();
    writeRotundaBeam(beam, 0, 42);
    expect(beam.length()).toBeCloseTo(1, 9);
    expect(beam.x).toBeCloseTo(0, 9);
    expect(beam.y).toBeLessThan(0);
    expect(beam.z).toBeLessThan(0);
  });

  it("never sets the disc's edge below y +8, at any slider value", () => {
    for (const radius of [16, 22, 30]) {
      for (const disc of [1.5, 3, 5]) {
        for (const max of [35, 52, 58]) {
          const top = cappedMaxElevation(radius, disc, max);
          expect(top).toBeLessThanOrEqual(max);
          expect(discLowestY(radius, disc, top), `${radius} ${disc} ${max}`).toBeGreaterThanOrEqual(
            DISC_FLOOR_Y - 1e-6,
          );
        }
      }
    }
  });

  it("keeps the sketch's 32 to 52 degree path at the defaults", () => {
    expect(cappedMaxElevation(22, 3, 52)).toBeCloseTo(52, 1);
    for (const p of presets) {
      const top = cappedMaxElevation(
        param(p, "radius"),
        param(p, "discSize"),
        param(p, "maxElevation"),
      );
      for (let t = 0; t < 2 * param(p, "traverse"); t += 1) {
        const elevation = rotundaSunElevation(t, param(p, "traverse"), top);
        expect(
          discLowestY(param(p, "radius"), param(p, "discSize"), elevation),
          p.id,
        ).toBeGreaterThanOrEqual(DISC_FLOOR_Y - 1e-6);
      }
    }
  });
});

describe("oculus-rotunda look", () => {
  it("keeps an even bay count round the drum, 28 at the sketch radius", () => {
    expect(drumBays(22)).toBe(28);
    for (let r = 16; r <= 30; r += 0.5) expect(drumBays(r) % 2, `${r}`).toBe(0);
  });

  it("lights devices from the oculus side at the beam's mean elevation", () => {
    for (const p of presets) {
      const top = cappedMaxElevation(
        param(p, "radius"),
        param(p, "discSize"),
        param(p, "maxElevation"),
      );
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(0);
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(Math.round(top - ELEVATION_SWING / 2));
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
    }
  });

  it("adds coffer studs in dark presets only", () => {
    for (const p of presets) {
      if (p.mode === "light") expect(param(p, "studs"), p.id).toBe(0);
      else expect(param(p, "studs"), p.id).toBeGreaterThan(0);
    }
  });

  it("builds sound look materials", () => {
    for (const [part, fragmentShader] of [
      ["drum", DRUM_FRAGMENT],
      ["dome", DOME_FRAGMENT],
      ["floor", FLOOR_FRAGMENT],
      ["oculus", OCULUS_FRAGMENT],
    ]) {
      expect(
        lookMaterialProblem({ key: `oculus-rotunda/${part}`, fragmentShader }),
        part,
      ).toBeNull();
    }
  });
});
