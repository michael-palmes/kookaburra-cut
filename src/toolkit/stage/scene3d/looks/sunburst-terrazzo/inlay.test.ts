import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import { TERRAZZO, terrazzoFade, terrazzoPhases, terrazzoRays } from "./inlay";
import { TERRAZZO_FRAGMENT, TERRAZZO_VERTEX } from "./shaders";

describe("sunburst-terrazzo", () => {
  it("closes its loop at 480 s with the default four minute turn", () => {
    for (const t of [0, 3.5, 211.25]) {
      const a = terrazzoPhases(t, look.params.turnMinutes.default);
      const b = terrazzoPhases(t + TERRAZZO.loop, look.params.turnMinutes.default);
      for (const k of ["turn", "glint", "arc"] as const) {
        expect(b[k], `${k} at ${t}`).toBeCloseTo(a[k], 9);
      }
    }
  });

  it("snaps rays to even counts so the two-tone wedges meet across the seam", () => {
    for (let r = look.params.rays.min; r <= look.params.rays.max; r++) {
      expect(terrazzoRays(r) % 2, `rays ${r}`).toBe(0);
    }
    for (const p of presets) expect(terrazzoRays(p.params?.rays ?? 0), p.id).toBe(p.params?.rays);
  });

  it("starts the far fade outside the plain disc and its rings", () => {
    for (const p of presets) {
      const { start, end } = terrazzoFade(p.params?.fadeRadius ?? 0);
      expect(start, p.id).toBeGreaterThan((p.params?.clearRadius ?? 0) + 6);
      expect(end, p.id).toBeGreaterThan(start);
    }
    expect(terrazzoFade(45)).toEqual({ start: 28, end: 45 });
  });

  it("builds a sound look material", () => {
    expect(
      lookMaterialProblem({
        key: "sunburst-terrazzo/inlay",
        vertexShader: TERRAZZO_VERTEX,
        fragmentShader: TERRAZZO_FRAGMENT,
      }),
    ).toBeNull();
  });
});
