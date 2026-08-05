import { describe, expect, it } from "vitest";
import {
  carryDof,
  DOF_DEFAULTS,
  DOF_FOCUS_MIN,
  holdDof,
  mixDof,
  mixFocusDistance,
  normalizeDocDof,
} from "./dof";
import { mixAimDistance } from "./sceneRig";

const silent = () => {};

describe("normalizeDocDof", () => {
  it("passes undefined through and drops non-objects", () => {
    expect(normalizeDocDof(undefined, silent)).toBeUndefined();
    expect(normalizeDocDof("nope", silent)).toBeUndefined();
    expect(normalizeDocDof(3, silent)).toBeUndefined();
  });

  it("clamps numeric fields and names each clamp", () => {
    const warnings: string[] = [];
    const out = normalizeDocDof({ blur: 2, range: -1, focus: 0, offset: 9, angleDeg: 200 }, (m) =>
      warnings.push(m),
    );
    expect(out).toEqual({ blur: 1, range: 0, focus: DOF_FOCUS_MIN, offset: 1, angleDeg: 90 });
    expect(warnings).toHaveLength(5);
  });

  it("drops non-finite fields but keeps the rest", () => {
    const out = normalizeDocDof({ blur: Number.NaN, range: 2 }, silent);
    expect(out).toEqual({ range: 2 });
  });

  it('keeps focus "auto" and drops an unknown mode', () => {
    expect(normalizeDocDof({ focus: "auto" }, silent)).toEqual({ focus: "auto" });
    expect(normalizeDocDof({ mode: "bokeh", blur: 0.5 }, silent)).toEqual({ blur: 0.5 });
  });

  it("accepts the style modes and clamps their fields", () => {
    for (const mode of ["soft", "radial", "directional", "split"] as const) {
      expect(normalizeDocDof({ mode }, silent)).toEqual({ mode });
    }
    expect(
      normalizeDocDof({ glow: 2, centerX: -3, centerY: 1.5, squeeze: 5, focusB: 0 }, silent),
    ).toEqual({ glow: 1, centerX: -1, centerY: 1, squeeze: 2, focusB: DOF_FOCUS_MIN });
  });

  it("returns undefined when nothing usable remains", () => {
    expect(normalizeDocDof({ mode: "wat", blur: "x" }, silent)).toBeUndefined();
  });
});

describe("carryDof", () => {
  it("returns previous unchanged (same reference) when nothing is authored", () => {
    const prev = { ...DOF_DEFAULTS, blur: 0.5 };
    expect(carryDof(prev, undefined)).toBe(prev);
    expect(carryDof(null, undefined)).toBeNull();
  });

  it("seeds from the defaults on the first authored block", () => {
    expect(carryDof(null, { blur: 0.6 })).toEqual({ ...DOF_DEFAULTS, blur: 0.6 });
  });

  it("carries per FIELD: a rack restates only focus", () => {
    const k1 = carryDof(null, { blur: 0.6, range: 1.2, focus: 2 });
    const k2 = carryDof(k1, { focus: 4 });
    expect(k2).toEqual({ ...DOF_DEFAULTS, blur: 0.6, range: 1.2, focus: 4 });
  });

  it('focus "auto" clears a carried manual distance', () => {
    const k1 = carryDof(null, { blur: 0.6, focus: 2 });
    const k2 = carryDof(k1, { focus: "auto" });
    expect(k2?.focus).toBeNull();
    expect(k2?.blur).toBe(0.6);
  });

  it("carries the style fields like any other", () => {
    const k1 = carryDof(null, { mode: "radial", blur: 0.5, centerX: -0.4, glow: 0.3 });
    const k2 = carryDof(k1, { centerY: 0.2 });
    expect(k2).toEqual({
      ...DOF_DEFAULTS,
      blur: 0.5,
      centerX: -0.4,
      centerY: 0.2,
      glow: 0.3,
    });
  });
});

describe("mixFocusDistance", () => {
  it("stays in lockstep with mixAimDistance (EXPORT CONTRACT)", () => {
    for (const [a, b, t] of [
      [1.5, 8, 0.25],
      [6, 1, 0.5],
      [0, 4, 0.3],
      [2, 2, 0.9],
    ] as const) {
      expect(mixFocusDistance(a, b, t)).toBe(mixAimDistance(a, b, t));
    }
  });
});

describe("mixDof", () => {
  it("returns null when neither end has dof", () => {
    expect(mixDof(null, null, 0.5, 5)).toBeNull();
  });

  it("autofocus ends resolve to the frame's aim distance", () => {
    const eff = { ...DOF_DEFAULTS, blur: 0.6 };
    const mixed = mixDof(eff, eff, 0.5, 4.2);
    expect(mixed?.focus).toBe(4.2);
    expect(mixed?.blur).toBe(0.6);
  });

  it("an auto -> manual segment converges on the manual number", () => {
    const auto = { ...DOF_DEFAULTS, blur: 0.6 };
    const manual = { ...DOF_DEFAULTS, blur: 0.6, focus: 2 };
    expect(mixDof(auto, manual, 0, 8)?.focus).toBe(8);
    expect(mixDof(auto, manual, 1, 8)?.focus).toBe(2);
    expect(mixDof(auto, manual, 0.5, 8)?.focus).toBeCloseTo(4, 10);
  });

  it("a missing end mixes against the defaults (blur eases in from 0)", () => {
    const eff = { ...DOF_DEFAULTS, blur: 0.8 };
    expect(mixDof(null, eff, 0.5, 5)?.blur).toBeCloseTo(0.4, 12);
  });

  it("style fields lerp; the second focus plane racks in log space", () => {
    const a = { ...DOF_DEFAULTS, blur: 0.5, centerX: -1, squeeze: 1, focusB: 2 };
    const b = { ...DOF_DEFAULTS, blur: 0.5, centerX: 1, squeeze: 2, focusB: 8 };
    const mid = mixDof(a, b, 0.5, 5);
    expect(mid?.centerX).toBeCloseTo(0, 12);
    expect(mid?.squeeze).toBeCloseTo(1.5, 12);
    expect(mid?.focusB).toBeCloseTo(4, 10);
    expect(mid?.focusB).toBe(mixFocusDistance(2, 8, 0.5));
  });
});

describe("holdDof", () => {
  it("resolves autofocus at the held pose's aim distance, null without dof", () => {
    expect(holdDof(null, 5)).toBeNull();
    expect(holdDof({ ...DOF_DEFAULTS, blur: 0.5 }, 3.3)?.focus).toBe(3.3);
    expect(holdDof({ ...DOF_DEFAULTS, blur: 0.5, focus: 7 }, 3.3)?.focus).toBe(7);
  });
});
