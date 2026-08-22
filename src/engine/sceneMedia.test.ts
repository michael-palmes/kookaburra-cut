import { describe, expect, it } from "vitest";
import { clipPlaneSize } from "./clipFrame";
import { parseSceneDoc, type SceneDocVideoWindow } from "./sceneDocSchema";
import { createSceneImage } from "./sceneImage";
import {
  createSceneMedia,
  DEFAULT_SCENE_MEDIA_VIDEO_STAGE_SIZE,
  nextSceneMediaId,
  overlaySizeToVideoWindowScale,
  resolveSceneDocMedia,
  sampleSceneImageMotion,
  sampleSceneMediaMotion,
  sceneImagesFromMedia,
  sceneMediaFamily,
  sceneMediaFromLegacy,
  sceneMediaFromVideoWindow,
  sceneMediaInFrame,
  sceneMediaInWorld,
  VIDEO_WINDOW_MEDIA_ID,
  videoWindowFromMedia,
  videoWindowScaleToOverlaySize,
  windowOverlayPlaneWidth,
} from "./sceneMedia";
import { sampleVideoWindowMotion } from "./sceneVideoWindow";

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

  it("round-trips through the inverse", () => {
    for (const scale of [0.72, 0.5, 0.9]) {
      expect(overlaySizeToVideoWindowScale(videoWindowScaleToOverlaySize(scale))).toBeCloseTo(
        scale,
        10,
      );
    }
    expect(overlaySizeToVideoWindowScale(undefined)).toBe(0.72);
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

  it("promotes one overlay-hosted video entry under the rig aim id", () => {
    const entry = sceneMediaFromVideoWindow(window);
    expect(entry.id).toBe(VIDEO_WINDOW_MEDIA_ID);
    expect(entry.kind).toBe("video");
    expect(entry.host).toBe("overlay");
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

  it("round-trips back to the legacy views", () => {
    const media = doc?.media ?? [];
    expect(sceneImagesFromMedia(media)).toEqual(doc?.images);
    const window = videoWindowFromMedia(media);
    expect(window?.media).toEqual({ src: "assets/clip.mp4", aspect: 4 / 3 });
    expect(window?.radius).toBe("macos");
    expect(window?.scale).toBeCloseTo(0.6, 10);
    expect(window?.offset?.[0]).toBeCloseTo(0, 10);
    expect(window?.offset?.[1]).toBeCloseTo(0.25, 10);
  });

  it("takes no video window from an image-only doc", () => {
    expect(videoWindowFromMedia(sceneMediaFromLegacy(doc?.images, undefined))).toBeUndefined();
    expect(sceneMediaFromLegacy(undefined, undefined)).toEqual([]);
  });

  it("drops a drift preset an image host cannot sample", () => {
    const images = sceneImagesFromMedia([
      { ...createSceneMedia("img1", "assets/a.png", "image"), motion: { preset: "drift", hz: 1 } },
      { ...createSceneMedia("img2", "assets/b.png", "image"), motion: { preset: "float" } },
    ]);
    expect(images[0]?.motion).toBeUndefined();
    expect(images[1]?.motion).toEqual({ preset: "float" });
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
  it("matches the image factory, plus the kind", () => {
    expect(createSceneMedia("img1", "assets/a.png", "image", "overlay")).toEqual({
      ...createSceneImage("img1", "assets/a.png", "overlay"),
      kind: "image",
    });
  });

  it("starts a video overlay-hosted with macOS window chrome at the legacy default size", () => {
    const entry = createSceneMedia("vid1", "assets/clip.mp4", "video");
    expect(entry.host).toBe("overlay");
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
    [
      createSceneImage("img1", "assets/a.png", "stage"),
      createSceneImage("img2", "assets/b.png", "overlay"),
    ],
    { media: { src: "assets/clip.mp4" }, radius: "macos" },
  );

  it("splits the world from the frame layer, windowed entries going to the world", () => {
    expect(sceneMediaInWorld(media).map((e) => e.id)).toEqual(["img1", VIDEO_WINDOW_MEDIA_ID]);
    expect(sceneMediaInFrame(media).map((e) => e.id)).toEqual(["img2"]);
  });

  it("keeps the two fallback families disjoint", () => {
    expect(media.map(sceneMediaFamily)).toEqual(["stage", null, "window"]);
  });
});
