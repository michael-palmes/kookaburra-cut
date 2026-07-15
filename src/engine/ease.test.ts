import { describe, expect, it } from "vitest";
import { DEFAULT_EASE, EASE_NAMES, ease, isEaseName } from "./ease";

describe("ease", () => {
  it("hits the endpoints for every ease", () => {
    for (const name of EASE_NAMES) {
      if (name === "jump") continue; // jump holds 0 until t = 1 by design
      expect(ease(name, 0), `${name}(0)`).toBeCloseTo(0, 12);
      expect(ease(name, 1), `${name}(1)`).toBeCloseTo(1, 12);
    }
  });

  it("clamps t outside [0, 1]", () => {
    expect(ease("inOutQuad", -0.5)).toBe(0);
    expect(ease("inOutQuad", 1.5)).toBe(1);
    expect(ease("outBack", 2)).toBe(1); // clamped before the curve, no overshoot past t=1
  });

  it("jump holds the start value and snaps only at the end", () => {
    expect(ease("jump", 0)).toBe(0);
    expect(ease("jump", 0.5)).toBe(0);
    expect(ease("jump", 0.999)).toBe(0);
    expect(ease("jump", 1)).toBe(1);
  });

  it("falls back to the default ease on unknown names", () => {
    expect(isEaseName("bounceInOut")).toBe(false);
    expect(ease("bounceInOut", 0.25)).toBe(ease(DEFAULT_EASE, 0.25));
  });

  it("exposes linear, jump, and in/out/inOut for all eight families", () => {
    expect(EASE_NAMES).toHaveLength(2 + 8 * 3);
    expect(EASE_NAMES).toContain("inSine");
    expect(EASE_NAMES).toContain("inOutBack");
  });

  // The exact curve values are part of the export contract: committed projects bake camera moves and device intros from them, so any change re-renders every committed project. Do not update casually (rng.test.ts precedent).
  it("matches the golden curves at t = 0.25 / 0.5 / 0.75", () => {
    const golden: Record<string, [number, number, number]> = {
      linear: [0.25, 0.5, 0.75],
      jump: [0, 0, 0],
      inSine: [0.07612046748871326, 0.2928932188134524, 0.6173165676349102],
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: golden values are literal by design (sin(π/4) happens to be √½)
      outSine: [0.38268343236508984, 0.7071067811865476, 0.9238795325112867],
      inOutSine: [0.1464466094067262, 0.5, 0.8535533905932737],
      inQuad: [0.0625, 0.25, 0.5625],
      outQuad: [0.4375, 0.75, 0.9375],
      inOutQuad: [0.125, 0.5, 0.875],
      inCubic: [0.015625, 0.125, 0.421875],
      outCubic: [0.578125, 0.875, 0.984375],
      inOutCubic: [0.0625, 0.5, 0.9375],
      inQuart: [0.00390625, 0.0625, 0.31640625],
      outQuart: [0.68359375, 0.9375, 0.99609375],
      inOutQuart: [0.03125, 0.5, 0.96875],
      inQuint: [0.0009765625, 0.03125, 0.2373046875],
      outQuint: [0.7626953125, 0.96875, 0.9990234375],
      inOutQuint: [0.015625, 0.5, 0.984375],
      inExpo: [0.005524271728019903, 0.03125, 0.1767766952966369],
      outExpo: [0.8232233047033631, 0.96875, 0.99447572827198],
      inOutExpo: [0.015625, 0.5, 0.984375],
      inCirc: [0.031754163448145745, 0.1339745962155614, 0.3385621722338523],
      outCirc: [0.6614378277661477, 0.8660254037844386, 0.9682458365518543],
      inOutCirc: [0.0669872981077807, 0.5, 0.9330127018922193],
      inBack: [-0.06413656250000001, -0.08769750000000004, 0.18259031249999969],
      outBack: [0.8174096875000003, 1.0876975, 1.0641365625],
      inOutBack: [-0.09968184375, 0.5, 1.09968184375],
    };
    expect(Object.keys(golden).sort()).toEqual([...EASE_NAMES].sort());
    for (const [name, [a, b, c]] of Object.entries(golden)) {
      expect([ease(name, 0.25), ease(name, 0.5), ease(name, 0.75)], name).toEqual([a, b, c]);
    }
  });
});
