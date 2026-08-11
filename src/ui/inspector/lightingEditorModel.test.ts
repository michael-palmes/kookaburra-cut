import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import type { LightingSpec } from "../../theme/tokens";
import {
  adjacentLightingKey,
  applyLightingLook,
  applyLightingShadowStyle,
  comparisonLightingEditorDoc,
  deleteLightingKey,
  duplicateLightingKey,
  keyLightingAtPlayhead,
  lightingLookChangeCount,
  lightingPoseForScope,
  lightingShadowStyle,
  mutateComparisonLightingTarget,
  setIncomingLightingEase,
  updateLightingKeyPose,
} from "./lightingEditorModel";

const look: LightingSpec = {
  environment: { source: "kookaburra:studio", intensity: 1, rotationDeg: 0 },
  sun: { azimuthDeg: 35, elevationDeg: 40, intensity: 1.8, kelvin: 5600 },
  ambient: 0.4,
  lights: [
    {
      id: "fill",
      type: "area",
      intensity: 3,
      placement: { mode: "point", position: [1, 2, 3] },
      width: 2,
      height: 2,
    },
  ],
};

describe("lighting editor model", () => {
  it("presents inherited scene lighting until comparison B owns an override", () => {
    const inherited = structuredClone(look);
    const explicit: LightingSpec = { ambient: 0.8 };
    const sceneDoc: SceneDoc = {
      version: 1,
      lighting: inherited,
      compare: { b: { themeId: "alternate" } },
    };

    expect(comparisonLightingEditorDoc(sceneDoc).lighting).toEqual(inherited);
    const comparisonB = sceneDoc.compare?.b;
    if (!comparisonB) throw new Error("Expected comparison B");
    comparisonB.lighting = explicit;
    expect(comparisonLightingEditorDoc(sceneDoc).lighting).toBe(explicit);
  });

  it("materialises inherited scene lighting atomically on the first comparison-B mutation", () => {
    const sceneDoc: SceneDoc = {
      version: 1,
      lighting: structuredClone(look),
      compare: { b: { themeId: "alternate" } },
    };

    mutateComparisonLightingTarget(sceneDoc, (editorDoc) => {
      if (editorDoc.lighting?.sun) editorDoc.lighting.sun.intensity = 4.2;
    });

    expect(sceneDoc.lighting).toEqual(look);
    expect(sceneDoc.compare?.b?.themeId).toBe("alternate");
    expect(sceneDoc.compare?.b?.lighting).toEqual({
      ...look,
      sun: { ...look.sun, intensity: 4.2 },
    });
  });

  it("does not materialise comparison-B lighting when a guarded mutation aborts", () => {
    const sceneDoc: SceneDoc = {
      version: 1,
      lighting: structuredClone(look),
      compare: { b: { themeId: "alternate" } },
    };

    const result = mutateComparisonLightingTarget(sceneDoc, (editorDoc) => {
      editorDoc.lighting = { ambient: 0.9 };
      return false;
    });

    expect(result).toBe(false);
    expect(sceneDoc.lighting).toEqual(look);
    expect(sceneDoc.compare?.b?.lighting).toBeUndefined();
  });

  it("keys the inherited rig while atomically establishing comparison-B ownership", () => {
    const sceneDoc: SceneDoc = {
      version: 1,
      lighting: structuredClone(look),
      compare: { b: { themeId: "alternate" } },
    };

    mutateComparisonLightingTarget(sceneDoc, (editorDoc) => {
      const keyed = keyLightingAtPlayhead(editorDoc.lighting, 500, 1000, {
        lights: { fill: { intensity: 7 } },
      });
      editorDoc.lighting = keyed.lighting;
    });

    expect(sceneDoc.lighting?.keys).toBeUndefined();
    expect(sceneDoc.compare?.b?.lighting?.lights).toEqual(look.lights);
    expect(sceneDoc.compare?.b?.lighting?.keys?.[0]).toMatchObject({
      id: "k1",
      tMs: 500,
      pose: { lights: { fill: { intensity: 7 } } },
    });
  });

  it("derives a logical look change count without storing it", () => {
    expect(lightingLookChangeCount(look, look)).toBe(0);
    expect(
      lightingLookChangeCount(
        {
          ...look,
          sun: { azimuthDeg: 35, elevationDeg: 40, intensity: 2.2, kelvin: 4200 },
        },
        look,
      ),
    ).toBe(2);
    expect(lightingLookChangeCount({ ...look, ambientColor: "#ffffff" }, look)).toBe(0);
  });

  it("applies a look while retaining only compatible keyed entries", () => {
    const next = applyLightingLook(
      {
        animationEnabled: false,
        keys: [
          {
            id: "k1",
            tMs: 0,
            pose: {
              ambient: 0.2,
              lights: { fill: { intensity: 5 }, old: { intensity: 9 } },
              fixtures: { old: { emissive: 2 } },
            },
          },
        ],
      },
      look,
      "soft-studio",
    );
    expect(next.preset).toBe("soft-studio");
    expect(next.animationEnabled).toBe(false);
    expect(next.keys?.[0].pose).toEqual({ ambient: 0.2, lights: { fill: { intensity: 5 } } });
  });

  it("filters a captured pose to one light or fixture", () => {
    const pose = {
      ambient: 0.4,
      lights: { fill: { intensity: 5 } },
      fixtures: { tube: { emissive: 2 } },
    };
    expect(lightingPoseForScope(pose, { kind: "light", id: "fill" })).toEqual({
      lights: { fill: { intensity: 5 } },
    });
    expect(lightingPoseForScope(pose, { kind: "fixture", id: "tube" })).toEqual({
      fixtures: { tube: { emissive: 2 } },
    });
  });

  it("snaps to the frame grid and selects an existing same-time key", () => {
    const created = keyLightingAtPlayhead(undefined, 21, 1000, { ambient: 0.2 });
    expect(created).toMatchObject({ created: true, keyId: "k1", tMs: 17 });
    const selected = keyLightingAtPlayhead(created.lighting, 18, 1000, { ambient: 0.9 });
    expect(selected.created).toBe(false);
    expect(selected.keyId).toBe("k1");
    expect(selected.lighting.keys?.[0].pose.ambient).toBe(0.2);
    expect(keyLightingAtPlayhead(undefined, 10, 10, {}).tMs).toBe(0);
  });

  it("selects adjacent keys and edits the selected key's incoming ease", () => {
    const lighting: LightingSpec = {
      keys: [
        { id: "k2", tMs: 1000, pose: {} },
        { id: "k1", tMs: 0, pose: {} },
        { id: "k3", tMs: 2000, pose: {} },
      ],
      segments: [
        { from: "k1", to: "k2", ease: "linear" },
        { from: "k2", to: "k3", ease: "inOutSine" },
      ],
    };
    expect(adjacentLightingKey(lighting.keys, "k2", -1)?.id).toBe("k1");
    expect(adjacentLightingKey(lighting.keys, "k2", 1)?.id).toBe("k3");
    expect(adjacentLightingKey(lighting.keys, "k1", -1)?.id).toBe("k1");
    expect(setIncomingLightingEase(lighting, "k3", "outExpo").segments?.[1].ease).toBe("outExpo");
  });

  it("keeps the shadow master distinct from the selected shadow style", () => {
    const disabled = {
      enabled: false,
      technique: "map" as const,
      softness: 0.8,
      opacity: 0.25,
      mapSize: 4096,
      bias: -0.002,
      catchBackdrop: false,
    };
    expect(lightingShadowStyle(disabled)).toBe("soft-contact");
    expect(applyLightingShadowStyle(disabled, "none")).toMatchObject({
      enabled: false,
      technique: "none",
      mapSize: 4096,
      catchBackdrop: false,
    });
    expect(lightingShadowStyle(applyLightingShadowStyle(disabled, "cast"))).toBe("cast");
  });

  it("updates, duplicates and deletes lighting keys without duplicate frame times", () => {
    const lighting: LightingSpec = {
      keys: [
        { id: "k1", tMs: 0, pose: { ambient: 0.2 } },
        { id: "k2", tMs: 17, pose: { ambient: 0.4 } },
      ],
      segments: [{ from: "k1", to: "k2", ease: "linear" }],
    };
    const updated = updateLightingKeyPose(lighting, "k2", (pose) => {
      pose.ambient = 0.8;
    });
    expect(updated.keys?.[1].pose.ambient).toBe(0.8);
    expect(lighting.keys?.[1].pose.ambient).toBe(0.4);

    const duplicated = duplicateLightingKey(updated, "k1", 100);
    expect(duplicated).toMatchObject({ created: true, keyId: "k3" });
    expect(duplicated.lighting.keys?.map((key) => key.tMs)).toEqual([0, 17, 33]);
    expect(duplicated.lighting.keys?.find((key) => key.id === "k3")?.pose).toEqual({
      ambient: 0.2,
    });

    const deleted = deleteLightingKey(duplicated.lighting, "k2");
    expect(deleted.keys?.map((key) => key.id)).toEqual(["k1", "k3"]);
    expect(deleted.segments).toHaveLength(1);
    const emptied = deleteLightingKey(deleteLightingKey(deleted, "k1"), "k3");
    expect(emptied.keys).toBeUndefined();
    expect(emptied.segments).toBeUndefined();
  });
});
