import { describe, expect, it } from "vitest";
import type { SceneDoc } from "../../engine/sceneDocSchema";
import { createSceneImage } from "../../engine/sceneImage";
import type { FrameDecorationSpec } from "../../toolkit/frame/types";
import {
  defaultSceneImageHost,
  deleteLegacyImage,
  duplicateLegacyImage,
  promoteLegacyImage,
  reconcileImageEditor,
} from "./imageEditorModel";

describe("defaultSceneImageHost", () => {
  it("prefers an enabled Overlay and otherwise uses the Stage", () => {
    expect(defaultSceneImageHost(true)).toBe("overlay");
    expect(defaultSceneImageHost(false)).toBe("stage");
  });
});

describe("reconcileImageEditor", () => {
  const origin = { kind: "legacy-promotion" as const, imageId: "img1", decorationId: "logo" };
  const base = {
    drillIn: null,
    overviewRowId: null,
    selectedImageId: null,
    selectedDecorationId: null,
    imageIds: [] as string[],
    imageDecorationIds: [] as string[],
    origins: [origin],
  };

  it("switches an open promoted Image editor to its restored legacy decoration on Undo", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "image.edit",
        selectedImageId: "img1",
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({
      kind: "switch-to-legacy",
      imageId: "img1",
      decorationId: "logo",
      overviewRowId: "image:legacy:logo",
      replaceDrill: true,
    });
  });

  it("switches an open legacy editor to its restored promoted Image on Redo", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "logo",
        imageIds: ["img1"],
      }),
    ).toEqual({
      kind: "switch-to-image",
      imageId: "img1",
      decorationId: "logo",
      overviewRowId: "image:img1",
      replaceDrill: true,
    });
  });

  it("reconciles a promoted overview row without requesting drill replacement", () => {
    expect(
      reconcileImageEditor({
        ...base,
        overviewRowId: "image:img1",
        selectedImageId: "img1",
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({
      kind: "switch-to-legacy",
      imageId: "img1",
      decorationId: "logo",
      overviewRowId: "image:legacy:logo",
      replaceDrill: false,
    });
  });

  it("reconciles a legacy overview row without requesting drill replacement", () => {
    expect(
      reconcileImageEditor({
        ...base,
        overviewRowId: "image:legacy:logo",
        selectedDecorationId: "logo",
        imageIds: ["img1"],
      }),
    ).toEqual({
      kind: "switch-to-image",
      imageId: "img1",
      decorationId: "logo",
      overviewRowId: "image:img1",
      replaceDrill: false,
    });
  });

  it("ignores a persisted overview selection while another drill is open", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "lighting",
        overviewRowId: "image:img1",
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({ kind: "none" });
  });

  it("closes stale first-class and legacy Image editors", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "image.edit",
        selectedImageId: "missing",
        imageIds: ["img2"],
      }),
    ).toEqual({ kind: "close-stale-editor", editor: "image" });
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "missing",
        imageDecorationIds: ["badge"],
      }),
    ).toEqual({ kind: "close-stale-editor", editor: "legacyImage" });
  });

  it("waits for the editor selection effect when a current fallback exists", () => {
    expect(reconcileImageEditor({ ...base, drillIn: "image.edit", imageIds: ["img1"] })).toEqual({
      kind: "none",
    });
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "legacyImage.edit",
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({ kind: "none" });
  });

  it("closes an unselected editor when it has no fallback content", () => {
    expect(reconcileImageEditor({ ...base, drillIn: "image.edit" })).toEqual({
      kind: "close-stale-editor",
      editor: "image",
    });
    expect(reconcileImageEditor({ ...base, drillIn: "legacyImage.edit" })).toEqual({
      kind: "close-stale-editor",
      editor: "legacyImage",
    });
  });

  it("does nothing while the selected source still exists", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "image.edit",
        selectedImageId: "img1",
        imageIds: ["img1"],
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({ kind: "none" });
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "logo",
        imageIds: ["img1"],
        imageDecorationIds: ["logo"],
      }),
    ).toEqual({ kind: "none" });
  });

  it("chooses the restored promoted Image from repeated origins for one decoration", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "logo",
        imageIds: ["img2"],
        origins: [origin, { kind: "legacy-promotion", imageId: "img2", decorationId: "logo" }],
      }),
    ).toEqual({
      kind: "switch-to-image",
      imageId: "img2",
      decorationId: "logo",
      overviewRowId: "image:img2",
      replaceDrill: true,
    });
  });

  it("selects a duplicate's original without closing its open Image editor on Undo", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "image.edit",
        selectedImageId: "img2",
        imageIds: ["img1"],
        origins: [{ kind: "duplicate", imageId: "img2", sourceImageId: "img1" }],
      }),
    ).toEqual({
      kind: "select-image",
      imageId: "img1",
      overviewRowId: "image:img1",
    });
  });

  it("selects a duplicate's original when its selected overview row is undone", () => {
    expect(
      reconcileImageEditor({
        ...base,
        overviewRowId: "image:img3",
        selectedImageId: "img3",
        imageIds: ["img1", "img2"],
        origins: [
          { kind: "duplicate", imageId: "img2", sourceImageId: "img1" },
          { kind: "duplicate", imageId: "img3", sourceImageId: "img2" },
        ],
      }),
    ).toEqual({
      kind: "select-image",
      imageId: "img2",
      overviewRowId: "image:img2",
    });
  });

  it("closes a missing duplicate editor when its original is also absent", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "image.edit",
        selectedImageId: "img2",
        origins: [{ kind: "duplicate", imageId: "img2", sourceImageId: "img1" }],
      }),
    ).toEqual({ kind: "close-stale-editor", editor: "image" });
  });

  it("follows a combined legacy takeover and duplicate back to the coded image on Undo", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "image.edit",
        selectedImageId: "img2",
        imageDecorationIds: ["logo"],
        origins: [
          { kind: "legacy-promotion", imageId: "img1", decorationId: "logo" },
          { kind: "duplicate", imageId: "img2", sourceImageId: "img1" },
        ],
      }),
    ).toEqual({
      kind: "switch-to-legacy",
      imageId: "img1",
      decorationId: "logo",
      overviewRowId: "image:legacy:logo",
      replaceDrill: true,
    });
  });

  it("returns to the combined operation's duplicate on Redo", () => {
    expect(
      reconcileImageEditor({
        ...base,
        drillIn: "legacyImage.edit",
        selectedDecorationId: "logo",
        imageIds: ["img1", "img2"],
        origins: [
          { kind: "legacy-promotion", imageId: "img1", decorationId: "logo" },
          { kind: "duplicate", imageId: "img2", sourceImageId: "img1" },
        ],
      }),
    ).toEqual({
      kind: "switch-to-image",
      imageId: "img2",
      decorationId: "logo",
      overviewRowId: "image:img2",
      replaceDrill: true,
    });
  });
});

describe("promoteLegacyImage", () => {
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

    const result = promoteLegacyImage(doc, resolved, "logo", () => {});

    expect(result).toEqual({
      imageId: "img1",
      doc: {
        version: 1,
        text: { title: "Keep me" },
        images: [
          {
            id: "img1",
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
      },
    });
  });

  it("allocates against current images, appends in order and applies the trigger", () => {
    const first = createSceneImage("img1", "assets/first.png", "stage");
    const third = createSceneImage("img3", "assets/third.png", "overlay");
    const doc: SceneDoc = { version: 1, images: [first, third] };
    const resolved: FrameDecorationSpec[] = [
      {
        id: "logo",
        src: "assets/logo.png",
        position: [0.1, 0.2],
        size: 0.2,
      },
    ];

    const result = promoteLegacyImage(doc, resolved, "logo", (image) => {
      image.src = "assets/replacement.png";
      image.overlay.position = [-0.4, 0.5];
      image.overlay.size = 0.3;
      image.castShadow = true;
    });

    expect(result?.imageId).toBe("img2");
    expect(result?.doc.images?.map((image) => image.id)).toEqual(["img1", "img3", "img2"]);
    expect(result?.doc.images?.[2]).toEqual({
      id: "img2",
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
      {
        id: "logo",
        src: "assets/resolved.png",
        position: [0.1, 0.2],
        size: 0.2,
      },
      {
        id: "inherited-badge",
        src: "assets/inherited.png",
        position: [-0.2, 0.1],
        size: 0.1,
      },
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

    const result = promoteLegacyImage(doc, resolved, "logo", () => {});

    expect(result?.doc.images?.[0]).toMatchObject({
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
      {
        id: "logo",
        src: "assets/logo.png",
        position: [0, 0],
        size: 0.2,
      },
    ];
    const before = structuredClone(doc);

    const result = promoteLegacyImage(doc, resolved, "logo", (image) => {
      image.src = "../outside.png";
    });

    expect(result).toBeNull();
    expect(doc).toEqual(before);
  });

  it("allows an unsafe inherited source to be replaced with a supported project image", () => {
    const doc: SceneDoc = { version: 1 };
    const resolved: FrameDecorationSpec[] = [
      {
        id: "logo",
        src: "assets/logo.svg",
        position: [0, 0],
        size: 0.2,
      },
    ];

    expect(promoteLegacyImage(doc, resolved, "logo", () => {})).toBeNull();

    const result = promoteLegacyImage(doc, resolved, "logo", (image) => {
      image.src = "assets/replacement.webp";
    });

    expect(result?.doc.images?.[0]?.src).toBe("assets/replacement.webp");
    expect(result?.doc.frame?.decorations).toEqual([]);
  });

  it("returns null for missing and text decorations", () => {
    const doc: SceneDoc = { version: 1 };
    const resolved: FrameDecorationSpec[] = [
      { id: "label", text: "Not an image", position: [0, 0], size: 0.1 },
    ];

    expect(promoteLegacyImage(doc, resolved, "missing", () => {})).toBeNull();
    expect(promoteLegacyImage(doc, resolved, "label", () => {})).toBeNull();
  });

  it("does not mutate the document or resolved decorations", () => {
    const doc: SceneDoc = {
      version: 1,
      images: [createSceneImage("img1", "assets/first.png", "stage")],
      frame: { background: "muted" },
    };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0.1, 0.2], size: 0.2 },
      { id: "badge", src: "assets/badge.png", position: [0.4, 0.5], size: 0.1 },
    ];
    const docBefore = structuredClone(doc);
    const resolvedBefore = structuredClone(resolved);

    const result = promoteLegacyImage(doc, resolved, "logo", (image) => {
      image.overlay.position[0] = 0.9;
    });

    expect(doc).toEqual(docBefore);
    expect(resolved).toEqual(resolvedBefore);
    expect(result?.doc).not.toBe(doc);
    expect(result?.doc.images?.[0]).not.toBe(doc.images?.[0]);
    expect(result?.doc.frame?.decorations?.[0]).not.toBe(resolved[1]);
  });

  it("does not fall back after execution-time decorations remove the selected image", () => {
    const doc: SceneDoc = { version: 1, frame: { decorations: [] } };
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0, 0], size: 0.2 },
    ];

    expect(promoteLegacyImage(doc, resolved, "logo", () => {})).toBeNull();
    expect(doc.frame?.decorations).toEqual([]);
  });
});

describe("legacy structural Image actions", () => {
  it("promotes the original and creates a first-class duplicate from current state", () => {
    const existing = createSceneImage("img1", "assets/existing.png", "stage");
    const doc: SceneDoc = {
      version: 1,
      images: [existing],
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

    const result = duplicateLegacyImage(doc, [], "logo");

    expect(result?.imageId).toBe("img2");
    expect(result?.duplicateId).toBe("img3");
    expect(result?.doc.images?.map((image) => image.id)).toEqual(["img1", "img2", "img3"]);
    expect(result?.doc.images?.[1]?.overlay.position).toEqual([-0.4, 0.6]);
    expect(result?.doc.images?.[2]?.overlay.position[0]).toBeCloseTo(-0.35);
    expect(result?.doc.images?.[2]?.overlay.position[1]).toBeCloseTo(0.55);
    expect(result?.doc.frame).toEqual({
      background: "accent",
      decorations: [
        {
          id: "badge",
          src: "assets/badge.png",
          position: [0.2, 0.1],
          size: 0.1,
          stackOrder: 1,
        },
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

    const result = deleteLegacyImage(doc, resolved, "logo");

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

    expect(duplicateLegacyImage(doc, resolved, "logo")).toBeNull();
    expect(deleteLegacyImage(doc, resolved, "logo")).toBeNull();
  });
});
