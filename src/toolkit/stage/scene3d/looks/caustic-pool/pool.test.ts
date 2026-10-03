import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import {
  CAUSTIC_TURNS,
  causticAt,
  causticAtTurns,
  causticPhase,
  causticRate,
  causticTurns,
  POOL,
} from "./pool";
import { FLOOR_FRAGMENT, POOL_VERTEX, SURFACE_FRAGMENT } from "./shaders";

const TAU = Math.PI * 2;
const pair = () => ({
  x: 0,
  y: 0,
  set(x: number, y: number) {
    this.x = x;
    this.y = y;
  },
});
const turnsAt = (phase: number): [number, number][] => {
  const out = CAUSTIC_TURNS.map(pair);
  causticTurns(phase, out);
  return out.map((p) => [p.x, p.y]);
};
const SAMPLES = [
  [0.3, 1.7],
  [-2.4, 0.9],
  [5.1, -3.3],
];

describe("caustic-pool", () => {
  it("closes the nets exactly at every loop length", () => {
    for (const loop of [look.params.loop.min, look.params.loop.default, look.params.loop.max]) {
      for (const t of [0, 3.25, 97.5]) {
        const a = causticPhase(t, loop);
        const b = causticPhase(t + loop, loop);
        expect(b, `${loop} at ${t}`).toBeCloseTo(a, 9);
        for (const [x, y] of SAMPLES) {
          expect(causticAt(x, y, causticPhase(t + loop * 3, loop))).toBeCloseTo(
            causticAt(x, y, a),
            6,
          );
        }
      }
      expect(causticAt(1.1, 2.2, TAU)).toBeCloseTo(causticAt(1.1, 2.2, 0), 6);
    }
  });

  it("tiles every Caustic scale in world space", () => {
    for (const [x, y] of SAMPLES) {
      expect(causticAt(x + TAU, y, 0.7)).toBeCloseTo(causticAt(x, y, 0.7), 6);
      expect(causticAt(x, y - TAU, 0.7)).toBeCloseTo(causticAt(x, y, 0.7), 6);
    }
  });

  it("matches the reference field from the shader's precomputed turns, forward and reversed", () => {
    for (const phase of [0, 0.41, 2.9, 5.5]) {
      for (const [x, y] of SAMPLES) {
        expect(causticAtTurns(x, y, turnsAt(phase))).toBeCloseTo(causticAt(x, y, phase), 9);
        expect(causticAtTurns(x, y, turnsAt(phase), -1)).toBeCloseTo(causticAt(x, y, -phase), 9);
      }
    }
  });

  it("moves visibly at speed 1 on every preset and stays calm", () => {
    for (const p of presets) {
      const rate = causticRate(p.params?.loop ?? 0) * (p.speed ?? 1);
      expect(rate, p.id).toBeGreaterThan(0.1);
      expect(rate, p.id).toBeLessThan(0.5);
    }
  });

  it("keeps the surface above the content volume and the floor below it", () => {
    expect(POOL.surfaceY).toBeGreaterThan(4);
    expect(POOL.floorY).toBeLessThan(-2);
    expect(POOL.discRadius).toBeGreaterThan(POOL.fadeEnd);
  });

  it("gives every preset a valid companion rig from high overhead", () => {
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(70);
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(200);
    }
  });

  it("builds sound look materials", () => {
    for (const [key, fragmentShader] of [
      ["caustic-pool/floor", FLOOR_FRAGMENT],
      ["caustic-pool/surface", SURFACE_FRAGMENT],
    ]) {
      expect(
        lookMaterialProblem({ key, vertexShader: POOL_VERTEX, fragmentShader }),
        key,
      ).toBeNull();
    }
    expect(FLOOR_FRAGMENT).toContain(`uniform vec2 uTurn[${CAUSTIC_TURNS.length}]`);
  });
});
