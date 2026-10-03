import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { skyDomeMaterial } from "../../kit/skyDome";
import { look, presets } from "./index";
import {
  COAST_FRAGMENT,
  COAST_VERTEX,
  LAMP_FRAGMENT,
  LAMP_VERTEX,
  SEA_FRAGMENT,
  SKY_FRAGMENT,
} from "./shaders";
import { LONG_EXPOSURE, NAMED_STARS, namedStarPolar, poleBasis, skyTurn } from "./sky";

const DEG = Math.PI / 180;
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("long-exposure sky", () => {
  it("puts the default pole off stage to the upper right, above the frame top", () => {
    const { pole } = poleBasis(55, 30);
    expect(pole[0]).toBeGreaterThan(0);
    expect(pole[2]).toBeLessThan(0);
    expect(Math.asin(pole[1]) / DEG).toBeCloseTo(30, 6);
    expect(look.params.poleHeight.min).toBeGreaterThan(22.5);
  });

  it("builds an orthonormal pole frame with v toward world up", () => {
    for (const [az, el] of [
      [55, 30],
      [-90, 24],
      [0, 45],
    ]) {
      const { pole, u, v } = poleBasis(az, el);
      for (const axis of [pole, u, v]) expect(Math.hypot(...axis)).toBeCloseTo(1, 9);
      expect(dot(pole, u)).toBeCloseTo(0, 9);
      expect(dot(pole, v)).toBeCloseTo(0, 9);
      expect(dot(u, v)).toBeCloseTo(0, 9);
      expect(v[1]).toBeGreaterThan(0);
    }
  });

  it("turns once every three minutes at Sky turn 1 and loops exactly", () => {
    expect(skyTurn(0, 1, 0)).toBe(0);
    expect(skyTurn(45, 1, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(skyTurn(LONG_EXPOSURE.period, 1, 0)).toBeCloseTo(0, 12);
    expect(skyTurn(1, 1, 0) / DEG).toBeCloseTo(2, 9);
    for (const t of [3.5, 61, 1234.25]) {
      expect(skyTurn(t + LONG_EXPOSURE.period, 1, 6)).toBeCloseTo(skyTurn(t, 1, 6), 9);
    }
    expect(skyTurn(10, 0, 12)).toBeCloseTo(Math.PI, 12);
    expect(skyTurn(-30, 1, 0)).toBeGreaterThanOrEqual(0);
  });

  it("places the Cross and the Pointers about 30 degrees from the pole, Pointers following", () => {
    const stars = namedStarPolar();
    expect(stars).toHaveLength(NAMED_STARS.length);
    for (const [rho, phase, w] of stars) {
      expect(rho / DEG).toBeGreaterThan(26);
      expect(rho / DEG).toBeLessThan(34);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(Math.PI * 2);
      expect(w).toBeGreaterThan(0);
    }
    const acrux = stars[0];
    const alphaCen = stars[5];
    expect(alphaCen[1]).toBeGreaterThan(acrux[1]);
  });

  it("builds sound look materials and covers every preset param", () => {
    for (const spec of [
      skyDomeMaterial({ key: "long-exposure/sky", fragmentShader: SKY_FRAGMENT }),
      { key: "long-exposure/sea", fragmentShader: SEA_FRAGMENT },
      { key: "long-exposure/coast", vertexShader: COAST_VERTEX, fragmentShader: COAST_FRAGMENT },
      { key: "long-exposure/lamp", vertexShader: LAMP_VERTEX, fragmentShader: LAMP_FRAGMENT },
    ]) {
      expect(lookMaterialProblem(spec), spec.key).toBeNull();
    }
    for (const p of presets) {
      expect(Object.keys(p.params ?? {}).sort(), p.id).toEqual(Object.keys(look.params).sort());
      expect(Math.abs(p.params?.poleAzimuth ?? 0), p.id).toBeGreaterThanOrEqual(25);
    }
  });
});
