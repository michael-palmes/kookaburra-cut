import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import {
  activeCompareSide,
  compareEditTarget,
  compareThemeIdForSide,
  deviceSideRouting,
  hasComparison,
  setThemeForSide,
} from "./compareSideRouting";

const doc = (): SceneDoc => ({
  version: 1,
  themeId: "night-studio",
  devices: [
    {
      id: "d1",
      model: "android",
      colour: "graphite",
      shadow: "soft",
      media: { src: "assets/before.mp4", kind: "video" },
    },
    {
      id: "d2",
      model: "android",
      colour: "silver",
      media: { src: "assets/still.png", kind: "image" },
    },
  ],
  compare: { b: {} },
});

const plain = (): SceneDoc => {
  const next = doc();
  next.compare = undefined;
  return next;
};

describe("which side the inspectors edit", () => {
  it("offers a side only where the scene has a comparison", () => {
    expect(hasComparison(doc())).toBe(true);
    expect(hasComparison(plain())).toBe(false);
    expect(hasComparison(undefined)).toBe(false);
  });

  it("falls back to Before wherever the comparison has gone, so After can never repoint it", () => {
    expect(activeCompareSide(doc(), "b")).toBe("b");
    expect(activeCompareSide(plain(), "b")).toBe("a");
    expect(activeCompareSide(undefined, "b")).toBe("a");
    expect(activeCompareSide(doc(), "a")).toBe("a");
  });

  it("names the background and lighting write target from the active side", () => {
    expect(compareEditTarget(doc(), "a")).toBe("scene");
    expect(compareEditTarget(doc(), "b")).toBe("compareB");
    expect(compareEditTarget(plain(), "b")).toBe("scene");
  });
});

describe("theme routing", () => {
  it("shows the scene theme for Before and the override for After", () => {
    const next = doc();
    expect(compareThemeIdForSide(next, "a")).toBe("night-studio");
    expect(compareThemeIdForSide(next, "b")).toBe("");
    if (next.compare) next.compare.b = { themeId: "launch-glow" };
    expect(compareThemeIdForSide(next, "b")).toBe("launch-glow");
    expect(compareThemeIdForSide(next, "a")).toBe("night-studio");
  });

  it("writes each side independently and clears the After override back to Before", () => {
    const next = doc();
    setThemeForSide(next, "b", "launch-glow");
    expect(next.themeId).toBe("night-studio");
    expect(next.compare?.b?.themeId).toBe("launch-glow");

    setThemeForSide(next, "b", "");
    expect(next.compare?.b?.themeId).toBeUndefined();
    expect(next.themeId).toBe("night-studio");

    setThemeForSide(next, "a", "obsidian");
    expect(next.themeId).toBe("obsidian");
    expect(next.compare?.b?.themeId).toBeUndefined();
  });

  it("sends a stale After write to the scene when the comparison is gone", () => {
    const next = plain();
    setThemeForSide(next, "b", "launch-glow");
    expect(next.themeId).toBe("launch-glow");
    expect(next.compare).toBeUndefined();
  });
});

describe("device routing", () => {
  it("edits the device itself on Before", () => {
    const routing = deviceSideRouting(doc(), "d1", "a");
    expect(routing).toEqual({
      media: { src: "assets/before.mp4", kind: "video" },
      inheritsMedia: false,
      colour: "graphite",
      shadow: "soft",
      overridesAppearance: false,
      mediaTarget: "device",
      editVideoTarget: "device",
    });
  });

  it("reads After through to Before until it owns an override", () => {
    const next = doc();
    const inherited = deviceSideRouting(next, "d1", "b");
    expect(inherited.media).toEqual({ src: "assets/before.mp4", kind: "video" });
    expect(inherited.inheritsMedia).toBe(true);
    expect(inherited.colour).toBe("graphite");
    expect(inherited.overridesAppearance).toBe(false);

    if (next.compare) {
      next.compare.b = {
        media: { d1: { src: "assets/after.mp4", kind: "video" } },
        deviceAppearance: { d1: { colour: "silver" } },
      };
    }
    const overridden = deviceSideRouting(next, "d1", "b");
    expect(overridden.media).toEqual({ src: "assets/after.mp4", kind: "video" });
    expect(overridden.inheritsMedia).toBe(false);
    expect(overridden.colour).toBe("silver");
    expect(overridden.shadow).toBe("soft");
    expect(overridden.overridesAppearance).toBe(true);
    expect(deviceSideRouting(next, "d1", "a").media).toEqual({
      src: "assets/before.mp4",
      kind: "video",
    });
  });

  it("targets the After override for every media action, inherited video included", () => {
    const next = doc();
    expect(deviceSideRouting(next, "d1", "b")).toMatchObject({
      mediaTarget: "compareDevice",
      editVideoTarget: "compareDevice",
    });
    expect(deviceSideRouting(next, "d2", "b")).toMatchObject({
      mediaTarget: "compareDevice",
      editVideoTarget: "compareDevice",
    });
  });

  it("routes an image to the editor too, but has nothing to edit for a device that is no longer in the scene", () => {
    expect(deviceSideRouting(doc(), "d2", "a").editVideoTarget).toBe("device");
    expect(deviceSideRouting(doc(), "gone", "b")).toMatchObject({
      media: undefined,
      inheritsMedia: true,
      colour: undefined,
      overridesAppearance: false,
      editVideoTarget: null,
    });
  });
});
