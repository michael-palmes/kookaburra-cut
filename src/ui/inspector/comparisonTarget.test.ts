import { describe, expect, it } from "vitest";
import type { SceneDoc, SceneDocCompare } from "../../engine/sceneDocSchema";
import {
  clearCompareTrack,
  duplicateCompareDeviceTargets,
  mutateCompareBackgroundTarget,
  mutateCompareLightingTarget,
  nearestCompareKey,
  pruneCompareDeviceTargets,
  setCompareDeviceAppearance,
  setCompareDividerAngle,
  setCompareDividerValue,
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

const keyed = (): SceneDocCompare => ({
  value: 0.25,
  mask: { type: "linear", angleDeg: 90 },
  track: {
    keys: [
      { id: "k1", tMs: 0, pose: { value: 1 } },
      { id: "k2", tMs: 1000, pose: { value: 0.5, angleDeg: 120 } },
      { id: "k3", tMs: 2000, pose: { value: 0 } },
    ],
    segments: [{ from: "k1", to: "k2", ease: "inOutCubic" }],
  },
});

const keyedFlat = (): SceneDocCompare => {
  const compare = keyed();
  for (const key of compare.track?.keys ?? []) key.pose = { value: key.pose.value };
  return compare;
};

describe("the divider key under the playhead", () => {
  it("picks the key nearest in time, before or after the playhead", () => {
    const keys = keyed().track?.keys;
    expect(nearestCompareKey(keys, 0)?.id).toBe("k1");
    expect(nearestCompareKey(keys, 400)?.id).toBe("k1");
    expect(nearestCompareKey(keys, 600)?.id).toBe("k2");
    expect(nearestCompareKey(keys, 1900)?.id).toBe("k3");
    expect(nearestCompareKey(keys, 9000)?.id).toBe("k3");
  });

  it("gives a tie to the earlier key, whatever order the track lists them in", () => {
    const keys = keyed().track?.keys ?? [];
    expect(nearestCompareKey(keys, 500)?.id).toBe("k1");
    expect(nearestCompareKey([...keys].reverse(), 500)?.id).toBe("k1");
    expect(nearestCompareKey([...keys].reverse(), 1500)?.id).toBe("k2");
  });

  it("has no key to edit without a track", () => {
    expect(nearestCompareKey(undefined, 0)).toBeNull();
    expect(nearestCompareKey([], 500)).toBeNull();
  });
});

describe("the divider and angle fields", () => {
  it("writes the nearest key's value, keeping its id, time and angle", () => {
    const compare = keyed();
    setCompareDividerValue(compare, 900, 0.8);
    expect(compare.track?.keys[1]).toEqual({
      id: "k2",
      tMs: 1000,
      pose: { value: 0.8, angleDeg: 120 },
    });
    expect(compare.value).toBe(0.25);
    expect(compare.track?.keys.map((k) => k.pose.value)).toEqual([1, 0.8, 0]);
  });

  it("writes the nearest key's angle alone once a key already carries one", () => {
    const compare = keyed();
    setCompareDividerAngle(compare, 100, 45);
    expect(compare.track?.keys[0]).toEqual({ id: "k1", tMs: 0, pose: { value: 1, angleDeg: 45 } });
    expect(compare.track?.keys.map((k) => k.pose.angleDeg)).toEqual([45, 120, undefined]);
    expect(compare.mask).toEqual({ type: "linear", angleDeg: 90 });
  });

  it("tilts every key AND the mask on the first angle write of an angle-free track", () => {
    const compare = keyedFlat();
    setCompareDividerAngle(compare, 100, 45);
    expect(compare.track?.keys).toEqual([
      { id: "k1", tMs: 0, pose: { value: 1, angleDeg: 45 } },
      { id: "k2", tMs: 1000, pose: { value: 0.5, angleDeg: 45 } },
      { id: "k3", tMs: 2000, pose: { value: 0, angleDeg: 45 } },
    ]);
    expect(compare.mask).toEqual({ type: "linear", angleDeg: 45 });
  });

  it("turns the second write on that track into a per-key rotation", () => {
    const compare = keyedFlat();
    setCompareDividerAngle(compare, 100, 45);
    setCompareDividerAngle(compare, 1900, 135);
    expect(compare.track?.keys.map((k) => k.pose.angleDeg)).toEqual([45, 45, 135]);
    expect(compare.mask).toEqual({ type: "linear", angleDeg: 45 });
  });

  it("never spreads a value write across the track", () => {
    const compare = keyedFlat();
    setCompareDividerValue(compare, 100, 0.8);
    expect(compare.track?.keys.map((k) => k.pose.value)).toEqual([0.8, 0.5, 0]);
    expect(compare.track?.keys.every((k) => k.pose.angleDeg === undefined)).toBe(true);
    expect(compare.mask).toEqual({ type: "linear", angleDeg: 90 });
  });

  it("falls back to the static value and mask angle with no keys", () => {
    const compare: SceneDocCompare = {};
    setCompareDividerValue(compare, 500, 0.7);
    setCompareDividerAngle(compare, 500, 30);
    expect(compare.value).toBe(0.7);
    expect(compare.mask).toEqual({ type: "linear", angleDeg: 30 });
    expect(compare.track).toBeUndefined();
  });

  it("keeps the mask type when the static angle changes", () => {
    const compare: SceneDocCompare = { mask: { type: "circle", softness: 0.05 } };
    setCompareDividerAngle(compare, 0, 200);
    expect(compare.mask).toEqual({ type: "circle", softness: 0.05, angleDeg: 200 });
  });
});
