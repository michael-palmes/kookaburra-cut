import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  clearCompareTrack,
  duplicateCompareDeviceTargets,
  mutateCompareBackgroundTarget,
  mutateCompareLightingTarget,
  pruneCompareDeviceTargets,
  setCompareDeviceAppearance,
} from "./comparisonTarget";

const doc = (): SceneDoc => ({
  version: 1,
  devices: [
    { id: "d1", model: "android", colour: "graphite", shadow: "soft" },
    { id: "d2", model: "android", colour: "silver", shadow: "long" },
  ],
  background: { type: "shader", shader: "mesh-gradient", colors: ["#111111", "#222222"] },
  backdrop: { type: "floor", color: "#111111" },
  lighting: { ambient: 0.4, preset: "base-lighting" },
  compare: { b: {} },
});

describe("comparison inspector targets", () => {
  it("changes After staging without freezing Before's background into an override", () => {
    const next = doc();
    mutateCompareBackgroundTarget(next, (target) => {
      target.backdrop = { type: "none" };
    });
    expect(next.background).toMatchObject({ type: "shader" });
    expect(next.backdrop).toEqual({ type: "floor", color: "#111111" });
    expect(next.compare?.b?.background).toBeUndefined();
    expect(next.compare?.b?.backdrop).toEqual({ type: "none" });
  });

  it("isolates nested After background edits from Before", () => {
    const next = doc();
    mutateCompareBackgroundTarget(next, (target) => {
      if (target.background?.type === "shader") target.background.colors?.splice(0, 1, "#abcdef");
    });
    expect(next.background).toMatchObject({ colors: ["#111111", "#222222"] });
    expect(next.compare?.b?.background).toMatchObject({ colors: ["#abcdef", "#222222"] });
  });

  it("starts a new After lighting override from Before's complete scene layer", () => {
    const next = doc();
    mutateCompareLightingTarget(next, (target) => {
      target.lighting = { ...target.lighting, ambient: 0.8 };
    });
    expect(next.lighting).toEqual({ ambient: 0.4, preset: "base-lighting" });
    expect(next.compare?.b?.lighting).toEqual({ ambient: 0.8, preset: "base-lighting" });
  });

  it("clears an After lighting override back to Before", () => {
    const next = doc();
    if (next.compare) next.compare.b = { lighting: { ambient: 0.8 } };
    mutateCompareLightingTarget(next, (target) => {
      delete target.lighting;
    });
    expect(next.lighting).toEqual({ ambient: 0.4, preset: "base-lighting" });
    expect(next.compare?.b?.lighting).toBeUndefined();
  });

  it("sets and clears colour without disturbing the device's shadow override", () => {
    const next = doc();
    setCompareDeviceAppearance(next, "d1", "shadow", "long");
    setCompareDeviceAppearance(next, "d1", "colour", "silver");
    expect(next.compare?.b?.deviceAppearance?.d1).toEqual({
      colour: "silver",
      shadow: "long",
    });

    setCompareDeviceAppearance(next, "d1", "colour", "graphite");
    expect(next.compare?.b?.deviceAppearance?.d1).toEqual({ shadow: "long" });
  });

  it("prunes the appearance map after the last override returns to Before", () => {
    const next = doc();
    setCompareDeviceAppearance(next, "d2", "shadow", "none");
    setCompareDeviceAppearance(next, "d2", "shadow", undefined);
    expect(next.compare?.b?.deviceAppearance).toBeUndefined();
  });

  it("prunes comparison media and appearance when a device is removed", () => {
    const next = doc();
    if (next.compare) {
      next.compare.b = {
        media: {
          d1: { src: "assets/after.mp4", kind: "video" },
          d2: { src: "assets/keep.mp4", kind: "video" },
        },
        deviceAppearance: {
          d1: { colour: "silver" },
          d2: { shadow: "none" },
        },
      };
    }
    pruneCompareDeviceTargets(next, "d1");
    expect(next.compare?.b?.media).toEqual({
      d2: { src: "assets/keep.mp4", kind: "video" },
    });
    expect(next.compare?.b?.deviceAppearance).toEqual({ d2: { shadow: "none" } });
  });

  it("duplicates comparison media and appearance for a duplicated device", () => {
    const next = doc();
    if (next.compare) {
      next.compare.b = {
        media: { d1: { src: "assets/after.mp4", kind: "video" } },
        deviceAppearance: { d1: { colour: "silver", shadow: "none" } },
      };
    }
    duplicateCompareDeviceTargets(next, "d1", "d3");
    expect(next.compare?.b?.media?.d3).toEqual({
      src: "assets/after.mp4",
      kind: "video",
    });
    expect(next.compare?.b?.deviceAppearance?.d3).toEqual({
      colour: "silver",
      shadow: "none",
    });
  });

  it("the Manual choice drops the divider keys and leaves the comparison standing", () => {
    const next = doc();
    next.animatedTrack = "compare";
    if (next.compare) {
      next.compare.value = 0.25;
      next.compare.mask = { type: "linear", angleDeg: 90 };
      next.compare.chrome = { chips: true };
      next.compare.track = {
        keys: [
          { id: "k1", tMs: 0, pose: { value: 1 } },
          { id: "k2", tMs: 2000, pose: { value: 0 } },
        ],
        segments: [{ from: "k1", to: "k2", ease: "inOutCubic" }],
      };
    }
    clearCompareTrack(next);
    expect(next.compare?.track).toBeUndefined();
    expect(next.compare?.value).toBe(0.25);
    expect(next.compare?.mask).toEqual({ type: "linear", angleDeg: 90 });
    expect(next.compare?.chrome).toEqual({ chips: true });
    expect(next.compare?.b).toEqual({});
    expect(next.animatedTrack).toBe("compare");
  });

  it("leaves a scene with no comparison alone", () => {
    const next = doc();
    next.compare = undefined;
    expect(() => clearCompareTrack(next)).not.toThrow();
    expect(next.compare).toBeUndefined();
  });
});
