import { describe, expect, it } from "vitest";
import { resolveTransitionParams } from "./sceneTimeline";
import { DIRECTION_OPTIONS, FEEL_ORDER, TRANSITION_CATALOG } from "./transitionCatalog";
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

  it("files every type under a known feel group", () => {
    for (const m of TRANSITION_CATALOG) {
      expect(FEEL_ORDER).toContain(m.feel);
    }
  });

  // Resolver clamps, mirrored here as the pin: a schema row outside these ranges would write values the resolver silently clamps away.
  const CLAMPS: Record<string, [number, number]> = {
    intensity: [0, 1],
    softness: [0.005, 0.5],
    steps: [1, 60],
    parallax: [0, 1],
    blocksX: [1, 128],
    blocksY: [1, 128],
  };

  it("param schema rows sit inside the resolver clamps with defaults that match the baked type defaults", () => {
    for (const m of TRANSITION_CATALOG) {
      const baked = resolveTransitionParams({ type: m.type, durationMs: m.defaultDurationMs });
      for (const row of m.params ?? []) {
        if (row.kind === "number") {
          const [lo, hi] = CLAMPS[row.key];
          expect(row.min, `${m.type}.${row.key} min`).toBeGreaterThanOrEqual(lo);
          expect(row.max, `${m.type}.${row.key} max`).toBeLessThanOrEqual(hi);
          expect(row.min).toBeLessThan(row.max);
          expect(row.default).toBeGreaterThanOrEqual(row.min);
          expect(row.default).toBeLessThanOrEqual(row.max);
          const bakedValue =
            row.key === "blocksX"
              ? baked.blocks[0]
              : row.key === "blocksY"
                ? baked.blocks[1]
                : baked[row.key];
          expect(row.default, `${m.type}.${row.key} default`).toBe(bakedValue);
        } else if (row.kind === "point") {
          expect(row.default).toEqual(baked.center);
        } else {
          expect(row.options.length).toBeGreaterThan(1);
          expect(row.options.map((o) => o.value)).toContain(row.default);
          expect(row.default).toBe(m.presets?.shape ?? baked.shape);
        }
      }
    }
  });
});
