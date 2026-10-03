import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import { FLOOR_FRAGMENT, PIECE_FRAGMENT, PIECE_VERTEX } from "./shaders";
import {
  TERRACE,
  type TerraceFoldParams,
  terraceFold,
  terraceGeometry,
  terraceStreet,
  terraceUnitTheta,
  terraceWavePhase,
  terraceWidthScale,
} from "./terrace";

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * lin((n >> 16) / 255) +
    0.7152 * lin(((n >> 8) & 255) / 255) +
    0.0722 * lin((n & 255) / 255)
  );
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const defaults = Object.fromEntries(
  Object.entries(look.params).map(([k, p]) => [k, p.default]),
) as unknown as TerraceFoldParams;

/** The fold the vertex stage applies: s = S - A sin b, z = A cos b. */
const fold = (S: number, A: number, b: number) => [S - A * Math.sin(b), A * Math.cos(b)];

describe("pop-up-terrace", () => {
  it("draws the approved sketch's street from its seeded stream", () => {
    const a = terraceStreet();
    expect(terraceStreet()).toEqual(a);
    expect(a.houses).toHaveLength(TERRACE.variants * TERRACE.slots);
    expect(a.unitVariant).toHaveLength(TERRACE.maxUnits);
    const half = TERRACE.width / 2;
    for (const h of a.houses) {
      if (h.type === 0) continue;
      expect(h.x0).toBeGreaterThanOrEqual(-half + 0.3);
      expect(h.x1).toBeLessThanOrEqual(half - 0.3);
      expect(h.depth).toBeGreaterThan(h.inset);
    }
    for (let v = 0; v < TERRACE.variants; v++) {
      const row = a.houses.slice(v * TERRACE.slots, (v + 1) * TERRACE.slots);
      expect(row.filter((h) => h.type > 0).length, `variant ${v}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("folds exactly: facades stay parallel to the page and roofs parallel to the floor", () => {
    for (const b of [0, 0.4, 1.1, Math.PI / 2]) {
      const [s0, z0] = fold(1.2, 0.9, b);
      const [s1, z1] = fold(0.4, 0.9, b);
      expect(z1).toBeCloseTo(z0, 9);
      expect(s0 - s1).toBeCloseTo(0.8, 9);
      const [p0, q0] = fold(1.2, 0, b);
      const [p1, q1] = fold(1.2, 0.9, b);
      expect(Math.atan2(p0 - p1, q1 - q0)).toBeCloseTo(b, 9);
    }
    const flat = fold(0, TERRACE.page, Math.PI / 2);
    expect(flat[0]).toBeCloseTo(-TERRACE.page, 9);
    expect(flat[1]).toBeCloseTo(0, 9);
  });

  it("builds one page and every house's pieces per unit", () => {
    const { houses, unitVariant } = terraceStreet();
    const g = terraceGeometry(houses, unitVariant);
    const quadsPer = (v: number) =>
      1 +
      houses
        .slice(v * TERRACE.slots, (v + 1) * TERRACE.slots)
        .reduce((n, h) => n + (h.type === 0 ? 0 : h.type === 1 ? 4 : 2), 0);
    const quads = unitVariant.reduce((n, v) => n + quadsPer(v), 0);
    expect(g.position).toHaveLength(quads * 12);
    expect(g.index).toHaveLength(quads * 6);
  });

  it("moves within seconds and loops exactly per wave period", () => {
    const p = defaults;
    const th = terraceUnitTheta(4, 12);
    expect(terraceWavePhase(7, 80)).toBeCloseTo(terraceWavePhase(87, 80), 9);
    let moved = 0;
    for (let t = 0; t < 80; t += 4) {
      const a = terraceFold(th, terraceWavePhase(t, 80), p);
      const b = terraceFold(th, terraceWavePhase(t + 4, 80), p);
      moved = Math.max(moved, Math.abs(a - b));
    }
    expect((moved * 180) / Math.PI).toBeGreaterThan(12);
  });

  it("fits narrower cards as units are added", () => {
    expect(terraceWidthScale(12.5, 12)).toBe(1);
    expect(terraceWidthScale(12.5, 20)).toBeLessThan(0.7);
    for (const units of [8, 12, 20]) {
      const arc = (2 * Math.PI * 12.5) / units;
      expect(TERRACE.width * terraceWidthScale(12.5, units)).toBeLessThan(arc);
    }
  });

  it("lights devices from each preset's own sun, with a readable light palette", () => {
    for (const p of presets) {
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(p.params?.sunAzimuth);
      expect(Number.isInteger(p.params?.units), p.id).toBe(true);
      expect(Number.isInteger(p.params?.crests), p.id).toBe(true);
      const [lit, , crease] = p.colors;
      expect(contrast(lit, p.mode === "light" ? crease : p.backing), p.id).toBeGreaterThanOrEqual(
        2.5,
      );
      if (p.mode === "light") expect(contrast(lit, p.backing), p.id).toBeGreaterThan(1.25);
    }
    expect(look.params.units.step).toBe(1);
  });

  it("builds sound look materials", () => {
    expect(
      lookMaterialProblem({
        key: "pop-up-terrace/pieces",
        vertexShader: PIECE_VERTEX,
        fragmentShader: PIECE_FRAGMENT,
      }),
    ).toBeNull();
    expect(
      lookMaterialProblem({ key: "pop-up-terrace/floor", fragmentShader: FLOOR_FRAGMENT }),
    ).toBeNull();
  });
});
