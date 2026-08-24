import { describe, expect, it } from "vitest";
import { clipPlaneSize } from "./clipFrame";
import type { SceneDocImageSpec, SceneImageHost } from "./sceneDocSchema";
import { parseSceneDoc, type SceneDocVideoWindow } from "./sceneDocSchema";
import {
  createSceneMedia,
  DEFAULT_SCENE_MEDIA_VIDEO_STAGE_SIZE,
  editSceneDocMedia,
  nextSceneMediaId,
  pinnedFollowMediaEntry,
  resolveSceneDocMedia,
  sampleSceneImageMotion,
  sampleSceneMediaMotion,
  sceneMediaFamily,
  sceneMediaFromLegacy,
  sceneMediaFromVideoWindow,
  sceneMediaInFrame,
  sceneMediaInWorld,
  sceneMediaOverlayPlaced,
  sceneMediaUsesWindowPath,
  VIDEO_WINDOW_MEDIA_ID,
  videoWindowMediaEntry,
  videoWindowScaleToOverlaySize,
  windowOverlayPlaneWidth,
} from "./sceneMedia";
import { sampleVideoWindowMotion } from "./sceneVideoWindow";

/** A legacy `images` entry, the shape the retired image factory built. */
function legacyImage(id: string, src: string, host: SceneImageHost): SceneDocImageSpec {
  return {
    id,
    src,
    host,
    stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
    overlay: { position: [0, 0], size: 0.25, rotationDeg: 0, shape: "none", layer: "above" },
  };
}

/** Any frame rectangle: the fit is a ratio, so the units cancel. */
const FRAME_16_9 = { width: 16, height: 9 };
const FRAME_9_16 = { width: 9, height: 16 };

/** What the legacy VideoWindow renderer sized its plane to. */
function legacyWindowWidth(
  frame: { width: number; height: number },
  scale: number,
  clipAspect: number,
): number {
  return clipPlaneSize(
    "contain",
    { width: frame.width * scale, height: frame.height * scale },
    { width: clipAspect, height: 1 },
  ).width;
}

describe("videoWindowScaleToOverlaySize", () => {
  it("carries the legacy scale straight across, since a windowed entry keeps the window's fit", () => {
    expect(videoWindowScaleToOverlaySize(0.72)).toBe(0.72);
    expect(videoWindowScaleToOverlaySize(0.53)).toBe(0.53);
  });

  it("degrades a missing or out-of-range scale the way normalizeVideoWindow does", () => {
    expect(videoWindowScaleToOverlaySize(undefined)).toBe(0.72);
    expect(videoWindowScaleToOverlaySize(Number.NaN)).toBe(0.72);
    expect(videoWindowScaleToOverlaySize(4)).toBe(1);
    expect(videoWindowScaleToOverlaySize(0)).toBe(0.1);
  });
});

describe("windowOverlayPlaneWidth", () => {
  it("matches the legacy window width at every aspect and every clip shape", () => {
    const cases: [number, number][] = [
      [0.72, 16 / 9],
      [0.72, 21 / 9],
      [0.5, 4 / 3],
      [1, 1],
      [0.3, 9 / 16],
      // The spike fixtures: a 2048x1324 screencast whose sidecar never recorded an aspect.
      [0.68, 2048 / 1324],
      // A macOS window recording, whose EFFECTIVE aspect is the crop's, never the clip's.
      [0.8, 1572 / 894],
    ];
    for (const frame of [FRAME_16_9, FRAME_9_16]) {
      for (const [scale, aspect] of cases) {
        expect(windowOverlayPlaneWidth(scale, frame, aspect)).toBeCloseTo(
          legacyWindowWidth(frame, scale, aspect),
          10,
        );
      }
    }
  });
});

describe("sceneMediaFromVideoWindow", () => {
  const window: SceneDocVideoWindow = {
    media: { src: "assets/screencast.mp4", startMs: 250, loop: true, aspect: 16 / 9 },
    radius: "rounded",
    recording: true,
    border: { enabled: false, color: "#000000", width: 0.01, opacity: 0.5 },
    shadow: { opacity: 0.4, blur: 0.2, offset: [0.1, -0.2] },
    motion: { preset: "drift", amplitude: 6, hz: 0.2 },
    scale: 0.5,
    offset: [0.25, -0.1],
  };

  it("promotes one window-hosted video entry under the rig aim id", () => {
    const entry = sceneMediaFromVideoWindow(window);
    expect(entry.id).toBe(VIDEO_WINDOW_MEDIA_ID);
    expect(entry.kind).toBe("video");
    expect(entry.host).toBe("window");
    expect(entry.src).toBe("assets/screencast.mp4");
    expect(entry.window).toEqual({
      radius: "rounded",
      recording: true,
      border: { enabled: false, color: "#000000", width: 0.01, opacity: 0.5 },
      shadow: { opacity: 0.4, blur: 0.2, offset: [0.1, -0.2] },
    });
    expect(entry.video).toEqual({ startMs: 250, loop: true, aspect: 16 / 9 });
    expect(entry.motion).toEqual({ preset: "drift", amplitude: 6, hz: 0.2 });
  });

  it("converts the placement, doubling the whole-frame offset and staging a sane default", () => {
    const entry = sceneMediaFromVideoWindow(window);
    expect(entry.overlay.position).toEqual([0.5, -0.2]);
    expect(entry.overlay.size).toBe(0.5);
    expect(entry.overlay.layer).toBe("below");
    expect(entry.overlay.rotationDeg).toBe(0);
    expect(entry.stage).toEqual({
      position: [0, 0, 0],
      size: DEFAULT_SCENE_MEDIA_VIDEO_STAGE_SIZE,
      rotationDeg: [0, 0, 0],
    });
  });

  it("fills the window defaults for a bare block", () => {
    const entry = sceneMediaFromVideoWindow({
      media: { src: "assets/bare.mp4" },
    } as SceneDocVideoWindow);
    expect(entry.window).toEqual({ radius: "macos" });
    expect(entry.video).toEqual({});
    expect(entry.overlay.position).toEqual([0, 0]);
    expect(entry.overlay.size).toBe(0.72);
    expect(entry.motion).toBeUndefined();
  });
});

describe("legacy <-> media derivation", () => {
  const doc = parseSceneDoc(
    {
      version: 1,
      images: [
        {
          id: "img1",
          src: "assets/hero.png",
          host: "overlay",
          overlay: { position: [0.2, 0.1], size: 0.4, shape: "circle", layer: "below" },
          motion: { preset: "turntable", degPerSec: 20 },
          castShadow: true,
        },
      ],
      videoWindow: {
        media: { src: "assets/clip.mp4", aspect: 4 / 3 },
        radius: "macos",
        scale: 0.6,
        offset: [0, 0.25],
      },
    },
    "test",
  );

  it("orders the images first, then the promoted window", () => {
    expect(doc?.media?.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "image:img1",
      "video:videoWindow",
    ]);
  });

  it("keeps the legacy blocks enumerable and the derived array out of the file", () => {
    expect(Object.keys(JSON.parse(JSON.stringify(doc ?? {})))).toEqual([
      "version",
      "images",
      "videoWindow",
    ]);
  });

  it("takes no video window from an image-only doc", () => {
    expect(videoWindowMediaEntry(sceneMediaFromLegacy(doc?.images, undefined))).toBeUndefined();
    expect(sceneMediaFromLegacy(undefined, undefined)).toEqual([]);
  });
});

describe("resolveSceneDocMedia", () => {
  it("derives from the legacy blocks of a clone, which cannot carry the parsed view", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        images: [{ id: "img1", src: "assets/a.png" }],
        videoWindow: { media: { src: "assets/clip.mp4" } },
      },
      "test",
    );
    const clone = structuredClone(doc);
    expect(clone?.media).toBeUndefined();
    expect(resolveSceneDocMedia(clone)).toEqual(doc?.media);
    expect(resolveSceneDocMedia(undefined)).toEqual([]);
  });

  it("prefers an authored media array", () => {
    const media = [createSceneMedia("vid1", "assets/clip.mp4", "video")];
    expect(resolveSceneDocMedia({ media, images: [] })).toEqual(media);
  });
});

describe("createSceneMedia", () => {
  it("matches the legacy image defaults, plus the kind", () => {
    expect(createSceneMedia("img1", "assets/a.png", "image", "overlay")).toEqual({
      ...legacyImage("img1", "assets/a.png", "overlay"),
      kind: "image",
    });
  });

  it("starts a video window-hosted with macOS window chrome at the legacy default size", () => {
    const entry = createSceneMedia("vid1", "assets/clip.mp4", "video");
    expect(entry.host).toBe("window");
    expect(entry.window).toEqual({ radius: "macos" });
    expect(entry.video).toEqual({});
    expect(entry.overlay.size).toBe(0.72);
    expect(entry.overlay.layer).toBe("below");
    expect(entry.stage.size).toBe(DEFAULT_SCENE_MEDIA_VIDEO_STAGE_SIZE);
  });
});

describe("nextSceneMediaId", () => {
  it("mints per kind and never re-mints a live id", () => {
    expect(nextSceneMediaId("image", [])).toBe("img1");
    expect(nextSceneMediaId("video", [])).toBe("vid1");
    expect(nextSceneMediaId("image", ["img1", "img2", "vid1"])).toBe("img3");
    expect(nextSceneMediaId("video", ["img1", "vid1", "vid3"])).toBe("vid2");
    expect(nextSceneMediaId("video", [VIDEO_WINDOW_MEDIA_ID])).toBe("vid1");
  });
});

describe("sampleSceneImageMotion", () => {
  it("keeps absent and explicit static motion exactly neutral on either host", () => {
    const identity = { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, opacity: 1 };

    expect(sampleSceneImageMotion(undefined, "stage", 900)).toEqual(identity);
    expect(sampleSceneImageMotion({ preset: "none" }, "overlay", 900)).toEqual(identity);
  });

  it("maps turntable and float into host-specific coordinate spaces", () => {
    expect(sampleSceneImageMotion({ preset: "turntable" }, "stage", 2000).rotationDeg).toEqual([
      0, 36, 0,
    ]);
    expect(sampleSceneImageMotion({ preset: "turntable" }, "overlay", 2000).rotationDeg).toEqual([
      0, 0, 12.6,
    ]);

    expect(sampleSceneImageMotion({ preset: "float" }, "stage", 625).position[1]).toBeCloseTo(0.12);
    expect(sampleSceneImageMotion({ preset: "float" }, "overlay", 625).position[1]).toBeCloseTo(
      0.03,
    );
  });

  it("samples deterministic host-aware entrance transforms and settles at rest", () => {
    expect(sampleSceneImageMotion({ preset: "tilt-reveal" }, "stage", 500)).toEqual({
      position: [0, 0, 0],
      rotationDeg: [-1.75, -5, 0],
      scale: 1,
      opacity: 1,
    });
    expect(sampleSceneImageMotion({ preset: "tilt-reveal" }, "overlay", 500)).toEqual({
      position: [0.01, 0, 0],
      rotationDeg: [0, 0, -1.25],
      scale: 0.995,
      opacity: 1,
    });
    expect(sampleSceneImageMotion({ preset: "push-in" }, "stage", 600)).toEqual({
      position: [0, 0, 0],
      rotationDeg: [0, -1, 0],
      scale: 0.9825,
      opacity: 1,
    });
    expect(sampleSceneImageMotion({ preset: "push-in" }, "overlay", 600).scale).toBe(0.9875);
    expect(sampleSceneImageMotion({ preset: "push-in" }, "stage", 1200)).toEqual({
      position: [0, 0, 0],
      rotationDeg: [0, 0, 0],
      scale: 1,
      opacity: 1,
    });
  });

  it("sanitises malformed direct-call numbers without reading another clock", () => {
    expect(
      sampleSceneImageMotion(
        { preset: "float", amplitude: Number.NaN, hz: Number.POSITIVE_INFINITY },
        "stage",
        Number.NaN,
      ),
    ).toEqual({ position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: 1, opacity: 1 });
  });
});

describe("sampleSceneMediaMotion", () => {
  const identity = {
    position: [0, 0, 0],
    rotationDeg: [0, 0, 0],
    scale: 1,
    opacity: 1,
  };

  it("keeps the still family's host-aware presets for an image", () => {
    expect(sampleSceneMediaMotion("image", { preset: "turntable" }, "stage", 2000)).toEqual(
      sampleSceneImageMotion({ preset: "turntable" }, "stage", 2000),
    );
    expect(sampleSceneMediaMotion("image", { preset: "float" }, "overlay", 625)).toEqual(
      sampleSceneImageMotion({ preset: "float" }, "overlay", 625),
    );
  });

  it("keeps the window family's maths for a video, in the shared sample shape", () => {
    for (const preset of ["float", "drift", "tilt-reveal", "push-in"] as const) {
      const window = sampleVideoWindowMotion({ preset }, 700);
      expect(sampleSceneMediaMotion("video", { preset }, "overlay", 700)).toEqual({
        position: [window.posX, window.posY, window.posZ],
        rotationDeg: [(window.rotX * 180) / Math.PI, (window.rotY * 180) / Math.PI, 0],
        scale: window.scale,
        opacity: 1,
      });
    }
  });

  it("leaves a preset the kind never had inert rather than faking it", () => {
    expect(sampleSceneMediaMotion("video", { preset: "turntable" }, "overlay", 2000)).toEqual(
      identity,
    );
    expect(sampleSceneMediaMotion("image", { preset: "drift" }, "stage", 2000)).toEqual(identity);
    expect(sampleSceneMediaMotion("image", undefined, "stage", 2000)).toEqual(identity);
    expect(sampleSceneMediaMotion("video", { preset: "none" }, "overlay", 2000)).toEqual(identity);
  });
});

describe("render families", () => {
  const media = sceneMediaFromLegacy(
    [legacyImage("img1", "assets/a.png", "stage"), legacyImage("img2", "assets/b.png", "overlay")],
    { media: { src: "assets/clip.mp4" }, radius: "macos" },
  );

  it("splits the world from the frame layer, the promoted window going to the world", () => {
    expect(sceneMediaInWorld(media).map((e) => e.id)).toEqual(["img1", VIDEO_WINDOW_MEDIA_ID]);
    expect(sceneMediaInFrame(media).map((e) => e.id)).toEqual(["img2"]);
  });

  it("keeps the two fallback families disjoint", () => {
    expect(media.map(sceneMediaFamily)).toEqual(["stage", null, "window"]);
  });

  it("splits by host, never by kind or chrome: an Overlay-hosted entry stays on the frame layer", () => {
    const chromedStill = createSceneMedia("img3", "assets/shot.png", "image", "overlay");
    chromedStill.window = { radius: "macos" };
    const staged = createSceneMedia("img4", "assets/shot.png", "image", "stage");
    staged.window = { radius: "rounded" };
    const overlayClip = createSceneMedia("vid1", "assets/clip.mp4", "video", "overlay");
    const chromedOverlayClip = createSceneMedia("vid2", "assets/clip.mp4", "video", "overlay");
    chromedOverlayClip.window = { radius: "macos" };

    expect(sceneMediaFamily(chromedStill)).toBeNull();
    expect(sceneMediaFamily(staged)).toBe("stage");
    expect(sceneMediaFamily(overlayClip)).toBeNull();
    expect(sceneMediaFamily(chromedOverlayClip)).toBeNull();
    expect(sceneMediaInFrame([chromedStill, staged, overlayClip]).map((e) => e.id)).toEqual([
      "img3",
      "vid1",
    ]);
    expect(sceneMediaInWorld([chromedStill, staged, overlayClip]).map((e) => e.id)).toEqual([
      "img4",
    ]);
    expect(
      [chromedStill, staged, overlayClip, chromedOverlayClip].map(sceneMediaUsesWindowPath),
    ).toEqual([false, false, false, false]);
  });

  it("keeps a window-hosted clip on the window path with or without chrome", () => {
    const bare = createSceneMedia("vid1", "assets/clip.mp4", "video", "window");
    delete bare.window;
    const chromed = createSceneMedia("vid2", "assets/clip.mp4", "video", "window");
    const staged = createSceneMedia("vid3", "assets/clip.mp4", "video", "stage");
    delete staged.window;
    const stagedWindow = createSceneMedia("vid4", "assets/clip.mp4", "video", "stage");

    expect(sceneMediaFamily(bare)).toBe("window");
    expect(sceneMediaUsesWindowPath(bare)).toBe(true);
    expect(sceneMediaUsesWindowPath(chromed)).toBe(true);
    // A Stage clip stays on the stage plane until chrome asks for the window sizing.
    expect(sceneMediaFamily(staged)).toBe("stage");
    expect(sceneMediaUsesWindowPath(staged)).toBe(false);
    expect(sceneMediaUsesWindowPath(stagedWindow)).toBe(true);
  });

  it("takes every overlay-placed entry for the 2D gizmo, both layers", () => {
    const staged = createSceneMedia("img1", "assets/a.png", "image", "stage");
    const framed = createSceneMedia("img2", "assets/b.png", "image", "overlay");
    const windowed = createSceneMedia("vid1", "assets/clip.mp4", "video", "window");

    expect(sceneMediaOverlayPlaced([staged, framed, windowed]).map((e) => e.id)).toEqual([
      "img2",
      "vid1",
    ]);
  });
});

describe("authoring writes", () => {
  const legacyDoc = () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        images: [legacyImage("img1", "assets/a.png", "stage")],
        videoWindow: { media: { src: "assets/clip.mp4" }, radius: "macos", scale: 0.5 },
      },
      "test",
    );
    if (!doc) throw new Error("fixture did not parse");
    return structuredClone(doc);
  };

  it("promotes a legacy doc on the first write and keeps the sidecar media-only", () => {
    const doc = legacyDoc();

    editSceneDocMedia(doc, (media) => media.filter((entry) => entry.kind === "image"));

    expect(doc.media?.map((entry) => entry.id)).toEqual(["img1"]);
    expect(doc.videoWindow).toBeUndefined();
    expect(Object.keys(JSON.parse(JSON.stringify(doc)))).toEqual(["version", "media"]);
  });

  it("carries the promoted entries across, window chrome and all", () => {
    const doc = legacyDoc();

    editSceneDocMedia(doc, (media) => media);

    expect(doc.media?.map((entry) => entry.id)).toEqual(["img1", VIDEO_WINDOW_MEDIA_ID]);
    expect(doc.media?.[1]?.window).toEqual({ radius: "macos" });
    expect(doc.media?.[1]?.overlay.size).toBe(0.5);
    expect(doc.images).toBeUndefined();
  });

  it("drops every block when the last entry goes", () => {
    const doc = legacyDoc();

    editSceneDocMedia(doc, () => []);

    expect(doc.media).toBeUndefined();
    expect(doc.images).toBeUndefined();
    expect(doc.videoWindow).toBeUndefined();
  });

  it("survives a clone of a promoted doc, unlike the parse-derived array", () => {
    const doc = legacyDoc();
    editSceneDocMedia(doc, (media) => media);

    const clone = structuredClone(doc);
    expect(resolveSceneDocMedia(clone).map((entry) => entry.id)).toEqual([
      "img1",
      VIDEO_WINDOW_MEDIA_ID,
    ]);
  });
});

describe("pinnedFollowMediaEntry", () => {
  const media = [
    createSceneMedia("img1", "assets/a.png", "image"),
    createSceneMedia("vid1", "assets/one.mp4", "video"),
    createSceneMedia("vid2", "assets/two.mp4", "video"),
  ];

  it("names the entry a media pin points at", () => {
    expect(
      pinnedFollowMediaEntry(
        { mode: "follow-media", source: "media", sourceMediaId: "vid2" },
        media,
      )?.id,
    ).toBe("vid2");
  });

  it("reads the legacy spelling forward to whichever entry serves as the window", () => {
    expect(pinnedFollowMediaEntry({ mode: "follow-media", source: "videoWindow" }, media)?.id).toBe(
      "vid1",
    );
  });

  it("pins nothing for a device source, a stale id or a manual length", () => {
    expect(
      pinnedFollowMediaEntry({ mode: "follow-media", sourceDeviceId: "d1" }, media),
    ).toBeUndefined();
    expect(
      pinnedFollowMediaEntry(
        { mode: "follow-media", source: "media", sourceMediaId: "gone" },
        media,
      ),
    ).toBeUndefined();
    expect(
      pinnedFollowMediaEntry({ mode: "follow-media", source: "media" }, media),
    ).toBeUndefined();
    expect(pinnedFollowMediaEntry({ mode: "manual" }, media)).toBeUndefined();
  });
});
