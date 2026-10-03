import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import {
  LOUVRE,
  louvrePhase,
  louvrePitch,
  louvreRowLag,
  louvreRowSize,
  louvreSlats,
  louvreSun,
  louvreTail,
  louvreTurn,
} from "./louvre";
import { LOUVRE_FRAGMENT, RAIL_VERTEX, SLAT_VERTEX } from "./shaders";

const TAU = Math.PI * 2;

describe("louvre ring layout", () => {
  it("rings each row with evenly spaced anchors on the radius, stacked from the floor", () => {
    const slats = louvreSlats(160, 3, 13.5, 8);
    expect(slats).toHaveLength(480);
    const { pitch } = louvreRowSize(8, 3);
    for (const [k, s] of slats.entries()) {
      expect(Math.hypot(s.x, s.z)).toBeCloseTo(13.5, 9);
      expect(s.y).toBeCloseTo(LOUVRE.bottom + Math.floor(k / 160) * pitch, 9);
    }
    expect(Math.hypot(slats[1].x - slats[0].x, slats[1].z - slats[0].z)).toBeCloseTo(
      2 * 13.5 * Math.sin(Math.PI / 160),
      9,
    );
  });

  it("caps the layout at the mounted capacity and the sliders at the caps", () => {
    expect(louvreSlats(9999, 99, 13.5, 8)).toHaveLength(LOUVRE.maxSlats * LOUVRE.maxRows);
    expect(look.params.count.max).toBe(LOUVRE.maxSlats);
    expect(look.params.rows.max).toBe(LOUVRE.maxRows);
  });

  it("leaves at least a quarter unit between default slats and a gap between stacked rows", () => {
    const pitch = louvrePitch(160, 13.5);
    expect(pitch * (1 - LOUVRE.fill)).toBeGreaterThanOrEqual(0.25);
    const one = louvreRowSize(8, 1);
    expect(one.slat).toBe(8);
    const four = louvreRowSize(8, 4);
    expect(four.pitch - four.slat).toBeCloseTo(LOUVRE.rowGap, 9);
  });
});

describe("louvre ring motion", () => {
  it("makes one full turn across the front, so every slat ends where it began", () => {
    const front = 0.3;
    expect(louvreTurn(0, front)).toBe(0);
    expect(louvreTurn(front, front)).toBeCloseTo(TAU, 12);
    expect(louvreTurn(front * (1 + LOUVRE.tail), front)).toBeCloseTo(TAU, 12);
    expect(louvreTurn(0.99, front)).toBeCloseTo(TAU, 12);
    for (const wide of [0.45, 0.6]) {
      expect(wide + louvreTail(wide)).toBeLessThanOrEqual(1);
      expect(louvreTurn(1, wide)).toBeCloseTo(TAU, 12);
    }
  });

  it("is smooth through the turn and the settle (no velocity jump)", () => {
    for (const front of [0.1, 0.3, 0.6]) {
      const h = 1e-7;
      for (const u of [front, front + louvreTail(front)]) {
        const before = (louvreTurn(u, front) - louvreTurn(u - h, front)) / h;
        const after = (louvreTurn(u + h, front) - louvreTurn(u, front)) / h;
        expect(Math.abs(before - after), `${front} ${u}`).toBeLessThan(0.01);
      }
    }
  });

  it("settles with a gentle sway behind the front", () => {
    let peak = 0;
    for (let u = 0.3; u <= 0.3 * (1 + LOUVRE.tail); u += 0.001) {
      peak = Math.max(peak, Math.abs(louvreTurn(u, 0.3) - TAU));
    }
    expect(peak).toBeGreaterThan(0.15);
    expect(peak).toBeLessThan(0.25);
  });

  it("loops the sweep exactly and staggers stacked rows by half a front", () => {
    for (const t of [0, 7.3, 47.9, 1000.25]) {
      expect(louvrePhase(t + 48 * 3, 48)).toBeCloseTo(louvrePhase(t, 48), 9);
    }
    expect(louvreRowLag(0.3, 4) * 3).toBeCloseTo(LOUVRE.stagger * 0.3, 12);
  });
});

describe("louvre ring presets", () => {
  it("carry a cheap companion key at the virtual light's seat", () => {
    const [x, y, z] = louvreSun();
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(LOUVRE.sunAzimuthDeg);
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(LOUVRE.sunElevationDeg);
    }
  });

  it("build sound look materials", () => {
    for (const [part, vertexShader] of [
      ["slats", SLAT_VERTEX],
      ["rail", RAIL_VERTEX],
    ]) {
      expect(
        lookMaterialProblem({
          key: `louvre-ring/${part}`,
          vertexShader,
          fragmentShader: LOUVRE_FRAGMENT,
        }),
        part,
      ).toBeNull();
    }
  });
});
