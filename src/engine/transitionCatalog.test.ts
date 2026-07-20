import { describe, expect, it } from "vitest";
import { DIRECTION_OPTIONS, TRANSITION_CATALOG } from "./transitionCatalog";
import { EXT2_MIN_TYPE, EXTENDED_MIN_TYPE, TYPE_ID } from "./transitionShader";

// Structure pin: the picker's vocabulary and the shader registry cannot drift; a type added to one without the other fails here before it fails in a modal.
describe("transitionCatalog", () => {
  it("covers every shader type exactly once", () => {
    const catalogTypes = TRANSITION_CATALOG.map((m) => m.type);
    expect(new Set(catalogTypes).size).toBe(catalogTypes.length);
    expect([...catalogTypes].sort()).toEqual(Object.keys(TYPE_ID).sort());
  });

  it("has non-empty labels and hints, and sane default durations", () => {
    for (const m of TRANSITION_CATALOG) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
      expect(m.defaultDurationMs).toBeGreaterThanOrEqual(100);
      expect(m.defaultDurationMs).toBeLessThanOrEqual(2000);
    }
  });

  it("marks the generation boundaries consistently with the shader registry", () => {
    // Every catalog type maps to a numeric id; each generation sits in its own id band.
    for (const m of TRANSITION_CATALOG) {
      const id = TYPE_ID[m.type];
      expect(typeof id).toBe("number");
      if (["slice", "dissolve", "warp"].includes(m.type)) {
        expect(id).toBeGreaterThanOrEqual(EXT2_MIN_TYPE);
      } else if (["blur", "push", "zoom", "whip", "luma", "glitch"].includes(m.type)) {
        expect(id).toBeGreaterThanOrEqual(EXTENDED_MIN_TYPE);
        expect(id).toBeLessThan(EXT2_MIN_TYPE);
      } else {
        expect(id).toBeLessThan(EXTENDED_MIN_TYPE);
      }
    }
  });

  it("direction options are the four unit axes", () => {
    expect(DIRECTION_OPTIONS).toHaveLength(4);
    for (const opt of DIRECTION_OPTIONS) {
      const [x, y] = opt.value;
      expect(Math.abs(x) + Math.abs(y)).toBe(1);
    }
  });
});
