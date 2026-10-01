import { describe, expect, it, vi } from "vitest";
import {
  SCENE3D_BACKGROUND_IDS,
  SCENE3D_BACKGROUND_PRESETS,
  SCENE3D_BACKGROUNDS,
  SCENE3D_FAMILIES,
  SCENE3D_FAMILY_GROUPS,
  SCENE3D_FAMILY_NAMES,
  type Scene3dBackgroundDef,
  type Scene3dFamily,
} from "./index";
import { collectScene3dLooks, DISCOVERED_SCENE3D_LOOKS } from "./looks";
import { resolveScene3dParams } from "./params";

/** The folder-per-look registry: the built-in ten stay first and unchanged, discovered folders merge in by family, and every def is well formed. */

const BUILT_IN: [string, Scene3dFamily][] = [
  ["grid-plain", "grids"],
  ["grid-shell", "grids"],
  ["grid-hall", "grids"],
  ["contour-field", "grids"],
  ["drift-slabs", "abstract"],
  ["orb-field", "abstract"],
  ["halo-rings", "abstract"],
  ["skyline-prisms", "abstract"],
  ["point-swell", "grids"],
  ["dust-drift", "grids"],
];

const stubLook = (id: string, family: Scene3dFamily, name: string): Scene3dBackgroundDef => ({
  id,
  name,
  family,
  colorSlots: [],
  params: {},
  Component: () => null,
});

describe("scene3d registry", () => {
  it("keeps the built-in ten first, in shipped order, with their families", () => {
    expect(SCENE3D_BACKGROUND_IDS.slice(0, BUILT_IN.length)).toEqual(BUILT_IN.map(([id]) => id));
    for (const [id, family] of BUILT_IN) expect(SCENE3D_BACKGROUNDS[id].family, id).toBe(family);
  });

  it("lists every look exactly once, ids matching their record keys", () => {
    expect([...SCENE3D_BACKGROUND_IDS].sort()).toEqual(Object.keys(SCENE3D_BACKGROUNDS).sort());
    expect(new Set(SCENE3D_BACKGROUND_IDS).size).toBe(SCENE3D_BACKGROUND_IDS.length);
    for (const [key, def] of Object.entries(SCENE3D_BACKGROUNDS)) expect(def.id).toBe(key);
  });

  it("merges every look folder: id equals folder name, presets registered, no built-in clash", () => {
    const folders = Object.keys(import.meta.glob("./looks/*/index.ts")).map(
      (path) => path.split("/")[2],
    );
    expect(DISCOVERED_SCENE3D_LOOKS.map((l) => l.folder).sort()).toEqual(folders.sort());
    const builtIn = new Set(BUILT_IN.map(([id]) => id));
    for (const { folder, look, presets } of DISCOVERED_SCENE3D_LOOKS) {
      expect(look.id, folder).toBe(folder);
      expect(builtIn.has(look.id), folder).toBe(false);
      expect(SCENE3D_BACKGROUNDS[look.id], folder).toBe(look);
      expect(SCENE3D_BACKGROUND_PRESETS[look.id], folder).toBe(presets);
    }
    expect(SCENE3D_BACKGROUND_IDS.slice(BUILT_IN.length)).toEqual(
      DISCOVERED_SCENE3D_LOOKS.map((l) => l.look.id),
    );
  });

  it("gives every look a known family and every family a heading", () => {
    for (const def of Object.values(SCENE3D_BACKGROUNDS)) {
      expect(SCENE3D_FAMILIES, def.id).toContain(def.family);
    }
    expect(Object.keys(SCENE3D_FAMILY_NAMES).sort()).toEqual([...SCENE3D_FAMILIES].sort());
  });

  it("groups the picker by family in order, covering every id once", () => {
    const ranks = SCENE3D_FAMILY_GROUPS.map((g) => SCENE3D_FAMILIES.indexOf(g.family));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(SCENE3D_FAMILY_GROUPS.flatMap((g) => g.ids).sort()).toEqual(
      [...SCENE3D_BACKGROUND_IDS].sort(),
    );
    expect(SCENE3D_FAMILY_GROUPS[0]).toMatchObject({ family: "grids", name: "Grids and fields" });
  });

  it("keeps every param def ordered, stepped and defaulting inside its bounds", () => {
    for (const def of Object.values(SCENE3D_BACKGROUNDS)) {
      for (const [key, p] of Object.entries(def.params)) {
        const at = `${def.id} ${key}`;
        expect(p.min, at).toBeLessThan(p.max);
        expect(p.step, at).toBeGreaterThan(0);
        expect(p.default, at).toBeGreaterThanOrEqual(p.min);
        expect(p.default, at).toBeLessThanOrEqual(p.max);
      }
    }
  });
});

describe("collectScene3dLooks", () => {
  it("orders by family, then name, then id, and skips unusable or duplicate folders", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const looks = collectScene3dLooks({
      "./looks/zeta/index.ts": { look: stubLook("zeta", "kinetic", "Alpha"), presets: [] },
      "./looks/beta/index.ts": { look: stubLook("beta", "lines", "Pulse"), presets: [] },
      "./looks/alpha/index.ts": { look: stubLook("alpha", "lines", "Engraved"), presets: [] },
      "./looks/empty/index.ts": {},
      "./looks/dupe/index.ts": { look: stubLook("beta", "deco", "Copy"), presets: [] },
    });
    expect(looks.map((l) => l.look.id)).toEqual(["alpha", "beta", "zeta"]);
    expect(looks.map((l) => l.folder)).toEqual(["alpha", "beta", "zeta"]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("resolveScene3dParams", () => {
  const defs = {
    count: { label: "Count", default: 900, min: 200, max: 1500, step: 10 },
    height: { label: "Height", default: -1.3, min: -6, max: 0, step: 0.1 },
  };

  it("fills defaults and clamps to each def's bounds", () => {
    expect(resolveScene3dParams(defs, undefined)).toEqual({ count: 900, height: -1.3 });
    expect(resolveScene3dParams(defs, { count: 99999, height: -40, extra: 3 })).toEqual({
      count: 1500,
      height: -6,
    });
  });

  it("passes every in-range preset value through untouched (null for legacy)", () => {
    for (const [look, presets] of Object.entries(SCENE3D_BACKGROUND_PRESETS)) {
      const def = SCENE3D_BACKGROUNDS[look];
      for (const p of presets) {
        const resolved = resolveScene3dParams(def.params, p.params);
        for (const [key, value] of Object.entries(p.params ?? {})) {
          expect(Object.is(resolved[key], value), `${look} ${p.id} ${key}`).toBe(true);
        }
      }
    }
  });
});
