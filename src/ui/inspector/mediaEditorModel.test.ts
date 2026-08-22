import { describe, expect, it } from "vitest";
import { parseSceneDoc, type SceneDoc, type SceneDocMediaSpec } from "../../engine/sceneDocSchema";
import { createSceneMedia } from "../../engine/sceneMedia";
import type { FrameDecorationSpec } from "../../toolkit/frame/types";
import {
  defaultSceneMediaHost,
  deleteLegacyMedia,
  duplicateLegacyMedia,
  isMediaDrillRoute,
  promoteLegacyMedia,
  reconcileMediaEditor,
  removeSceneMedia,
} from "./mediaEditorModel";

describe("defaultSceneMediaHost", () => {
  it("prefers an enabled Overlay for a still and always floats a video", () => {
    expect(defaultSceneMediaHost("image", true)).toBe("overlay");
    expect(defaultSceneMediaHost("image", false)).toBe("stage");
    expect(defaultSceneMediaHost("video", false)).toBe("overlay");
  });
});

describe("isMediaDrillRoute", () => {
  it("accepts the media route and the two legacy ids it replaced", () => {
    expect(isMediaDrillRoute("media.edit")).toBe(true);
    expect(isMediaDrillRoute("image.edit")).toBe(true);
    expect(isMediaDrillRoute("videoWindow.edit")).toBe(true);
    expect(isMediaDrillRoute("legacyImage.edit")).toBe(false);
    expect(isMediaDrillRoute(null)).toBe(false);
  });
});

describe("promote-on-write", () => {
  it("materialises a legacy doc's images and video window as authored media on the first edit", () => {
    const doc = parseSceneDoc(
      {
        version: 1,
        images: [
          {
            id: "img1",
            src: "assets/hero.png",
            host: "stage",
            stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
            overlay: {
              position: [0, 0],
              size: 0.25,
              rotationDeg: 0,
              shape: "none",
              layer: "above",
            },
          },
        ],
        videoWindow: { media: { src: "assets/demo.mov" }, radius: "macos" },
      },
      "test",
    );
    if (!doc) throw new Error("fixture did not parse");
    const next = structuredClone(doc);

    expect(removeSceneMedia(next, "img1")).toBe("videoWindow");
    expect(next.media?.map((entry) => entry.id)).toEqual(["videoWindow"]);
    expect(JSON.parse(JSON.stringify(next))).toEqual({
      version: 1,
      media: [expect.objectContaining({ id: "videoWindow", kind: "video", host: "overlay" })],
    });
    // The legacy blocks the promotion superseded are gone, in memory as well as on disk.
    expect(next.videoWindow).toBeUndefined();
    expect(next.images).toBeUndefined();
  });
});

describe("removeSceneMedia", () => {
  const videoEntry = (id: string, src: string): SceneDocMediaSpec => ({
    id,
    kind: "video",
    src,
    host: "overlay",
    stage: { position: [0, 0, 0], size: 5.3, rotationDeg: [0, 0, 0] },
    overlay: { position: [0, 0], size: 0.72, rotationDeg: 0, shape: "none", layer: "below" },
    window: { radius: "macos" },
  });

  it("hands a length that followed the entry back to manual and bakes its rig aim", () => {
    const doc: SceneDoc = {
      version: 1,
      duration: { mode: "follow-media", source: "media", sourceMediaId: "vid1" },
      media: [videoEntry("vid1", "assets/one.mp4")],
      cameraRig: {
        keys: [
          {
            id: "k1",
            tMs: 0,
            pose: { position: [0, 0, 5], aim: { mode: "object", id: "vid1", at: [0, 0, 0] } },
          },
        ],
        segments: [],
      },
    };

    expect(removeSceneMedia(doc, "vid1")).toBeNull();
    expect(doc.duration).toEqual({ mode: "manual" });
    expect(doc.cameraRig?.keys[0]?.pose.aim).toEqual({ mode: "point", at: [0, 0, 0] });
  });

  it("bakes the legacy window aim only once nothing serves the window", () => {
    const rig = () => ({
      keys: [
        {
          id: "k1",
          tMs: 0,
          pose: {
            position: [0, 0, 5] as [number, number, number],
            aim: {
              mode: "object" as const,
              id: "videoWindow",
              at: [0, 0, 0] as [number, number, number],
            },
          },
        },
      ],
      segments: [],
    });
    const doc: SceneDoc = {
      version: 1,
      media: [videoEntry("vid1", "assets/one.mp4"), videoEntry("vid2", "assets/two.mp4")],
      cameraRig: rig(),
    };

    removeSceneMedia(doc, "vid2");
    expect(doc.cameraRig?.keys[0]?.pose.aim.mode).toBe("object");

    removeSceneMedia(doc, "vid1");
    expect(doc.cameraRig?.keys[0]?.pose.aim).toEqual({ mode: "point", at: [0, 0, 0] });
  });
});

describe("reconcileMediaEditor", () => {
  const origin = { kind: "legacy-promotion" as const, imageId: "img1", decorationId: "logo" };
  const base = {
    drillIn: null,
    overviewRowId: null,
    selectedMediaId: null,
    selectedDecorationId: null,
    mediaIds: [] as string[],
    imageDecorationIds: [] as string[],
    origins: [origin],
  };

  it("switches an open promoted media editor to its restored legacy decoration on Undo", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "media.edit",
        selectedMediaId: "img1",
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({
      kind: "switch-to-legacy",
      mediaId: "img1",
      decorationId: "logo",
      overviewRowId: "media:legacy:logo",
      replaceDrill: true,
    });
  });

  it("switches an open legacy editor to its restored media entry on Redo", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "logo",
        mediaIds: ["img1"],
      }),
    ).toEqual({
      kind: "switch-to-media",
      mediaId: "img1",
      decorationId: "logo",
      overviewRowId: "media:img1",
      replaceDrill: true,
    });
  });

  it("reconciles a promoted overview row without requesting drill replacement", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        overviewRowId: "media:img1",
        selectedMediaId: "img1",
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({
      kind: "switch-to-legacy",
      mediaId: "img1",
      decorationId: "logo",
      overviewRowId: "media:legacy:logo",
      replaceDrill: false,
    });
  });

  it("reconciles a legacy overview row without requesting drill replacement", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        overviewRowId: "media:legacy:logo",
        selectedDecorationId: "logo",
        mediaIds: ["img1"],
      }),
    ).toEqual({
      kind: "switch-to-media",
      mediaId: "img1",
      decorationId: "logo",
      overviewRowId: "media:img1",
      replaceDrill: false,
    });
  });

  it("ignores a persisted overview selection while another drill is open", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "lighting",
        overviewRowId: "media:img1",
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({ kind: "none" });
  });

  it("closes stale media and legacy editors", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "media.edit",
        selectedMediaId: "missing",
        mediaIds: ["img2"],
      }),
    ).toEqual({ kind: "close-stale-editor", editor: "media" });
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "missing",
        imageDecorationIds: ["badge"],
      }),
    ).toEqual({ kind: "close-stale-editor", editor: "legacyImage" });
  });

  it("waits for the editor selection effect when a current fallback exists", () => {
    expect(reconcileMediaEditor({ ...base, drillIn: "media.edit", mediaIds: ["img1"] })).toEqual({
      kind: "none",
    });
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "legacyImage.edit",
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({ kind: "none" });
  });

  it("closes an unselected editor when it has no fallback content", () => {
    expect(reconcileMediaEditor({ ...base, drillIn: "media.edit" })).toEqual({
      kind: "close-stale-editor",
      editor: "media",
    });
    expect(reconcileMediaEditor({ ...base, drillIn: "legacyImage.edit" })).toEqual({
      kind: "close-stale-editor",
      editor: "legacyImage",
    });
  });

  it("does nothing while the selected source still exists", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "media.edit",
        selectedMediaId: "img1",
        mediaIds: ["img1"],
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({ kind: "none" });
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "logo",
        mediaIds: ["img1"],
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({ kind: "none" });
  });

  it("chooses the restored entry from repeated origins for one decoration", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "logo",
        mediaIds: ["img2"],
        origins: [origin, { kind: "legacy-promotion", imageId: "img2", decorationId: "logo" }],
      }),
    ).toEqual({
      kind: "switch-to-media",
      mediaId: "img2",
      decorationId: "logo",
      overviewRowId: "media:img2",
      replaceDrill: true,
    });
  });

  it("selects a duplicate's original without closing its open editor on Undo", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "media.edit",
        selectedMediaId: "img2",
        mediaIds: ["img1"],
        origins: [{ kind: "duplicate", imageId: "img2", sourceImageId: "img1" }],
      }),
    ).toEqual({
      kind: "select-media",
      mediaId: "img1",
      overviewRowId: "media:img1",
    });
  });

  it("selects a duplicate's original when its selected overview row is undone", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        overviewRowId: "media:img3",
        selectedMediaId: "img3",
        mediaIds: ["img1", "img2"],
        origins: [
          { kind: "duplicate", imageId: "img2", sourceImageId: "img1" },
          { kind: "duplicate", imageId: "img3", sourceImageId: "img2" },
        ],
      }),
    ).toEqual({
      kind: "select-media",
      mediaId: "img2",
      overviewRowId: "media:img2",
    });
  });

  it("closes a missing duplicate editor when its original is also absent", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "media.edit",
        selectedMediaId: "img2",
        origins: [{ kind: "duplicate", imageId: "img2", sourceImageId: "img1" }],
      }),
    ).toEqual({ kind: "close-stale-editor", editor: "media" });
  });

  it("follows a combined legacy takeover and duplicate back to the coded image on Undo", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "media.edit",
        selectedMediaId: "img2",
        imageDecorationIds: ["logo"],
        origins: [
          { kind: "legacy-promotion", imageId: "img1", decorationId: "logo" },
          { kind: "duplicate", imageId: "img2", sourceImageId: "img1" },
        ],
      }),
    ).toEqual({
      kind: "switch-to-legacy",
      mediaId: "img1",
      decorationId: "logo",
      overviewRowId: "media:legacy:logo",
      replaceDrill: true,
    });
  });

  it("returns to the combined operation's duplicate on Redo", () => {
    expect(
      reconcileMediaEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "logo",
        mediaIds: ["img1", "img2"],
        origins: [
          { kind: "legacy-promotion", imageId: "img1", decorationId: "logo" },
          { kind: "duplicate", imageId: "img2", sourceImageId: "img1" },
        ],
      }),
    ).toEqual({
      kind: "switch-to-media",
      mediaId: "img2",
      decorationId: "logo",
      overviewRowId: "media:img2",
      replaceDrill: true,
    });
  });
});

describe("promoteLegacyMedia", () => {
  it("preserves exact resolved placement and materialises every remaining decoration", () => {
    const doc: SceneDoc = {
      version: 1,
      text: { title: "Keep me" },
      frame: { background: "accent", claimsSceneText: true },
    };
    const resolved: FrameDecorationSpec[] = [
      {
        id: "logo",
        src: "assets/logo.png",
        position: [0.42, -0.31],
        size: 0.23,
        rotationDeg: -17,
        shape: "circle",
        layer: "below",
      },
      {
        id: "label",
        text: "Resolved label",
        position: [-0.2, 0.1],
        size: 0.08,
        colour: "text",
      },
      {
        id: "badge",
        src: "assets/badge.png",
        position: [0.7, 0.6],
        size: 0.1,
        layer: "above",
      },
    ];

    const result = promoteLegacyMedia(doc, resolved, "logo", () => {});

    expect(result?.mediaId).toBe("img1");
    expect(JSON.parse(JSON.stringify(result?.doc))).toEqual({
      version: 1,
      text: { title: "Keep me" },
      media: [
        {
          id: "img1",
          kind: "image",
          src: "assets/logo.png",
          host: "overlay",
          stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
          overlay: {
            position: [0.42, -0.31],
            size: 0.23,
            rotationDeg: -17,
            shape: "circle",
            layer: "below",
            stackOrder: 0,
          },
        },
      ],
      frame: {
        background: "accent",
        claimsSceneText: true,
        decorations: [
          { ...resolved[1], stackOrder: 1 },
          { ...resolved[2], stackOrder: 2 },
        ],
      },
    });
  });

  it("allocates against current media, appends in order and applies the trigger", () => {
    const first = createSceneMedia("img1", "assets/first.png", "image", "stage");
    const third = createSceneMedia("img3", "assets/third.png", "image", "overlay");
    const doc: SceneDoc = { version: 1, media: [first, third] };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0.1, 0.2], size: 0.2 },
    ];

    const result = promoteLegacyMedia(doc, resolved, "logo", (entry) => {
      entry.src = "assets/replacement.png";
      entry.overlay.position = [-0.4, 0.5];
      entry.overlay.size = 0.3;
      entry.castShadow = true;
    });

    expect(result?.mediaId).toBe("img2");
    expect(result?.doc.media?.map((entry) => entry.id)).toEqual(["img1", "img3", "img2"]);
    expect(result?.doc.media?.[2]).toEqual({
      id: "img2",
      kind: "image",
      src: "assets/replacement.png",
      host: "overlay",
      stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
      overlay: {
        position: [-0.4, 0.5],
        size: 0.3,
        rotationDeg: 0,
        shape: "none",
        layer: "above",
        stackOrder: 0,
      },
      castShadow: true,
    });
    expect(result?.doc.frame?.decorations).toEqual([]);
  });

  it("promotes from execution-time decorations and preserves queued decoration changes", () => {
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/resolved.png", position: [0.1, 0.2], size: 0.2 },
      { id: "inherited-badge", src: "assets/inherited.png", position: [-0.2, 0.1], size: 0.1 },
    ];
    const currentBadge: FrameDecorationSpec = {
      id: "queued-badge",
      src: "assets/queued.png",
      position: [0.7, -0.5],
      size: 0.14,
      layer: "below",
    };
    const doc: SceneDoc = {
      version: 1,
      frame: {
        background: "accent",
        decorations: [
          {
            id: "logo",
            src: "assets/current.png",
            position: [-0.4, 0.6],
            size: 0.32,
            rotationDeg: 13,
            shape: "circle",
          },
          currentBadge,
        ],
      },
    };

    const result = promoteLegacyMedia(doc, resolved, "logo", () => {});

    expect(result?.doc.media?.[0]).toMatchObject({
      src: "assets/current.png",
      overlay: {
        position: [-0.4, 0.6],
        size: 0.32,
        rotationDeg: 13,
        shape: "circle",
      },
    });
    expect(result?.doc.frame?.decorations).toEqual([{ ...currentBadge, stackOrder: 1 }]);
  });

  it("rejects an unsafe final source without changing the document", () => {
    const doc: SceneDoc = { version: 1, text: { title: "Keep me" } };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0, 0], size: 0.2 },
    ];
    const before = structuredClone(doc);

    const result = promoteLegacyMedia(doc, resolved, "logo", (entry) => {
      entry.src = "../outside.png";
    });

    expect(result).toBeNull();
    expect(doc).toEqual(before);
  });

  it("allows an unsafe inherited source to be replaced with a supported project image", () => {
    const doc: SceneDoc = { version: 1 };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.svg", position: [0, 0], size: 0.2 },
    ];

    expect(promoteLegacyMedia(doc, resolved, "logo", () => {})).toBeNull();

    const result = promoteLegacyMedia(doc, resolved, "logo", (entry) => {
      entry.src = "assets/replacement.webp";
    });

    expect(result?.doc.media?.[0]?.src).toBe("assets/replacement.webp");
    expect(result?.doc.frame?.decorations).toEqual([]);
  });

  it("returns null for missing and text decorations", () => {
    const doc: SceneDoc = { version: 1 };
    const resolved: FrameDecorationSpec[] = [
      { id: "label", text: "Not an image", position: [0, 0], size: 0.1 },
    ];

    expect(promoteLegacyMedia(doc, resolved, "missing", () => {})).toBeNull();
    expect(promoteLegacyMedia(doc, resolved, "label", () => {})).toBeNull();
  });

  it("does not mutate the document or resolved decorations", () => {
    const doc: SceneDoc = {
      version: 1,
      media: [createSceneMedia("img1", "assets/first.png", "image", "stage")],
      frame: { background: "muted" },
    };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0.1, 0.2], size: 0.2 },
      { id: "badge", src: "assets/badge.png", position: [0.4, 0.5], size: 0.1 },
    ];
    const docBefore = structuredClone(doc);
    const resolvedBefore = structuredClone(resolved);

    const result = promoteLegacyMedia(doc, resolved, "logo", (entry) => {
      entry.overlay.position[0] = 0.9;
    });

    expect(doc).toEqual(docBefore);
    expect(resolved).toEqual(resolvedBefore);
    expect(result?.doc).not.toBe(doc);
    expect(result?.doc.media?.[0]).not.toBe(doc.media?.[0]);
    expect(result?.doc.frame?.decorations?.[0]).not.toBe(resolved[1]);
  });

  it("does not fall back after execution-time decorations remove the selected image", () => {
    const doc: SceneDoc = { version: 1, frame: { decorations: [] } };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0, 0], size: 0.2 },
    ];

    expect(promoteLegacyMedia(doc, resolved, "logo", () => {})).toBeNull();
    expect(doc.frame?.decorations).toEqual([]);
  });
});

describe("legacy structural media actions", () => {
  it("promotes the original and creates a first-class duplicate from current state", () => {
    const existing = createSceneMedia("img1", "assets/existing.png", "image", "stage");
    const doc: SceneDoc = {
      version: 1,
      media: [existing],
      frame: {
        background: "accent",
        decorations: [
          {
            id: "logo",
            src: "assets/current.png",
            position: [-0.4, 0.6],
            size: 0.32,
            rotationDeg: 13,
            shape: "circle",
            layer: "below",
          },
          { id: "badge", src: "assets/badge.png", position: [0.2, 0.1], size: 0.1 },
        ],
      },
    };
    const before = structuredClone(doc);

    const result = duplicateLegacyMedia(doc, [], "logo");

    expect(result?.mediaId).toBe("img2");
    expect(result?.duplicateId).toBe("img3");
    expect(result?.doc.media?.map((entry) => entry.id)).toEqual(["img1", "img2", "img3"]);
    expect(result?.doc.media?.[1]?.overlay.position).toEqual([-0.4, 0.6]);
    expect(result?.doc.media?.[2]?.overlay.position[0]).toBeCloseTo(-0.35);
    expect(result?.doc.media?.[2]?.overlay.position[1]).toBeCloseTo(0.55);
    expect(result?.doc.frame).toEqual({
      background: "accent",
      decorations: [
        { id: "badge", src: "assets/badge.png", position: [0.2, 0.1], size: 0.1, stackOrder: 1 },
      ],
    });
    expect(doc).toEqual(before);
  });

  it("materialises remaining decorations when deleting even an unsupported inherited source", () => {
    const doc: SceneDoc = { version: 1, frame: { background: "muted" } };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.svg", position: [0, 0], size: 0.2 },
      { id: "badge", src: "assets/badge.png", position: [0.2, 0], size: 0.1 },
    ];

    const result = deleteLegacyMedia(doc, resolved, "logo");

    expect(result).toEqual({
      version: 1,
      frame: {
        background: "muted",
        decorations: [{ ...resolved[1], stackOrder: 1 }],
      },
    });
    expect(doc).toEqual({ version: 1, frame: { background: "muted" } });
  });

  it("aborts structural actions when current decorations no longer contain the target", () => {
    const doc: SceneDoc = {
      version: 1,
      frame: {
        decorations: [{ id: "badge", src: "assets/badge.png", position: [0, 0], size: 0.1 }],
      },
    };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0, 0], size: 0.2 },
    ];

    expect(duplicateLegacyMedia(doc, resolved, "logo")).toBeNull();
    expect(deleteLegacyMedia(doc, resolved, "logo")).toBeNull();
  });
});
