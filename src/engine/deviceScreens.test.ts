import { describe, expect, it } from "vitest";
import {
  compareSlotMedia,
  deviceHasFollowVideo,
  deviceSlotMedia,
  deviceVideoSources,
  setCompareSlotMedia,
  setDeviceSlotMedia,
} from "./deviceScreens";
import { deriveCompareBDoc } from "./sceneCompare";
import { applyEditRepoint, followMediaSources } from "./sceneDoc";
import { parseSceneDoc, type SceneDoc } from "./sceneDocSchema";

const video = (src: string) => ({ src, kind: "video" as const });

function duo(): SceneDoc {
  return {
    version: 1,
    devices: [
      { id: "d1", model: "iphone-duo", media: video("in.mp4"), coverMedia: video("out.mp4") },
      { id: "d2", model: "iphone-17-pro", media: video("phone.mp4") },
    ],
    duration: { mode: "follow-media" },
  };
}

describe("device screen slots", () => {
  it("reads and writes each display without touching the other", () => {
    const device = duo().devices?.[0];
    if (!device) throw new Error("fixture");
    expect(deviceSlotMedia(device, "main")?.src).toBe("in.mp4");
    expect(deviceSlotMedia(device, "cover")?.src).toBe("out.mp4");
    setDeviceSlotMedia(device, "cover", undefined);
    expect(device.coverMedia).toBeUndefined();
    expect(device.media?.src).toBe("in.mp4");
  });

  it("mutates side B in place and prunes an emptied map", () => {
    const doc: SceneDoc = { ...duo(), compare: { b: {} } };
    const side = doc.compare?.b;
    setCompareSlotMedia(doc, "d1", "cover", video("after-out.mp4"));
    // Callers hold `compare.b`, so the write must land on that same object.
    expect(side?.coverMedia?.d1.src).toBe("after-out.mp4");
    expect(compareSlotMedia(doc, "d1", "main")).toBeUndefined();
    setCompareSlotMedia(doc, "d1", "cover", undefined);
    expect(side && "coverMedia" in side).toBe(false);
  });

  it("is inert without a compare block", () => {
    const doc = duo();
    setCompareSlotMedia(doc, "d1", "cover", video("x.mp4"));
    expect(doc.compare).toBeUndefined();
  });

  it("follows every video a device plays, legacy order first", () => {
    const doc: SceneDoc = {
      ...duo(),
      compare: {
        b: { media: { d1: video("after-in.mp4") }, coverMedia: { d1: video("after-out.mp4") } },
      },
    };
    const device = doc.devices?.[0];
    if (!device) throw new Error("fixture");
    expect(deviceVideoSources(doc, device)).toEqual([
      "in.mp4",
      "after-in.mp4",
      "out.mp4",
      "after-out.mp4",
    ]);
    expect(followMediaSources(doc)).toEqual([
      "in.mp4",
      "after-in.mp4",
      "out.mp4",
      "after-out.mp4",
      "phone.mp4",
    ]);
  });

  it("counts a cover-only video as the device's follow source", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [{ id: "d1", model: "iphone-duo", coverMedia: video("out.mp4") }],
    };
    expect(deviceHasFollowVideo(doc, "d1")).toBe(true);
    expect(deviceHasFollowVideo(doc, "gone")).toBe(false);
  });
});

describe("side B and the second display", () => {
  it("survives a parse, and a malformed entry drops alone", () => {
    const parsed = parseSceneDoc(
      {
        version: 1,
        devices: [{ id: "d1", model: "iphone-duo", coverMedia: video("out.mp4") }],
        compare: {
          b: { coverMedia: { d1: video("after-out.mp4"), d9: { src: "", kind: "video" } } },
        },
      },
      "test",
    );
    expect(parsed?.devices?.[0].coverMedia?.src).toBe("out.mp4");
    expect(parsed?.compare?.b?.coverMedia).toEqual({ d1: video("after-out.mp4") });
  });

  it("derives the After doc with both displays overridden", () => {
    const b = deriveCompareBDoc({
      ...duo(),
      compare: { b: { coverMedia: { d1: video("after-out.mp4") } } },
    });
    expect(b?.devices?.[0].coverMedia?.src).toBe("after-out.mp4");
    expect(b?.devices?.[0].media?.src).toBe("in.mp4");
  });

  it("re-points an edit render at the display it came from", () => {
    const doc: SceneDoc = { ...duo(), compare: { b: {} } };
    const cover = applyEditRepoint(doc, "deviceCover", "assets/out-edited.mp4", "d1");
    expect(cover?.devices?.[0].coverMedia?.src).toBe("assets/out-edited.mp4");
    expect(cover?.devices?.[0].media?.src).toBe("in.mp4");
    // After inherits Before's outside media, so the edit materialises the override rather than re-pointing Before.
    const after = applyEditRepoint(doc, "compareDeviceCover", "assets/out-edited.mp4", "d1");
    expect(after?.compare?.b?.coverMedia?.d1.src).toBe("assets/out-edited.mp4");
    expect(after?.devices?.[0].coverMedia?.src).toBe("out.mp4");
    expect(applyEditRepoint(doc, "deviceCover", "x.mp4", "d2")).toBeNull();
  });
});
