import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { GUILLOCHE, GUILLOCHE_LOOP, guillocheCounts, guillochePhases } from "./dial";
import { look, presets } from "./index";
import { GUILLOCHE_FRAGMENT, GUILLOCHE_VERTEX } from "./shaders";

describe("guilloche-medallion", () => {
  it("keeps the sketch's strand counts by default and every band inside its shader loop", () => {
    expect(guillocheCounts(look.params.strands.default)).toEqual({
      lace: 8,
      braid: 5,
      rosette: 7,
      border: 2,
    });
    for (let s = look.params.strands.min; s <= look.params.strands.max; s++) {
      const c = guillocheCounts(s);
      expect(c.lace, `strands ${s}`).toBeLessThanOrEqual(GUILLOCHE_LOOP.lace);
      expect(c.braid, `strands ${s}`).toBeLessThanOrEqual(GUILLOCHE_LOOP.braid);
      expect(c.rosette, `strands ${s}`).toBeLessThanOrEqual(GUILLOCHE_LOOP.rosette);
      expect(c.border, `strands ${s}`).toBeLessThanOrEqual(GUILLOCHE_LOOP.border);
      expect(Math.max(c.lace, c.braid * 2, c.rosette, c.border * 2)).toBeLessThanOrEqual(
        GUILLOCHE.maxStrands,
      );
    }
  });

  it("loops exactly at 600 s at the default re-weave speed", () => {
    for (const t of [0, 7.25, 133.5]) {
      const a = guillochePhases(t, 1);
      const b = guillochePhases(t + GUILLOCHE.loop, 1);
      for (const k of ["turn", "weaveA", "weaveB", "sheen"] as const) {
        expect(b[k], `${k} at ${t}`).toBeCloseTo(a[k], 9);
      }
    }
  });

  it("moves visibly within four seconds: the sheen sweeps at least 20 degrees", () => {
    const a = guillochePhases(10, 1).sheen;
    const b = guillochePhases(14, 1).sheen;
    expect(((b - a) * 180) / Math.PI).toBeGreaterThan(20);
  });

  it("builds a sound look material and whole strand counts in every preset", () => {
    expect(
      lookMaterialProblem({
        key: "guilloche-medallion/dial",
        vertexShader: GUILLOCHE_VERTEX,
        fragmentShader: GUILLOCHE_FRAGMENT,
      }),
    ).toBeNull();
    for (const p of presets) {
      expect(Number.isInteger(p.params?.strands), p.id).toBe(true);
      expect(p.lighting, p.id).toBeUndefined();
    }
  });
});
