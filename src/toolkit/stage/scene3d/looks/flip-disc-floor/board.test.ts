import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import {
  discRadius,
  FLIP,
  FLIP_CAPACITY,
  flipBias,
  flipField,
  flipPhase,
  squareLattice,
} from "./board";
import { look, presets } from "./index";
import { BOARD_FRAGMENT, BOARD_VERTEX, DISC_FRAGMENT, DISC_VERTEX } from "./shaders";

const TAU = Math.PI * 2;
const field = { bias: 0.12, clear: 4, front: 1 };

describe("flip-disc-floor", () => {
  it("lays about 11k discs at the default pitch and reach, row by row", () => {
    const cells = squareLattice(look.params.pitch.default, look.params.reach.default);
    expect(cells.length).toBeGreaterThan(10_500);
    expect(cells.length).toBeLessThan(11_500);
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1];
      const b = cells[i];
      expect(b.z > a.z || (b.z === a.z && b.x > a.x), `cell ${i}`).toBe(true);
    }
    for (const c of cells) expect(Math.hypot(c.x, c.z)).toBeLessThanOrEqual(26);
  });

  it("sizes the instance capacity for the densest sliders", () => {
    expect(FLIP_CAPACITY).toBe(squareLattice(look.params.pitch.min, look.params.reach.max).length);
    for (const p of presets) {
      const n = squareLattice(p.params?.pitch ?? 0, p.params?.reach ?? 0).length;
      expect(n, p.id).toBeLessThanOrEqual(FLIP_CAPACITY);
    }
  });

  it("keeps disc coverage per cell at any pitch", () => {
    for (const pitch of [0.3, 0.44, 0.8]) {
      expect((Math.PI * discRadius(pitch) ** 2) / pitch ** 2).toBeCloseTo(0.529, 2);
    }
  });

  it("closes the weather loop exactly at every loop length, on both boards", () => {
    for (const period of [
      look.params.period.min,
      look.params.period.default,
      look.params.period.max,
    ]) {
      for (const t of [0, 7.5, 151.25]) {
        const a = flipPhase(t, period);
        const b = flipPhase(t + period * 2, period);
        for (const side of [1, -1] as const) {
          for (const [x, z] of [
            [6, -3],
            [-9.5, 12],
          ]) {
            expect(flipField(x, z, b, { ...field, side })).toBeCloseTo(
              flipField(x, z, a, { ...field, side }),
              6,
            );
          }
        }
      }
    }
    expect(flipField(7, 2, TAU, field)).toBeCloseTo(flipField(7, 2, 0, field), 9);
  });

  it("rests the clearing on Back and crosses it with no front", () => {
    for (let k = 0; k < 64; k++) {
      const phase = (k / 64) * TAU;
      for (const [x, z] of [
        [0, 0],
        [2.5, -1],
        [-1, 3],
      ]) {
        expect(flipField(x, z, phase, { ...field, bias: flipBias(0.6) })).toBeLessThan(0);
      }
    }
  });

  it("maps Front cover to the share of Face outside the clearing", () => {
    for (const cover of [0.15, 0.4, 0.6]) {
      let face = 0;
      let n = 0;
      for (let i = 0; i < 60; i++) {
        for (let j = 0; j < 60; j++) {
          for (let k = 0; k < 6; k++) {
            const x = -28 + (i * 56) / 60 + 0.31;
            const z = -28 + (j * 56) / 60 + 0.17;
            const phase = (k / 6) * TAU + 0.2;
            if (flipField(x, z, phase, { bias: flipBias(cover), clear: -10, front: 1 }) > 0) face++;
            n++;
          }
        }
      }
      expect(Math.abs(face / n - cover), `cover ${cover}`).toBeLessThan(0.05);
    }
  });

  it("moves its fronts at about 0.3 units a second by default", () => {
    const speed = (76 * look.params.scale.default) / look.params.period.default;
    expect(speed).toBeGreaterThan(0.25);
    expect(speed).toBeLessThan(0.35);
  });

  it("keeps the ceiling above the content volume", () => {
    expect(FLIP.ceilingY).toBeGreaterThan(4);
    expect(FLIP.boardY).toBeLessThan(-2);
    expect(FLIP.boardRadius).toBeGreaterThan(FLIP.hazeEnd);
  });

  it("builds sound look materials", () => {
    for (const [key, vertexShader, fragmentShader] of [
      ["flip-disc-floor/board", BOARD_VERTEX, BOARD_FRAGMENT],
      ["flip-disc-floor/discs", DISC_VERTEX, DISC_FRAGMENT],
    ]) {
      expect(lookMaterialProblem({ key, vertexShader, fragmentShader }), key).toBeNull();
    }
  });
});
