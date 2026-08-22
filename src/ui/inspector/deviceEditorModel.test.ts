import { describe, expect, it } from "vitest";
import type {
  SceneDoc,
  SceneDocDeviceLayout,
  SceneDocDeviceSpec,
} from "../../engine/sceneDocSchema";
import {
  changeDeviceModel,
  changeSceneDeviceModel,
  compatibleDeviceColour,
  deviceSelectionFallback,
  deviceSelectionOwnsAction,
  duplicateDevice,
  removeDevice,
  replaceDeviceLayoutPreset,
  replaceDeviceMedia,
  resetAllDeviceLayoutDeltas,
  resetDeviceLayoutDelta,
  setDeviceRotationPose,
} from "./deviceEditorModel";

describe("device editor model", () => {
  it("keeps a finish supported by the new model and preserves every other device field", () => {
    const device: SceneDocDeviceSpec = {
      id: "d1",
      model: "iphone-17-pro",
      colour: "silver",
      media: { src: "assets/demo.mp4", kind: "video", startMs: 120 },
      placement: {
        position: [1, -0.2, 0.4],
        rotationDeg: [3, 12, -2],
        scale: 1.15,
        ground: true,
      },
      motion: { preset: "float", amplitude: 0.2, hz: 0.5 },
      shadow: "long",
      lidDeg: 74,
    };

    expect(changeDeviceModel(device, "macbook-pro-16")).toEqual({
      ...device,
      model: "macbook-pro-16",
    });
    expect(device.model).toBe("iphone-17-pro");
  });

  it("keeps a valid custom finish exactly and defaults only an incompatible finish", () => {
    expect(compatibleDeviceColour("android", "custom:#A1b2C3")).toBe("custom:#A1b2C3");
    expect(compatibleDeviceColour("android", "deep-blue")).toBe("graphite");
    expect(compatibleDeviceColour("android", "custom:#12345g")).toBe("graphite");
    expect(compatibleDeviceColour("iphone-17-pro", undefined)).toBe("silver");
  });

  it("changes only the requested model while retaining document-owned layout deltas", () => {
    const doc = {
      version: 1,
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          colour: "deep-blue",
          media: { src: "assets/screen.png", kind: "image" as const },
          placement: { position: [1, 0, 0] as [number, number, number] },
          motion: { preset: "float" as const },
          shadow: "sun" as const,
        },
        { id: "d2", model: "android", colour: "white" },
      ],
      deviceLayout: {
        preset: "row" as const,
        devices: { d1: { offset: [0.2, 0.1, 0] as [number, number, number], scale: 1.2 } },
      },
    } satisfies SceneDoc;
    const layout = doc.deviceLayout;

    expect(changeSceneDeviceModel(doc, "d1", "macbook-pro-16")).toBe(true);
    expect(doc.devices[0]).toEqual({
      id: "d1",
      model: "macbook-pro-16",
      colour: "silver",
      media: { src: "assets/screen.png", kind: "image" },
      placement: { position: [1, 0, 0] },
      motion: { preset: "float" },
      shadow: "sun",
    });
    expect(doc.devices[1]).toEqual({ id: "d2", model: "android", colour: "white" });
    expect(doc.deviceLayout).toBe(layout);
  });

  it("can apply one compatible model change to every device", () => {
    const doc = {
      version: 1,
      devices: [
        { id: "d1", model: "iphone-17-pro", colour: "silver" },
        { id: "d2", model: "android", colour: "custom:#123456" },
      ],
    };

    expect(changeSceneDeviceModel(doc, "d1", "macbook-pro-16", true)).toBe(true);
    expect(doc.devices).toEqual([
      { id: "d1", model: "macbook-pro-16", colour: "silver" },
      { id: "d2", model: "macbook-pro-16", colour: "custom:#123456" },
    ]);
  });

  it("does not write a no-op model choice or apply all from a stale source", () => {
    const doc = {
      version: 1,
      devices: [
        { id: "d1", model: "iphone-17-pro", colour: "silver" },
        { id: "d2", model: "iphone-17-pro" },
      ],
    } satisfies SceneDoc;
    const first = doc.devices[0];
    const second = doc.devices[1];

    expect(changeSceneDeviceModel(doc, "d1", "iphone-17-pro")).toBe(false);
    expect(doc.devices[0]).toBe(first);
    expect(changeSceneDeviceModel(doc, "d2", "iphone-17-pro")).toBe(false);
    expect(doc.devices[1]).toBe(second);
    expect(changeSceneDeviceModel(doc, "missing", "android", true)).toBe(false);
    expect(doc.devices).toEqual([
      { id: "d1", model: "iphone-17-pro", colour: "silver" },
      { id: "d2", model: "iphone-17-pro" },
    ]);
  });

  it("duplicates a complete device with the existing mirrored placement convention", () => {
    const doc = {
      version: 1,
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          colour: "silver",
          media: { src: "assets/demo.mp4", kind: "video" as const },
          placement: {
            position: [0.6, -0.3, 0.2] as [number, number, number],
            rotationDeg: [4, 18, -2] as [number, number, number],
            scale: 1.1,
          },
          motion: { preset: "turntable" as const },
          shadow: "long" as const,
        },
      ],
      deviceLayout: {
        preset: "row" as const,
        devices: { d1: { offset: [0.2, 0.1, -0.3] as [number, number, number], scale: 1.2 } },
      },
      compare: {
        b: {
          media: {
            d1: { src: "assets/after.mp4", kind: "video" as const, startMs: 450 },
          },
          deviceAppearance: { d1: { colour: "black", shadow: "long" as const } },
        },
      },
    } satisfies SceneDoc;

    expect(duplicateDevice(doc, "d1")).toBe("d2");
    expect(doc.devices?.[1]).toEqual({
      ...doc.devices?.[0],
      id: "d2",
      placement: {
        position: [-0.6, -0.3, 0.2],
        rotationDeg: [4, -18, -2],
        scale: 1.1,
      },
    });
    const mutated = doc as SceneDoc;
    expect(mutated.deviceLayout?.devices?.d2).toEqual({
      offset: [0.2, 0.1, -0.3],
      scale: 1.2,
    });
    expect(mutated.deviceLayout?.devices?.d2).not.toBe(mutated.deviceLayout?.devices?.d1);
    expect(mutated.compare?.b?.media?.d2).toEqual({
      src: "assets/after.mp4",
      kind: "video",
      startMs: 450,
    });
    expect(mutated.compare?.b?.media?.d2).not.toBe(mutated.compare?.b?.media?.d1);
    expect(mutated.compare?.b?.deviceAppearance?.d2).toEqual({ colour: "black", shadow: "long" });
    expect(mutated.compare?.b?.deviceAppearance?.d2).not.toBe(
      mutated.compare?.b?.deviceAppearance?.d1,
    );
  });

  it("applies visual rotation poses to the active placement surface", () => {
    const laidOut = {
      version: 1,
      devices: [{ id: "d1", model: "iphone-17-pro", placement: { rotationDeg: [2, 4, 6] } }],
      deviceLayout: { preset: "row" as const, devices: { d1: { offset: [0.2, 0, 0] } } },
    } satisfies SceneDoc;
    expect(setDeviceRotationPose(laidOut, "d1", [-6, 14, 0])).toBe(true);
    expect(laidOut.deviceLayout.devices?.d1).toEqual({
      offset: [0.2, 0, 0],
      rotationDeg: [-6, 14, 0],
    });
    expect(laidOut.devices[0].placement?.rotationDeg).toEqual([2, 4, 6]);

    const free = {
      version: 1,
      devices: [{ id: "d1", model: "iphone-17-pro", placement: { position: [1, 2, 3] } }],
    } satisfies SceneDoc;
    expect(setDeviceRotationPose(free, "d1", [-6, -14, 0])).toBe(true);
    expect(free.devices[0].placement).toEqual({
      position: [1, 2, 3],
      rotationDeg: [-6, -14, 0],
    });
    expect(setDeviceRotationPose(free, "missing", [0, 0, 0])).toBe(false);
  });

  it("does not reject a pending minted selection before the rendered list catches up", () => {
    const minted = { sceneIndex: 2, deviceId: "d2" };

    expect(deviceSelectionFallback(minted, 2, ["d1"], false)).toBeNull();
    expect(deviceSelectionFallback(minted, 2, ["d1", "d2"], true)).toBeNull();
    expect(deviceSelectionFallback({ sceneIndex: 2, deviceId: "gone" }, 2, ["d1"], true)).toBe(
      "d1",
    );
    expect(deviceSelectionFallback({ sceneIndex: 1, deviceId: "d1" }, 2, ["d2"], false)).toBe("d2");
  });

  it("keeps async structural navigation owned by its original device selection", () => {
    expect(deviceSelectionOwnsAction({ sceneIndex: 2, deviceId: "d1" }, 2, "d1")).toBe(true);
    expect(deviceSelectionOwnsAction({ sceneIndex: 2, deviceId: "d2" }, 2, "d1")).toBe(false);
    expect(deviceSelectionOwnsAction({ sceneIndex: 1, deviceId: "d1" }, 2, "d1")).toBe(false);
    expect(deviceSelectionOwnsAction(null, 2, "d1")).toBe(false);
  });

  it("removes side-table references and preserves a follow-media duration as Manual", () => {
    const doc = {
      version: 1,
      duration: { mode: "follow-media" as const, sourceDeviceId: "d1" },
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          media: { src: "assets/demo.mp4", kind: "video" as const },
        },
        { id: "d2", model: "android" },
      ],
      deviceLayout: {
        preset: "row" as const,
        devices: { d1: { scale: 1.2 }, d2: { scale: 0.9 } },
      },
      compare: {
        b: {
          media: { d1: { src: "assets/after.mp4", kind: "video" as const } },
          deviceAppearance: { d1: { colour: "black" } },
        },
      },
    };

    expect(removeDevice(doc, "d1")).toBe("d2");
    expect(doc.devices).toEqual([{ id: "d2", model: "android" }]);
    expect(doc.deviceLayout.devices).toEqual({ d2: { scale: 0.9 } });
    expect(doc.compare.b?.media).toBeUndefined();
    expect(doc.compare.b?.deviceAppearance).toBeUndefined();
    expect(doc.duration).toEqual({ mode: "manual" });
  });

  it("keeps the current scene length by making an active video pin Manual before re-sync", () => {
    const doc = {
      version: 1,
      duration: { mode: "follow-media" as const, sourceDeviceId: "d1" },
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          media: { src: "assets/old.mp4", kind: "video" as const, startMs: 200 },
        },
        {
          id: "d2",
          model: "android",
          media: { src: "assets/other.mp4", kind: "video" as const },
        },
      ],
    } satisfies SceneDoc;

    expect(replaceDeviceMedia(doc, "d1", { src: "assets/still.png", kind: "image" })).toBe(true);
    expect(doc.devices[0].media).toEqual({
      src: "assets/still.png",
      kind: "image",
      startMs: 200,
    });
    expect(doc.duration).toEqual({ mode: "manual" });
  });

  it("does not disturb an unrelated device or video-window duration pin", () => {
    const otherDevice = {
      version: 1,
      duration: { mode: "follow-media" as const, sourceDeviceId: "d2" },
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          media: { src: "assets/old.mp4", kind: "video" as const },
        },
        { id: "d2", model: "android", media: { src: "assets/other.mp4", kind: "video" as const } },
      ],
    } satisfies SceneDoc;
    const videoWindow: SceneDoc = {
      ...structuredClone(otherDevice),
      duration: { mode: "follow-media", source: "videoWindow" },
    };

    expect(replaceDeviceMedia(otherDevice, "d1", { src: "assets/still.png", kind: "image" })).toBe(
      true,
    );
    expect(otherDevice.duration).toEqual({ mode: "follow-media", sourceDeviceId: "d2" });
    expect(replaceDeviceMedia(videoWindow, "d1", { src: "assets/still.png", kind: "image" })).toBe(
      true,
    );
    expect(videoWindow.duration).toEqual({ mode: "follow-media", source: "videoWindow" });
  });

  it("retains follow-media when the comparison side still drives the targeted device", () => {
    const doc = {
      version: 1,
      duration: { mode: "follow-media" as const, sourceDeviceId: "d1" },
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          media: { src: "assets/before.mp4", kind: "video" as const },
        },
      ],
      compare: {
        b: { media: { d1: { src: "assets/after.mp4", kind: "video" as const } } },
      },
    } satisfies SceneDoc;

    expect(replaceDeviceMedia(doc, "d1", { src: "assets/still.png", kind: "image" })).toBe(true);
    expect(doc.duration).toEqual({ mode: "follow-media", sourceDeviceId: "d1" });
  });

  it("pins a replacement video unless the duration is already Manual", () => {
    const follow = {
      version: 1,
      duration: { mode: "follow-media" as const },
      devices: [{ id: "d1", model: "iphone-17-pro" }],
    } satisfies SceneDoc;
    const manual = {
      version: 1,
      duration: { mode: "manual" as const },
      devices: [{ id: "d1", model: "iphone-17-pro" }],
    } satisfies SceneDoc;

    replaceDeviceMedia(follow, "d1", { src: "assets/new.mp4", kind: "video" });
    replaceDeviceMedia(manual, "d1", { src: "assets/new.mp4", kind: "video" });

    expect(follow.duration).toEqual({ mode: "follow-media", sourceDeviceId: "d1" });
    expect(manual.duration).toEqual({ mode: "manual" });
  });

  it("replaces a layout preset while retaining Gap and every device delta", () => {
    const layout: SceneDocDeviceLayout = {
      preset: "row",
      gap: 0.72,
      devices: {
        d1: { offset: [0.2, 0.1, -0.3], scale: 1.2 },
        d2: { rotationDeg: [2, 8, -1] },
      },
    };

    const next = replaceDeviceLayoutPreset(layout, "hero");

    expect(next).toEqual({ ...layout, preset: "hero" });
    expect(next.devices).toBe(layout.devices);
    expect(layout.preset).toBe("row");
  });

  it("creates a layout when choosing the first preset", () => {
    expect(replaceDeviceLayoutPreset(undefined, "toe-in")).toEqual({ preset: "toe-in" });
  });

  it("resets one device delta without changing the remaining layout tuning", () => {
    const layout: SceneDocDeviceLayout = {
      preset: "arc",
      gap: 0.4,
      devices: {
        d1: { offset: [0.3, 0, 0] },
        d2: { scale: 0.9 },
      },
    };

    expect(resetDeviceLayoutDelta(layout, "d1")).toEqual({
      preset: "arc",
      gap: 0.4,
      devices: { d2: { scale: 0.9 } },
    });
    expect(layout.devices).toHaveProperty("d1");
  });

  it("removes an empty delta map after resetting its final device", () => {
    const layout: SceneDocDeviceLayout = {
      preset: "cascade",
      gap: 0.2,
      devices: { d1: { rotationDeg: [0, 10, 0] } },
    };

    expect(resetDeviceLayoutDelta(layout, "d1")).toEqual({
      preset: "cascade",
      gap: 0.2,
    });
    expect(resetDeviceLayoutDelta(layout, "missing")).toBe(layout);
  });

  it("resets every device delta while retaining the preset and Gap", () => {
    const layout: SceneDocDeviceLayout = {
      preset: "depth-pair",
      gap: -0.1,
      devices: {
        d1: { offset: [0, 0, 0.5] },
        d2: { scale: 1.1 },
      },
    };

    expect(resetAllDeviceLayoutDeltas(layout)).toEqual({
      preset: "depth-pair",
      gap: -0.1,
    });
    expect(layout.devices).toHaveProperty("d1");
    expect(resetAllDeviceLayoutDeltas({ preset: "row" })).toEqual({ preset: "row" });
  });
});
