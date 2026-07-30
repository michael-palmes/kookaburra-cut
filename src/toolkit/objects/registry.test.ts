import { describe, expect, it } from "vitest";
import { builtinObjects } from "./registry";

/** A silently-degraded builtin must fail unit tests, not gates (the rule in registry.ts). */
describe("bundled objects", () => {
  it("every starter manifest parses and registers", () => {
    expect(Object.keys(builtinObjects).sort()).toEqual([
      "avocado",
      "boombox",
      "lantern",
      "water-bottle",
    ]);
  });

  it("every starter carries a fit height and a CC0 licence", () => {
    for (const manifest of Object.values(builtinObjects)) {
      expect(manifest.fitHeight).toBeGreaterThan(0);
      expect(manifest.licence?.name).toBe("CC0");
    }
  });
});
