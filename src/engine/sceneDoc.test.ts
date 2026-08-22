import { beforeEach, describe, expect, it, vi } from "vitest";

// media_meta serves scripted lengths per rel; update_project_scene records what the resync wrote.
const lengths = new Map<string, number>();
const written: Array<{ index: number; durationMs: number }> = [];
// The fake workspace the apply-to-all tests write into: sidecars by file, plus the manifest text.
const sidecars = new Map<string, string>();
let manifestText = "";
let holdSceneDocWrites = false;
let activeSceneDocWrites = 0;
let maxActiveSceneDocWrites = 0;
const releaseSceneDocWrites: Array<() => void> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "media_meta") {
      return { durationMs: lengths.get(args?.rel as string) ?? 0 };
    }
    if (cmd === "update_project_scene") {
      written.push({ index: args?.index as number, durationMs: args?.durationMs as number });
      return null;
    }
    if (cmd === "write_scene_doc") {
      activeSceneDocWrites += 1;
      maxActiveSceneDocWrites = Math.max(maxActiveSceneDocWrites, activeSceneDocWrites);
      if (holdSceneDocWrites) {
        await new Promise<void>((resolve) => releaseSceneDocWrites.push(resolve));
      }
      sidecars.set(args?.file as string, args?.text as string);
      activeSceneDocWrites -= 1;
      return null;
    }
    if (cmd === "read_project_manifest_snapshot") return manifestText;
    if (cmd === "write_project_manifest_snapshot") {
      manifestText = args?.text as string;
      return null;
    }
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

import { bindHistory, peekUndo } from "./history";
import type { LoadedProject, ProjectManifest } from "./project";
import {
  applyBackgroundToAllScenes,
  applyEditRepoint,
  followMediaSources,
  resyncFollowMediaDuration,
  writeSceneDoc,
} from "./sceneDoc";
import type { SceneDoc } from "./sceneDocSchema";

const docWith = (parts: Partial<SceneDoc>): SceneDoc => ({ version: 1, ...parts }) as SceneDoc;

const videoDevice = (id: string, src: string) => ({
  id,
  model: "iphone-17-pro",
  media: { src, kind: "video" },
});
const imageDevice = (id: string, src: string) => ({
  id,
  model: "iphone-17-pro",
  media: { src, kind: "image" },
});

describe("writeSceneDoc", () => {
  it("serialises writes to the same sidecar", async () => {
    holdSceneDocWrites = true;
    activeSceneDocWrites = 0;
    maxActiveSceneDocWrites = 0;
    releaseSceneDocWrites.length = 0;
    try {
      const first = writeSceneDoc("project", "scenes/one.tsx", docWith({ name: "First" }));
      await vi.waitFor(() => expect(activeSceneDocWrites).toBe(1));
      const second = writeSceneDoc("project", "scenes/one.tsx", docWith({ name: "Second" }));
      await Promise.resolve();
      expect(activeSceneDocWrites).toBe(1);
      expect(maxActiveSceneDocWrites).toBe(1);

      releaseSceneDocWrites.shift()?.();
      await first;
      await vi.waitFor(() => expect(activeSceneDocWrites).toBe(1));
      releaseSceneDocWrites.shift()?.();
      await second;

      expect(maxActiveSceneDocWrites).toBe(1);
      expect(JSON.parse(sidecars.get("scenes/one.json") ?? "{}").name).toBe("Second");
    } finally {
      holdSceneDocWrites = false;
      for (const release of releaseSceneDocWrites.splice(0)) release();
    }
  });
});

describe("applyEditRepoint (edit-render re-point targeting)", () => {
  const rel = "assets/clip-edited.mp4";

  it("a deviceId re-points that device and no other", () => {
    const doc = docWith({
      devices: [
        videoDevice("d1", "assets/a.mp4"),
        videoDevice("d2", "assets/b.mp4"),
      ] as SceneDoc["devices"],
    });
    const next = applyEditRepoint(doc, "device", rel, "d2");
    expect(next?.devices?.[0]?.media?.src).toBe("assets/a.mp4");
    expect(next?.devices?.[1]?.media?.src).toBe(rel);
  });

  it("no deviceId keeps the legacy first-device behaviour", () => {
    const doc = docWith({
      devices: [
        videoDevice("d1", "assets/a.mp4"),
        videoDevice("d2", "assets/b.mp4"),
      ] as SceneDoc["devices"],
    });
    const next = applyEditRepoint(doc, "device", rel);
    expect(next?.devices?.[0]?.media?.src).toBe(rel);
    expect(next?.devices?.[1]?.media?.src).toBe("assets/b.mp4");
  });

  it("a stale deviceId re-points nothing, never a neighbour", () => {
    const doc = docWith({
      devices: [videoDevice("d1", "assets/a.mp4")] as SceneDoc["devices"],
    });
    expect(applyEditRepoint(doc, "device", rel, "gone")).toBeNull();
  });

  it("an after-device edit creates an override without changing before", () => {
    const doc = docWith({
      devices: [videoDevice("d1", "assets/before.mp4")] as SceneDoc["devices"],
      compare: { b: {} },
    });
    const next = applyEditRepoint(doc, "compareDevice", rel, "d1");
    expect(next?.devices?.[0].media?.src).toBe("assets/before.mp4");
    expect(next?.compare?.b?.media?.d1.src).toBe(rel);
  });

  it("an after-device edit keeps the override's media kind", () => {
    const doc = docWith({
      devices: [imageDevice("d1", "assets/before.png")] as SceneDoc["devices"],
      compare: { b: { media: { d1: { src: "assets/after.mp4", kind: "video" } } } },
    });
    const next = applyEditRepoint(doc, "compareDevice", rel, "d1");
    expect(next?.compare?.b?.media?.d1).toEqual({ src: rel, kind: "video" });
    expect(next?.devices?.[0].media?.kind).toBe("image");
  });

  it("an edited still becomes a video on both device slots (the render is an mp4)", () => {
    const doc = docWith({
      devices: [imageDevice("d1", "assets/shot.png")] as SceneDoc["devices"],
      compare: { b: {} },
    });
    expect(applyEditRepoint(doc, "device", rel, "d1")?.devices?.[0].media).toEqual({
      src: rel,
      kind: "video",
    });
    expect(applyEditRepoint(doc, "compareDevice", rel, "d1")?.compare?.b?.media?.d1).toEqual({
      src: rel,
      kind: "video",
    });
  });

  it("a media-less device and a device-less doc re-point nothing", () => {
    const bare = docWith({
      devices: [{ id: "d1", model: "iphone-17-pro" }] as SceneDoc["devices"],
    });
    expect(applyEditRepoint(bare, "device", rel, "d1")).toBeNull();
    expect(applyEditRepoint(docWith({}), "device", rel)).toBeNull();
  });

  it("background re-points only a video background", () => {
    const video = docWith({
      background: { type: "video", src: "assets/bg.mp4" } as SceneDoc["background"],
    });
    expect(applyEditRepoint(video, "background", rel)?.background).toMatchObject({ src: rel });
    expect(applyEditRepoint(docWith({}), "background", rel)).toBeNull();
  });

  it("videoWindow re-points its media and leaves the doc otherwise untouched", () => {
    const doc = docWith({
      devices: [videoDevice("d1", "assets/a.mp4")] as SceneDoc["devices"],
      videoWindow: { media: { src: "assets/win.mp4" } } as SceneDoc["videoWindow"],
    });
    const next = applyEditRepoint(doc, "videoWindow", rel);
    expect(next?.videoWindow?.media?.src).toBe(rel);
    expect(next?.devices?.[0]?.media?.src).toBe("assets/a.mp4");
    expect(doc.videoWindow?.media?.src).toBe("assets/win.mp4");
  });
});

describe("followMediaSources (the follow-media source rule)", () => {
  it("manual mode and doc-less scenes yield nothing", () => {
    expect(followMediaSources(undefined)).toEqual([]);
    expect(followMediaSources(docWith({ duration: { mode: "manual" } }))).toEqual([]);
  });

  it("a single device video is the source", () => {
    const doc = docWith({
      duration: { mode: "follow-media" },
      devices: [videoDevice("d1", "assets/a.mp4")] as SceneDoc["devices"],
    });
    expect(followMediaSources(doc)).toEqual(["assets/a.mp4"]);
  });

  it("unpinned multi-video docs return every device video (longest wins downstream)", () => {
    const doc = docWith({
      duration: { mode: "follow-media" },
      devices: [
        videoDevice("d1", "assets/a.mp4"),
        videoDevice("d2", "assets/b.mp4"),
      ] as SceneDoc["devices"],
    });
    expect(followMediaSources(doc)).toEqual(["assets/a.mp4", "assets/b.mp4"]);
  });

  it("a matching sourceDeviceId pins one device; a stale pin falls back to all", () => {
    const devices = [
      videoDevice("d1", "assets/a.mp4"),
      videoDevice("d2", "assets/b.mp4"),
    ] as SceneDoc["devices"];
    const pinned = docWith({
      duration: { mode: "follow-media", sourceDeviceId: "d2" },
      devices,
    });
    expect(followMediaSources(pinned)).toEqual(["assets/b.mp4"]);
    const stale = docWith({
      duration: { mode: "follow-media", sourceDeviceId: "gone" },
      devices,
    });
    expect(followMediaSources(stale)).toEqual(["assets/a.mp4", "assets/b.mp4"]);
  });

  it("a pinned image device falls through to the videoWindow-then-background chain", () => {
    const doc = docWith({
      duration: { mode: "follow-media", sourceDeviceId: "d1" },
      devices: [
        imageDevice("d1", "assets/still.png"),
        videoDevice("d2", "assets/b.mp4"),
      ] as SceneDoc["devices"],
      background: { type: "video", src: "assets/bg.mp4" } as SceneDoc["background"],
    });
    expect(followMediaSources(doc)).toEqual(["assets/bg.mp4"]);
  });

  it("a comparison's after-side videos count beside each device's own", () => {
    const doc = docWith({
      duration: { mode: "follow-media" },
      devices: [
        videoDevice("d1", "assets/a.mp4"),
        videoDevice("d2", "assets/b.mp4"),
      ] as SceneDoc["devices"],
      compare: { b: { media: { d2: { src: "assets/after.mp4", kind: "video" } } } },
    });
    expect(followMediaSources(doc)).toEqual(["assets/a.mp4", "assets/b.mp4", "assets/after.mp4"]);
    const pinned = docWith({
      duration: { mode: "follow-media", sourceDeviceId: "d2" },
      devices: [
        videoDevice("d1", "assets/a.mp4"),
        videoDevice("d2", "assets/b.mp4"),
      ] as SceneDoc["devices"],
      compare: { b: { media: { d2: { src: "assets/after.mp4", kind: "video" } } } },
    });
    expect(followMediaSources(pinned)).toEqual(["assets/b.mp4", "assets/after.mp4"]);
  });

  it("source videoWindow pins the window; device-less docs fall to the background video", () => {
    const vw = docWith({
      duration: { mode: "follow-media", source: "videoWindow" },
      videoWindow: {
        media: { src: "assets/win.mp4" },
        stage: { type: "color", color: "#000" },
        radius: "macos",
      } as SceneDoc["videoWindow"],
    });
    expect(followMediaSources(vw)).toEqual(["assets/win.mp4"]);
    const bg = docWith({
      duration: { mode: "follow-media" },
      background: { type: "video", src: "assets/bg.mp4" } as SceneDoc["background"],
    });
    expect(followMediaSources(bg)).toEqual(["assets/bg.mp4"]);
  });
});

describe("resyncFollowMediaDuration follows the longest qualifying video", () => {
  beforeEach(() => {
    lengths.clear();
    written.length = 0;
  });

  it("an unpinned comparison follows whichever recording runs longer", async () => {
    lengths.set("assets/a.mp4", 3000);
    lengths.set("assets/b.mp4", 5000);
    const doc = docWith({
      duration: { mode: "follow-media" },
      devices: [
        videoDevice("d1", "assets/a.mp4"),
        videoDevice("d2", "assets/b.mp4"),
      ] as SceneDoc["devices"],
    });
    const result = await resyncFollowMediaDuration("proj", 0, doc, 3000);
    expect(result.wrote).toBe(true);
    expect(written).toEqual([{ index: 0, durationMs: 5000 }]);
  });

  it("a pinned device wins even when the other clip is longer", async () => {
    lengths.set("assets/a.mp4", 3000);
    lengths.set("assets/b.mp4", 5000);
    const doc = docWith({
      duration: { mode: "follow-media", sourceDeviceId: "d1" },
      devices: [
        videoDevice("d1", "assets/a.mp4"),
        videoDevice("d2", "assets/b.mp4"),
      ] as SceneDoc["devices"],
    });
    const result = await resyncFollowMediaDuration("proj", 2, doc, 5000);
    expect(result.wrote).toBe(true);
    expect(written).toEqual([{ index: 2, durationMs: 3000 }]);
  });

  it("three unpinned device videos still follow the longest", async () => {
    lengths.set("assets/a.mp4", 3000);
    lengths.set("assets/b.mp4", 7000);
    lengths.set("assets/c.mp4", 5000);
    const doc = docWith({
      duration: { mode: "follow-media" },
      devices: [
        videoDevice("d1", "assets/a.mp4"),
        videoDevice("d2", "assets/b.mp4"),
        videoDevice("d3", "assets/c.mp4"),
      ] as SceneDoc["devices"],
    });
    const result = await resyncFollowMediaDuration("proj", 1, doc, 3000);
    expect(result.wrote).toBe(true);
    expect(written).toEqual([{ index: 1, durationMs: 7000 }]);
  });

  it("an already-synced duration writes nothing", async () => {
    lengths.set("assets/a.mp4", 4200);
    const doc = docWith({
      duration: { mode: "follow-media" },
      devices: [videoDevice("d1", "assets/a.mp4")] as SceneDoc["devices"],
    });
    const result = await resyncFollowMediaDuration("proj", 0, doc, 4200);
    expect(result.wrote).toBe(false);
    expect(written).toEqual([]);
  });
});

describe("applyBackgroundToAllScenes records the project-wide stamp", () => {
  const background = { type: "color", color: "#101820" } as SceneDoc["background"];
  const backdrop = { type: "floor", color: "#101820" } as SceneDoc["backdrop"];

  const projectWith = (docs: (SceneDoc | undefined)[]): LoadedProject =>
    ({
      id: "ws:demo",
      sceneFiles: docs.map((_, i) => `scenes/0${i + 1}-scene.tsx`),
      sceneDocs: docs,
    }) as unknown as LoadedProject;

  const stamp = () => (JSON.parse(manifestText) as ProjectManifest).appliedBackground;

  beforeEach(() => {
    sidecars.clear();
    manifestText = JSON.stringify({ id: "demo", scenes: [{}, {}] }, null, 2);
    bindHistory(null);
    bindHistory("ws:demo");
  });

  it("stamps the source's blocks and rides one history entry with the scene writes", async () => {
    const source = docWith({ background, backdrop });
    const result = await applyBackgroundToAllScenes(projectWith([source, undefined]), 0, () => {});
    expect(result).toEqual({ applied: 1, failed: 0 });
    expect(stamp()).toEqual({ background, backdrop });
    expect(JSON.parse(sidecars.get("scenes/02-scene.json") as string).background).toEqual(
      background,
    );
    const entry = peekUndo();
    expect(entry?.changes.map((c) => c.kind)).toEqual(["sceneDoc", "manifest"]);
  });

  it("applying a theme-default scene clears an existing stamp", async () => {
    manifestText = JSON.stringify(
      { id: "demo", scenes: [{}, {}], appliedBackground: { background } },
      null,
      2,
    );
    await applyBackgroundToAllScenes(projectWith([docWith({}), undefined]), 0, () => {});
    expect(stamp()).toBeUndefined();
    expect(peekUndo()?.changes.map((c) => c.kind)).toEqual(["sceneDoc", "manifest"]);
  });

  it("a theme-default source with no stamp leaves the manifest untouched", async () => {
    const before = manifestText;
    await applyBackgroundToAllScenes(projectWith([docWith({}), undefined]), 0, () => {});
    expect(manifestText).toBe(before);
    expect(peekUndo()?.changes.map((c) => c.kind)).toEqual(["sceneDoc"]);
  });
});
