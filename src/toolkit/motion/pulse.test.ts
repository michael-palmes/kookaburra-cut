import { describe, expect, it } from "vitest";
import { ease } from "../../engine/ease";
import type { SceneTime } from "../types";
import { pulse } from "./pulse";

const at = (localMs: number): SceneTime => ({ localMs, globalMs: localMs + 5000, progress: 0.5 });

describe("pulse", () => {
  const shape = { attackMs: 20, holdMs: 30, releaseMs: 100 };

  it("takes a SceneTime or plain scene-local ms, and one time or many", () => {
    expect(pulse(at(1030), 1000, shape)).toBe(1);
    expect(pulse(1030, [1000], shape)).toBe(1);
    expect(pulse(at(1010), 1000, shape)).toBe(ease("outQuad", 0.5));
  });

  it("is exactly 0 before, between and after its pulses", () => {
    const beats = [1000, 2000];
    expect(pulse(999, beats, shape)).toBe(0);
    expect(pulse(1500, beats, shape)).toBe(0);
    expect(pulse(3000, beats, shape)).toBe(0);
    expect(pulse(500, [], shape)).toBe(0);
  });

  it("takes the strongest of overlapping pulses, whatever their order", () => {
    const long = { releaseMs: 1000, ease: "linear" as const };
    const near = pulse(1100, [1000, 1050], long);
    expect(near).toBeCloseTo(0.95, 12);
    expect(pulse(1100, [1050, 1000], long)).toBe(near);
    expect(near).toBeLessThanOrEqual(1);
  });

  it("snaps with no attack and shapes with a custom ease", () => {
    expect(pulse(1000, 1000, { releaseMs: 200 })).toBe(1);
    expect(pulse(1100, 1000, { releaseMs: 200, ease: (t) => t * t })).toBe(0.75);
  });
});
