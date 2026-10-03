import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { MAX_SCENE_LIGHTS, normalizeLighting, resolveLighting } from "../../engine/sceneLighting";
import type {
  LightingCompanionFields,
  LightingSpec,
  LightSpec,
  ThemeBackground,
} from "../../theme/tokens";
import {
  applyCompanionLighting,
  type CompanionTarget,
  companionMatches,
  companionSkippedLights,
  companionTargetFor,
  type LightingBelow,
  reconcileCompanionLighting,
  removeCompanionLighting,
  writeSideLighting,
} from "./companionLightingModel";

// No bundled preset carries a lighting block yet, so these are typed fixtures.
const point = (id: string, extra: Partial<LightSpec> = {}): LightSpec =>
  ({
    id,
    type: "point",
    intensity: 2,
    kelvin: 3200,
    placement: { mode: "point", position: [0, 6, -8] },
    ...extra,
  }) as LightSpec;

const hoopBlock: LightingCompanionFields = {
  sun: { azimuthDeg: 40, elevationDeg: 20, intensity: 1.4, kelvin: 3800 },
  ambient: 0.3,
  lights: [point("hoop-down"), point("hoop-rim", { intensity: 0.6 })],
  fixtures: [
    {
      id: "hoop-high",
      form: "ring",
      size: [32, 0.12],
      kelvin: 3000,
      emissive: 2,
      lightIntensity: 0,
      placement: { mode: "point", position: [0, 8, 0] },
      rotationDeg: [90, 0, 0],
    },
  ],
};

const duskBlock: LightingCompanionFields = {
  sun: { azimuthDeg: -120, elevationDeg: 12, intensity: 0.9, kelvin: 2600 },
  ambient: 0.5,
  lights: [point("dusk-fill", { intensity: 1 })],
};

const presets = {
  "plexus-loom": [
    { id: "p1", lighting: hoopBlock },
    { id: "p2" },
    { id: "p6", lighting: duskBlock },
  ],
};

const target = (preset: "p1" | "p6"): CompanionTarget => {
  const found = companionTargetFor({ type: "scene3d", look: "plexus-loom", preset }, presets);
  if (!found) throw new Error(`Expected a companion for ${preset}`);
  return found;
};

const theme: LightingSpec = {
  sun: { azimuthDeg: 30, elevationDeg: 45, intensity: 1, kelvin: 5600 },
  ambient: 0.4,
  lights: [point("theme-key", { intensity: 3 })],
};
const below: LightingBelow = { theme };

describe("companionTargetFor", () => {
  it("only offers a block for a scene3d pick whose applied preset carries one", () => {
    const cases: (ThemeBackground | undefined)[] = [
      undefined,
      { type: "color", color: "#000000" },
      { type: "scene3d", look: "plexus-loom" },
      { type: "scene3d", look: "plexus-loom", preset: "p2" },
      { type: "scene3d", look: "unknown", preset: "p1" },
    ];
    for (const background of cases) expect(companionTargetFor(background, presets)).toBeNull();
    expect(target("p1")).toEqual({ look: "plexus-loom", preset: "p1", lighting: hoopBlock });
  });
});

describe("Matching lighting toggle", () => {
  it("round-trips a scene without lighting back to no lighting (null for legacy)", () => {
    const on = applyCompanionLighting(undefined, below, target("p1"));
    expect(companionMatches(on, target("p1"))).toBe(true);
    expect(removeCompanionLighting(on, below)).toBeUndefined();
  });

  it("writes the block over the scene layer and appends to the inherited lists", () => {
    const on = applyCompanionLighting(undefined, below, target("p1"));
    expect(on.sun).toEqual(hoopBlock.sun);
    expect(on.ambient).toBe(0.3);
    expect(on.lights?.map((l) => l.id)).toEqual(["theme-key", "hoop-down", "hoop-rim"]);
    expect(on.fixtures?.map((f) => f.id)).toEqual(["hoop-high"]);
    expect(on.companion?.prior).toEqual({});
    const resolved = resolveLighting(theme, undefined, on);
    expect(resolved?.lights).toHaveLength(3);
    expect(resolved).not.toHaveProperty("companion");
  });

  it("restores the scene's own values the block replaced", () => {
    const scene: LightingSpec = {
      ambient: 0.2,
      environment: { source: "kookaburra:studio", intensity: 1, rotationDeg: 0 },
    };
    const on = applyCompanionLighting(scene, below, target("p1"));
    expect(on.companion?.prior).toEqual({ ambient: 0.2 });
    expect(on.environment).toEqual(scene.environment);
    expect(removeCompanionLighting(on, below)).toEqual(scene);
  });

  it("keeps the scene's own list and returns it untouched on off", () => {
    const scene: LightingSpec = { lights: [point("mine")] };
    const on = applyCompanionLighting(scene, below, target("p1"));
    expect(on.lights?.map((l) => l.id)).toEqual(["mine", "hoop-down", "hoop-rim"]);
    expect(removeCompanionLighting(on, below)).toEqual(scene);
  });

  it("never loses the user's edits made while it was on", () => {
    const on = applyCompanionLighting(undefined, below, target("p1"));
    const edited = structuredClone(on);
    if (!edited.sun || !edited.lights) throw new Error("Expected a written rig");
    edited.sun.intensity = 2.2;
    edited.lights[1] = { ...edited.lights[1], intensity: 5 };
    edited.lights.push(point("added-later"));
    edited.keys = [{ id: "k1", tMs: 0, pose: { lights: { "hoop-rim": { intensity: 0 } } } }];

    const off = removeCompanionLighting(edited, below);
    expect(off?.sun?.intensity).toBe(2.2);
    expect(off?.ambient).toBeUndefined();
    expect(off?.lights?.map((l) => l.id)).toEqual([
      "theme-key",
      "hoop-down",
      "hoop-rim",
      "added-later",
    ]);
    expect(off?.lights?.[1].intensity).toBe(5);
    expect(off?.fixtures).toBeUndefined();
    expect(off).not.toHaveProperty("companion");
  });

  it("drops unedited entries but keeps one a keyframe references", () => {
    const on = applyCompanionLighting(undefined, below, target("p1"));
    on.keys = [{ id: "k1", tMs: 0, pose: { fixtures: { "hoop-high": { emissive: 3 } } } }];
    const off = removeCompanionLighting(on, below);
    expect(off?.fixtures?.map((f) => f.id)).toEqual(["hoop-high"]);
    expect(off?.lights).toBeUndefined();
  });

  it("renames an entry whose id the scene already uses", () => {
    const scene: LightingSpec = { lights: [point("hoop-down", { intensity: 9 })] };
    const on = applyCompanionLighting(scene, below, target("p1"));
    expect(on.lights?.map((l) => l.id)).toEqual(["hoop-down", "hoop-down-2", "hoop-rim"]);
    expect(removeCompanionLighting(on, below)).toEqual(scene);
  });

  it("adds lights only inside the 16-light budget", () => {
    const full = Array.from({ length: MAX_SCENE_LIGHTS - 2 }, (_, i) => point(`own-${i}`));
    const scene: LightingSpec = { lights: full };
    const on = applyCompanionLighting(scene, below, target("p1"));
    // The written sun takes one slot, so one of the two companion lights fits.
    expect(on.lights).toHaveLength(MAX_SCENE_LIGHTS - 1);
    expect(on.companion?.wrote.lights?.map((l) => l.id)).toEqual(["hoop-down"]);
    expect(companionSkippedLights(on, target("p1"))).toBe(1);
    expect(removeCompanionLighting(on, below)).toEqual(scene);
  });

  it("survives a save and reload, recognising its own writes in parser order", () => {
    const scene: LightingSpec = { ambient: 0.2 };
    const on = applyCompanionLighting(scene, below, target("p1"));
    const reloaded = normalizeLighting(JSON.parse(JSON.stringify(on)), "test");
    expect(reloaded?.companion).toEqual(on.companion);
    expect(removeCompanionLighting(reloaded ?? undefined, below)).toEqual(scene);
  });

  it("is dropped from theme layers", () => {
    const on = applyCompanionLighting(undefined, below, target("p1"));
    const asTheme = normalizeLighting(on, "theme", { themeLayer: true });
    expect(asTheme).not.toHaveProperty("companion");
  });
});

describe("reconcileCompanionLighting", () => {
  it("leaves an off toggle off and an on toggle alone for its own preset", () => {
    const scene: LightingSpec = { ambient: 0.2 };
    expect(reconcileCompanionLighting(scene, below, target("p1"))).toBe(scene);
    const on = applyCompanionLighting(scene, below, target("p1"));
    expect(reconcileCompanionLighting(on, below, target("p1"))).toBe(on);
  });

  it("follows a new preset's block and still restores the scene's own values", () => {
    const scene: LightingSpec = { ambient: 0.2 };
    const onP1 = applyCompanionLighting(scene, below, target("p1"));
    const onP6 = reconcileCompanionLighting(onP1, below, target("p6"));
    expect(companionMatches(onP6, target("p6"))).toBe(true);
    expect(onP6?.ambient).toBe(0.5);
    expect(onP6?.lights?.map((l) => l.id)).toEqual(["theme-key", "dusk-fill"]);
    expect(onP6?.fixtures).toBeUndefined();
    expect(removeCompanionLighting(onP6, below)).toEqual(scene);
  });

  it("turns off when the new pick has no block", () => {
    const on = applyCompanionLighting(undefined, below, target("p1"));
    expect(reconcileCompanionLighting(on, below, null)).toBeUndefined();
  });
});

describe("writeSideLighting", () => {
  const on = (lighting: LightingSpec | undefined) =>
    applyCompanionLighting(lighting, below, target("p1"));
  const off = (lighting: LightingSpec | undefined) => removeCompanionLighting(lighting, below);

  it("writes Before's own layer and clears it when nothing is left", () => {
    const doc: SceneDoc = { version: 1 };
    writeSideLighting(doc, "a", on);
    expect(doc.lighting?.companion?.preset).toBe("p1");
    writeSideLighting(doc, "a", off);
    expect(doc).toEqual({ version: 1 });
  });

  it("materialises After from Before, then inherits again once it matches", () => {
    const doc: SceneDoc = { version: 1, lighting: { ambient: 0.2 }, compare: { b: {} } };
    writeSideLighting(doc, "b", on);
    expect(doc.lighting).toEqual({ ambient: 0.2 });
    expect(doc.compare?.b?.lighting?.companion?.preset).toBe("p1");
    writeSideLighting(doc, "b", off);
    expect(doc.compare?.b).toEqual({});
  });
});
