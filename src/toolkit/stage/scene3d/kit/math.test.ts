import { describe, expect, it } from "vitest";
import { fract, smoothstep } from "./math";

describe("look CPU maths", () => {
  it("smoothsteps like GLSL, clamped outside the edges", () => {
    expect(smoothstep(2, 4, 1)).toBe(0);
    expect(smoothstep(2, 4, 5)).toBe(1);
    expect(smoothstep(2, 4, 3)).toBe(0.5);
    expect(smoothstep(0, 1, 0.25)).toBeCloseTo(0.15625, 12);
    expect(smoothstep(1, 0, 0.25)).toBeCloseTo(0.84375, 12);
  });

  it("takes fract into [0, 1) for negatives too", () => {
    expect(fract(2.25)).toBe(0.25);
    expect(fract(-0.25)).toBe(0.75);
    expect(fract(3)).toBe(0);
  });
});
