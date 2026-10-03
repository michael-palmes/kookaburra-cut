import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { presets } from "./index";
import { loomStrands } from "./PlexusLoom";
import { LOOM } from "./shaders";

describe("plexus loom strands", () => {
  it("orders strands bundle-major, so a bundle-count prefix draws whole bundles of both families", () => {
    const strands = loomStrands(4);
    expect(strands).toHaveLength(4 * 2 * LOOM.threadsPerBundle);
    const firstTwo = strands.slice(0, 2 * 2 * LOOM.threadsPerBundle).map((s) => s.data);
    expect(new Set(firstTwo.map((d) => d[0]))).toEqual(new Set([0, 1]));
    for (const bundle of [0, 1]) {
      for (const sign of [1, -1]) {
        const threads = firstTwo.filter((d) => d[0] === bundle && d[1] === sign).map((d) => d[2]);
        expect(threads.sort()).toEqual([0, 1, 2]);
      }
    }
  });

  it("runs every thread from the low hoop (0) to the high hoop (1)", () => {
    const [strand] = loomStrands(1);
    expect(strand.points.length / 4).toBe(LOOM.points);
    expect(strand.points[0]).toBe(0);
    expect(strand.points.at(-4)).toBe(1);
  });
});

describe("plexus loom presets", () => {
  it("carries a companion rig on every preset, tinted by its hoop", () => {
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      if (!p.lighting) continue;
      expect(companionLightingProblem(p.lighting), p.id).toBeNull();
      expect(p.lighting.lights?.[0]?.color, p.id).toBe(p.colors[3]);
    }
  });
});
