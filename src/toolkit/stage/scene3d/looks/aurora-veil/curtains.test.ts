import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { skyDomeMaterial } from "../../kit/skyDome";
import {
  AURORA,
  auroraAdditive,
  auroraAlpha,
  auroraCurtainGeometry,
  auroraCurtainIndices,
  auroraCurtains,
} from "./curtains";
import { presets } from "./index";
import { CURTAIN_FRAGMENT, CURTAIN_VERTEX, DOME_FRAGMENT } from "./shaders";

describe("aurora veil", () => {
  it("passes the look material rules", () => {
    expect(
      lookMaterialProblem({
        key: "aurora-veil/curtain",
        vertexShader: CURTAIN_VERTEX,
        fragmentShader: CURTAIN_FRAGMENT,
      }),
    ).toBeNull();
    expect(
      lookMaterialProblem(
        skyDomeMaterial({ key: "aurora-veil/dome", fragmentShader: DOME_FRAGMENT }),
      ),
    ).toBeNull();
  });

  it("draws the sketch's seeded curtains deterministically, curtain 0 square behind the stage", () => {
    const a = auroraCurtains();
    expect(a).toEqual(auroraCurtains());
    expect(a).toHaveLength(AURORA.maxCurtains);
    expect(a[0].jitter).toBe(0);
    a.forEach((c, i) => {
      expect(c.seed).toBe(11 + i * 17);
      expect(Number.isInteger(c.pulse)).toBe(true);
      expect(Math.abs(c.jitter)).toBeLessThanOrEqual(0.25);
      expect(c.span).toBeGreaterThanOrEqual(0.9);
      expect(c.span).toBeLessThan(1.4);
      expect(Math.abs(c.radius)).toBeLessThanOrEqual(AURORA.radiusSpread / 2);
      expect(Math.abs(c.hem)).toBeLessThanOrEqual(AURORA.hemSpread / 2);
      expect(c.height).toBeGreaterThanOrEqual(20);
      expect(c.height).toBeLessThan(28);
    });
  });

  it("packs every curtain into one strip mesh with constant per-curtain attributes", () => {
    const curtains = auroraCurtains();
    const g = auroraCurtainGeometry(curtains);
    const perCurtain = (AURORA.segments + 1) * (AURORA.rows + 1);
    const position = g.getAttribute("position");
    const shape = g.getAttribute("aShape");
    expect(position.count).toBe(perCurtain * curtains.length);
    expect(g.getIndex()?.count).toBe(auroraCurtainIndices() * curtains.length);
    for (let k = 0; k < curtains.length; k++) {
      for (const v of [k * perCurtain, (k + 1) * perCurtain - 1]) {
        expect(position.getZ(v)).toBe(k);
        expect(shape.getY(v)).toBeCloseTo(curtains[k].span, 6);
      }
    }
    // A shown prefix never reaches into the next curtain's vertices.
    const index = g.getIndex()?.array ?? [];
    let max = 0;
    for (let i = 0; i < auroraCurtainIndices() * 3; i++) max = Math.max(max, index[i]);
    expect(max).toBe(perCurtain * 3 - 1);
    g.dispose();
  });

  it("adds light over dark backings and lays pastel veils over light ones", () => {
    for (const p of presets) expect(auroraAdditive(p.backing), p.id).toBe(p.mode === "dark");
  });

  it("keeps the sketch's curtain opacity at Brightness 0.8 and scales it linearly", () => {
    expect(auroraAlpha(0.8, true)).toBeCloseTo(0.75, 10);
    expect(auroraAlpha(0.4, true)).toBeCloseTo(0.375, 10);
    expect(auroraAlpha(0.8, false)).toBeGreaterThan(auroraAlpha(0.8, true));
  });
});
