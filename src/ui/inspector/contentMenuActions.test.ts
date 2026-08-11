import { describe, expect, it } from "vitest";
import type { SceneDoc, SceneDocImageSpec } from "../../engine/sceneDocSchema";
import type { FrameDecorationSpec } from "../../toolkit/frame/types";
import type {
  SceneOverviewContentType,
  SceneOverviewRowModel,
  SceneOverviewSelectionTarget,
} from "../inspectorOptions";
import {
  type ContentMenuAction,
  contentMenuActions,
  OBJECT_DUPLICATE_NUDGE_X,
  planContentDelete,
  planContentDuplicate,
} from "./contentMenuActions";

function row(
  type: SceneOverviewContentType,
  selectionTarget?: SceneOverviewSelectionTarget,
): SceneOverviewRowModel {
  return {
    id: selectionTarget && "id" in selectionTarget ? `${type}:${selectionTarget.id}` : type,
    type,
    label: type,
    selectionTarget,
    openRoute: `${type}.edit`,
  };
}

function apply(plan: ReturnType<typeof planContentDuplicate>, doc: SceneDoc): SceneDoc {
  if (!plan) throw new Error("Expected a mutation plan");
  const next = structuredClone(doc);
  plan.apply(next);
  return next;
}

describe("contentMenuActions", () => {
  const cases: Array<[SceneOverviewRowModel, ContentMenuAction[]]> = [
    [row("text", { kind: "text", id: "title" }), ["edit", "duplicate", "delete"]],
    [row("text"), ["edit"]],
    [row("device", { kind: "device", id: "d1" }), ["edit", "duplicate", "delete"]],
    [row("image", { kind: "legacyImage", id: "logo" }), ["edit", "duplicate", "delete"]],
    [row("image", { kind: "image", id: "img1" }), ["edit", "duplicate", "delete"]],
    [row("video", { kind: "videoWindow" }), ["edit", "delete"]],
    [row("object", { kind: "object", id: "o1" }), ["edit", "duplicate", "delete"]],
    [row("chart", { kind: "chart" }), ["edit", "delete"]],
    [row("screenshotStack", { kind: "screenshotStack" }), ["edit", "delete"]],
    [row("comparison", { kind: "comparison" }), ["edit", "delete"]],
  ];

  it.each(cases)("exposes only supported actions for %#", (contentRow, actions) => {
    expect(contentMenuActions(contentRow)).toEqual(actions);
  });

  it("does not offer a content menu for scene-setting rows", () => {
    expect(
      contentMenuActions({
        id: "lighting",
        type: "lighting",
        label: "Lighting",
        openRoute: "lighting",
      }),
    ).toEqual([]);
  });
});

describe("planContentDuplicate", () => {
  it("duplicates a device with the shipping remint and mirror behaviour", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          colour: "silver",
          media: { src: "assets/demo.mp4", kind: "video" },
          placement: { position: [2, -0.3, 0.4], rotationDeg: [3, -14, 2], scale: 0.8 },
          motion: { preset: "float", amplitude: 0.2 },
          shadow: "long",
        },
        { id: "d2", model: "iphone-17-pro" },
      ],
      deviceLayout: { preset: "row", devices: { d1: { offset: [0.2, 0, 0] } } },
      compare: {
        b: { media: { d1: { src: "assets/after.mp4", kind: "video", startMs: 250 } } },
      },
    };
    const plan = planContentDuplicate(row("device", { kind: "device", id: "d1" }), { doc });
    const next = apply(plan, doc);

    expect(plan?.history).toBe("duplicate device");
    expect(plan?.nextRowId).toBe("device:d3");
    expect(next.devices?.[2]).toEqual({
      ...doc.devices?.[0],
      id: "d3",
      placement: { position: [-2, -0.3, 0.4], rotationDeg: [3, 14, 2], scale: 0.8 },
    });
    expect(next.deviceLayout?.devices).toEqual({
      d1: { offset: [0.2, 0, 0] },
      d3: { offset: [0.2, 0, 0] },
    });
    expect(next.compare?.b?.media).toEqual({
      d1: { src: "assets/after.mp4", kind: "video", startMs: 250 },
      d3: { src: "assets/after.mp4", kind: "video", startMs: 250 },
    });
    expect(doc.devices).toHaveLength(2);
  });

  it("uses the laptop footprint when a centred laptop is duplicated", () => {
    const doc: SceneDoc = {
      version: 1,
      devices: [
        {
          id: "d1",
          model: "macbook-pro-16",
          placement: { position: [0, -0.3, 0], scale: 1.2 },
        },
      ],
    };
    const next = apply(
      planContentDuplicate(row("device", { kind: "device", id: "d1" }), { doc }),
      doc,
    );
    expect(next.devices?.[1]?.placement?.position).toEqual([4.32, -0.3, 0]);
  });

  it("allocates numbered IDs from the document current when the queued mutation runs", () => {
    const plannedDoc: SceneDoc = {
      version: 1,
      devices: [{ id: "d1", model: "iphone-17-pro" }],
      objects: [{ id: "o1", objectId: "cube" }],
    };
    const currentDoc: SceneDoc = {
      ...plannedDoc,
      devices: [...(plannedDoc.devices ?? []), { id: "d2", model: "iphone-17-pro" }],
      objects: [...(plannedDoc.objects ?? []), { id: "o2", objectId: "cube" }],
    };
    const devicePlan = planContentDuplicate(row("device", { kind: "device", id: "d1" }), {
      doc: plannedDoc,
    });
    const objectPlan = planContentDuplicate(row("object", { kind: "object", id: "o1" }), {
      doc: plannedDoc,
    });

    const nextDeviceDoc = apply(devicePlan, currentDoc);
    const nextObjectDoc = apply(objectPlan, currentDoc);

    expect(devicePlan?.nextRowId).toBe("device:d3");
    expect(nextDeviceDoc.devices?.map((device) => device.id)).toEqual(["d1", "d2", "d3"]);
    expect(objectPlan?.nextRowId).toBe("object:o3");
    expect(nextObjectDoc.objects?.map((object) => object.id)).toEqual(["o1", "o2", "o3"]);
  });

  it("duplicates a Stage image and nudges only its active placement", () => {
    const doc: SceneDoc = {
      version: 1,
      images: [
        {
          id: "img1",
          src: "assets/hero.png",
          host: "stage",
          stage: { position: [1, 2, 3], size: 1.4, rotationDeg: [4, 5, 6] },
          overlay: {
            position: [0.2, -0.3],
            size: 0.25,
            rotationDeg: 7,
            shape: "circle",
            layer: "below",
          },
          castShadow: true,
        },
        {
          id: "img2",
          src: "assets/second.png",
          host: "stage",
          stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
          overlay: {
            position: [0, 0],
            size: 0.2,
            rotationDeg: 0,
            shape: "none",
            layer: "above",
          },
        },
      ],
    };
    const plan = planContentDuplicate(row("image", { kind: "image", id: "img1" }), { doc });
    const next = apply(plan, doc);

    expect(plan?.history).toBe("duplicate image");
    expect(plan?.nextRowId).toBe("image:img3");
    expect(plan?.nextSelection).toEqual({ kind: "image", id: "img3" });
    expect(next.images?.map((image) => image.id)).toEqual(["img1", "img2", "img3"]);
    expect(next.images?.[2]).toEqual({
      ...doc.images?.[0],
      id: "img3",
      stage: { position: [1.25, 2, 3], size: 1.4, rotationDeg: [4, 5, 6] },
      overlay: doc.images?.[0]?.overlay,
    });
    expect(next.images?.[2]?.overlay.position).toEqual(doc.images?.[0]?.overlay.position);
  });

  it("clones an Overlay image from execution-time state and retains its Stage placement", () => {
    const plannedDoc: SceneDoc = {
      version: 1,
      images: [
        {
          id: "img1",
          src: "assets/planned.png",
          host: "stage",
          stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
          overlay: {
            position: [0, 0],
            size: 0.2,
            rotationDeg: 0,
            shape: "none",
            layer: "above",
          },
        },
      ],
    };
    const currentImage: SceneDocImageSpec = {
      id: "img1",
      src: "assets/current.png",
      host: "overlay",
      stage: {
        position: [2, 3, 4],
        size: 1.5,
        rotationDeg: [5, 6, 7],
      },
      overlay: {
        position: [-0.2, 0.3],
        size: 0.35,
        rotationDeg: 8,
        shape: "circle",
        layer: "below",
      },
      castShadow: true,
    };
    const currentDoc: SceneDoc = {
      version: 1,
      images: [
        currentImage,
        {
          ...currentImage,
          id: "img2",
          src: "assets/second.png",
        },
      ],
    };
    const plan = planContentDuplicate(row("image", { kind: "image", id: "img1" }), {
      doc: plannedDoc,
    });
    const next = apply(plan, currentDoc);

    expect(plan?.nextRowId).toBe("image:img3");
    expect(next.images?.[2]).toEqual({
      ...currentImage,
      id: "img3",
      overlay: {
        ...currentImage.overlay,
        position: [
          currentImage.overlay.position[0] + 0.05,
          currentImage.overlay.position[1] - 0.05,
        ],
      },
    });
    expect(next.images?.[2]?.stage).toEqual(currentImage.stage);
  });

  it("takes over an inherited image and selects its first-class duplicate", () => {
    const resolved: FrameDecorationSpec[] = [
      {
        id: "logo",
        src: "assets/logo.png",
        position: [0.1, 0.2],
        size: 0.2,
        layer: "above",
      },
      {
        id: "logo-copy",
        src: "assets/badge.png",
        position: [-0.2, 0.1],
        size: 0.1,
      },
    ];
    const doc: SceneDoc = { version: 1, frame: { background: "accent" } };
    const plan = planContentDuplicate(row("image", { kind: "legacyImage", id: "logo" }), {
      doc,
      resolvedDecorations: resolved,
    });
    const next = apply(plan, doc);

    expect(plan?.nextSelection).toEqual({ kind: "image", id: "img2" });
    expect(plan?.nextRowId).toBe("image:img2");
    expect(plan?.imageOrigins).toEqual([
      { kind: "legacy-promotion", decorationId: "logo", imageId: "img1" },
      { kind: "duplicate", imageId: "img2", sourceImageId: "img1" },
    ]);
    expect(next.frame?.background).toBe("accent");
    expect(next.frame?.decorations?.map((decoration) => decoration.id)).toEqual(["logo-copy"]);
    expect(next.images?.map((image) => image.id)).toEqual(["img1", "img2"]);
    expect(next.images?.[0]?.overlay.position).toEqual([0.1, 0.2]);
    expect(next.images?.[1]?.overlay.position[0]).toBeCloseTo(0.15);
    expect(next.images?.[1]?.overlay.position[1]).toBeCloseTo(0.15);
    expect(resolved).toHaveLength(2);
  });

  it("preserves a queued decoration change and remints against the execution-time list", () => {
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0.1, 0.2], size: 0.2 },
    ];
    const plannedDoc: SceneDoc = { version: 1 };
    const currentDoc: SceneDoc = {
      version: 1,
      frame: {
        decorations: [
          ...resolved,
          { id: "logo-copy", src: "assets/first-copy.png", position: [0, 0], size: 0.1 },
        ],
      },
    };
    const plan = planContentDuplicate(row("image", { kind: "legacyImage", id: "logo" }), {
      doc: plannedDoc,
      resolvedDecorations: resolved,
    });

    const next = apply(plan, currentDoc);

    expect(plan?.nextRowId).toBe("image:img2");
    expect(next.frame?.decorations?.map((decoration) => decoration.id)).toEqual(["logo-copy"]);
    expect(next.images?.map((image) => image.id)).toEqual(["img1", "img2"]);
  });

  it("duplicates the execution-time legacy image rather than the resolved snapshot", () => {
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/resolved.png", position: [0.1, 0.2], size: 0.2 },
    ];
    const plannedDoc: SceneDoc = { version: 1 };
    const currentDoc: SceneDoc = {
      version: 1,
      frame: {
        decorations: [
          {
            id: "logo",
            src: "assets/current.png",
            position: [-0.4, 0.6],
            size: 0.35,
            rotationDeg: 12,
            shape: "circle",
          },
          { id: "queued", src: "assets/queued.png", position: [0, 0], size: 0.1 },
        ],
      },
    };
    const plan = planContentDuplicate(row("image", { kind: "legacyImage", id: "logo" }), {
      doc: plannedDoc,
      resolvedDecorations: resolved,
    });

    const next = apply(plan, currentDoc);

    expect(next.images?.[0]).toMatchObject({
      id: "img1",
      src: "assets/current.png",
      overlay: {
        size: 0.35,
        rotationDeg: 12,
        shape: "circle",
      },
    });
    expect(next.images?.[1]?.overlay.position[0]).toBeCloseTo(-0.35);
    expect(next.images?.[1]?.overlay.position[1]).toBeCloseTo(0.55);
    expect(next.frame?.decorations?.map((decoration) => decoration.id)).toEqual(["queued"]);
  });

  it("does not restore a legacy image removed before its queued duplicate runs", () => {
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/resolved.png", position: [0.1, 0.2], size: 0.2 },
    ];
    const plannedDoc: SceneDoc = { version: 1 };
    const currentDoc: SceneDoc = {
      version: 1,
      frame: {
        decorations: [{ id: "queued", src: "assets/queued.png", position: [0, 0], size: 0.1 }],
      },
    };
    const plan = planContentDuplicate(row("image", { kind: "legacyImage", id: "logo" }), {
      doc: plannedDoc,
      resolvedDecorations: resolved,
    });

    if (!plan) throw new Error("Expected a mutation plan");
    const next = structuredClone(currentDoc);
    const result = plan.apply(next);

    expect(result).toBe(false);
    expect(next.frame?.decorations).toEqual(currentDoc.frame?.decorations);
    expect(next.images).toBeUndefined();
    expect(plan?.nextSelection).toBeNull();
    expect(plan?.imageOrigins).toEqual([]);
  });

  it("duplicates an object with a fresh id and a small placement nudge", () => {
    const doc: SceneDoc = {
      version: 1,
      objects: [
        {
          id: "o1",
          objectId: "ws:coffee-mug",
          placement: { position: [1, -0.2, 0.4], rotationDeg: [0, 20, 0], scale: 1.5 },
        },
        { id: "o2", objectId: "cube" },
      ],
    };
    const plan = planContentDuplicate(row("object", { kind: "object", id: "o1" }), { doc });
    const next = apply(plan, doc);

    expect(plan?.nextRowId).toBe("object:o3");
    expect(next.objects?.[2]).toEqual({
      ...doc.objects?.[0],
      id: "o3",
      placement: {
        position: [1 + OBJECT_DUPLICATE_NUDGE_X, -0.2, 0.4],
        rotationDeg: [0, 20, 0],
        scale: 1.5,
      },
    });
  });

  it("does not invent duplication for singletons", () => {
    const doc: SceneDoc = { version: 1, compare: {} };
    expect(planContentDuplicate(row("comparison", { kind: "comparison" }), { doc })).toBeNull();
  });
});

describe("planContentDelete", () => {
  it("removes a device, its side-table data and its camera binding in one mutation", () => {
    const doc: SceneDoc = {
      version: 1,
      duration: { mode: "follow-media", sourceDeviceId: "d1" },
      devices: [
        { id: "d1", model: "iphone-17-pro" },
        { id: "d2", model: "iphone-17-pro" },
      ],
      deviceLayout: { preset: "row", devices: { d1: { scale: 1.1 }, d2: { scale: 0.9 } } },
      compare: {
        b: {
          media: {
            d1: { src: "assets/after-one.png", kind: "image" },
            d2: { src: "assets/after-two.png", kind: "image" },
          },
        },
      },
      cameraRig: {
        keys: [
          {
            id: "k1",
            tMs: 0,
            pose: {
              position: [0, 0, 5],
              aim: { mode: "object", id: "d1", at: [1, 2, 3] },
            },
          },
        ],
        segments: [],
      },
    };
    const plan = planContentDelete(row("device", { kind: "device", id: "d1" }), { doc });
    const next = apply(plan, doc);

    expect(next.devices?.map((device) => device.id)).toEqual(["d2"]);
    expect(next.deviceLayout?.devices).toEqual({ d2: { scale: 0.9 } });
    expect(next.compare?.b?.media).toEqual({
      d2: { src: "assets/after-two.png", kind: "image" },
    });
    expect(next.cameraRig?.keys[0]?.pose.aim).toEqual({ mode: "point", at: [1, 2, 3] });
    expect(next.duration).toEqual({ mode: "manual" });
  });

  it("retains follow-media when deleting a device that is not its active source", () => {
    const doc: SceneDoc = {
      version: 1,
      duration: { mode: "follow-media", sourceDeviceId: "d2" },
      devices: [
        { id: "d1", model: "iphone-17-pro" },
        { id: "d2", model: "iphone-17-pro" },
      ],
    };
    const next = apply(
      planContentDelete(row("device", { kind: "device", id: "d1" }), { doc }),
      doc,
    );

    expect(next.duration).toEqual({ mode: "follow-media", sourceDeviceId: "d2" });
  });

  it("preserves the current length when deleting an unpinned device video", () => {
    const doc: SceneDoc = {
      version: 1,
      duration: { mode: "follow-media" },
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          media: { src: "assets/demo.mp4", kind: "video" },
        },
        { id: "d2", model: "iphone-17-pro" },
      ],
    };
    const next = apply(
      planContentDelete(row("device", { kind: "device", id: "d1" }), { doc }),
      doc,
    );

    expect(next.duration).toEqual({ mode: "manual" });
  });

  it("materialises the remaining inherited images when one is deleted", () => {
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/logo.png", position: [0, 0], size: 0.2 },
      { id: "badge", src: "assets/badge.png", position: [0.2, 0], size: 0.1 },
    ];
    const doc: SceneDoc = { version: 1 };
    const next = apply(
      planContentDelete(row("image", { kind: "legacyImage", id: "logo" }), {
        doc,
        resolvedDecorations: resolved,
      }),
      doc,
    );
    expect(next.frame?.decorations).toEqual([{ ...resolved[1], stackOrder: 1 }]);
  });

  it("deletes from execution-time decorations without clobbering queued changes", () => {
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/resolved.png", position: [0, 0], size: 0.2 },
      { id: "badge", src: "assets/resolved-badge.png", position: [0.2, 0], size: 0.1 },
    ];
    const plannedDoc: SceneDoc = { version: 1 };
    const currentBadge: FrameDecorationSpec = {
      id: "badge",
      src: "assets/current-badge.png",
      position: [0.5, -0.4],
      size: 0.18,
    };
    const queued: FrameDecorationSpec = {
      id: "queued",
      src: "assets/queued.png",
      position: [-0.3, 0.2],
      size: 0.12,
    };
    const currentDoc: SceneDoc = {
      version: 1,
      frame: {
        background: "accent",
        decorations: [
          { id: "logo", src: "assets/current.png", position: [0.1, 0.1], size: 0.3 },
          currentBadge,
          queued,
        ],
      },
    };
    const plan = planContentDelete(row("image", { kind: "legacyImage", id: "logo" }), {
      doc: plannedDoc,
      resolvedDecorations: resolved,
    });

    const next = apply(plan, currentDoc);

    expect(next.frame).toEqual({
      background: "accent",
      decorations: [
        { ...currentBadge, stackOrder: 1 },
        { ...queued, stackOrder: 2 },
      ],
    });
  });

  it("does not restore a legacy image removed before its queued delete runs", () => {
    const resolved: FrameDecorationSpec[] = [
      { id: "logo", src: "assets/resolved.png", position: [0, 0], size: 0.2 },
    ];
    const plannedDoc: SceneDoc = { version: 1 };
    const currentDoc: SceneDoc = {
      version: 1,
      frame: {
        background: "muted",
        decorations: [{ id: "queued", src: "assets/queued.png", position: [0, 0], size: 0.1 }],
      },
    };
    const plan = planContentDelete(row("image", { kind: "legacyImage", id: "logo" }), {
      doc: plannedDoc,
      resolvedDecorations: resolved,
    });

    if (!plan) throw new Error("Expected a mutation plan");
    const next = structuredClone(currentDoc);
    const result = plan.apply(next);

    expect(result).toBe(false);
    expect(next.frame).toEqual(currentDoc.frame);
  });

  it("removes exactly one first-class image and preserves order", () => {
    const image: Omit<SceneDocImageSpec, "id"> = {
      src: "assets/image.png",
      host: "stage",
      stage: {
        position: [0, 0, 0],
        size: 1,
        rotationDeg: [0, 0, 0],
      },
      overlay: {
        position: [0, 0],
        size: 0.2,
        rotationDeg: 0,
        shape: "none",
        layer: "above",
      },
    };
    const doc: SceneDoc = {
      version: 1,
      images: [
        { ...image, id: "img1" },
        { ...image, id: "img2" },
        { ...image, id: "img3" },
      ],
    };
    const next = apply(
      planContentDelete(row("image", { kind: "image", id: "img2" }), { doc }),
      doc,
    );

    expect(next.images?.map((entry) => entry.id)).toEqual(["img1", "img3"]);
  });

  it("omits the first-class image list when its last item is deleted", () => {
    const doc: SceneDoc = {
      version: 1,
      images: [
        {
          id: "img1",
          src: "assets/image.png",
          host: "overlay",
          stage: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
          overlay: {
            position: [0, 0],
            size: 0.2,
            rotationDeg: 0,
            shape: "none",
            layer: "above",
          },
        },
      ],
    };
    const next = apply(
      planContentDelete(row("image", { kind: "image", id: "img1" }), { doc }),
      doc,
    );

    expect(next.images).toBeUndefined();
  });

  it("removes an object", () => {
    const doc: SceneDoc = {
      version: 1,
      objects: [
        { id: "o1", objectId: "cube" },
        { id: "o2", objectId: "sphere" },
      ],
    };
    const next = apply(
      planContentDelete(row("object", { kind: "object", id: "o1" }), { doc }),
      doc,
    );
    expect(next.objects).toEqual([{ id: "o2", objectId: "sphere" }]);
  });

  it.each([
    ["chart", { chart: {} as NonNullable<SceneDoc["chart"]>, animatedTrack: "chart" }],
    ["comparison", { compare: {}, animatedTrack: "compare" }],
    [
      "screenshotStack",
      {
        layeredScreenshot: {
          layers: [],
          pose: { spread: 0, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0, 0] },
        },
        animatedTrack: "layeredScreenshot",
      },
    ],
  ] as const)("removes %s and clears its active animated track", (type, fields) => {
    const target =
      type === "chart"
        ? ({ kind: "chart" } as const)
        : type === "comparison"
          ? ({ kind: "comparison" } as const)
          : ({ kind: "screenshotStack" } as const);
    const doc = { version: 1, ...fields } as SceneDoc;
    const next = apply(planContentDelete(row(type, target), { doc }), doc);
    expect(next.animatedTrack).toBeUndefined();
    expect(next.chart).toBeUndefined();
    expect(next.compare).toBeUndefined();
    expect(next.layeredScreenshot).toBeUndefined();
  });

  it("removes video and screenshot camera bindings while preserving their shots", () => {
    const videoDoc: SceneDoc = {
      version: 1,
      videoWindow: { media: { src: "assets/demo.mp4" }, radius: "macos" },
      duration: { mode: "follow-media", source: "videoWindow" },
      cameraRig: {
        keys: [
          {
            id: "k1",
            tMs: 0,
            pose: {
              position: [0, 0, 5],
              aim: { mode: "object", id: "videoWindow", at: [0, 0, 0] },
            },
          },
        ],
        segments: [],
      },
    };
    const videoNext = apply(
      planContentDelete(row("video", { kind: "videoWindow" }), { doc: videoDoc }),
      videoDoc,
    );
    expect(videoNext.videoWindow).toBeUndefined();
    expect(videoNext.cameraRig?.keys[0]?.pose.aim).toEqual({ mode: "point", at: [0, 0, 0] });
    expect(videoNext.duration).toEqual({ mode: "manual" });

    const stackDoc: SceneDoc = {
      version: 1,
      layeredScreenshot: {
        layers: [],
        pose: { spread: 0, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0.4, 0.2] },
      },
      cameraRig: {
        keys: [
          {
            id: "k1",
            tMs: 0,
            pose: {
              position: [0, 0, 5],
              aim: { mode: "object", id: "layeredScreenshot", at: [0.4, 0.2, 0] },
            },
          },
        ],
        segments: [],
      },
    };
    const stackNext = apply(
      planContentDelete(row("screenshotStack", { kind: "screenshotStack" }), { doc: stackDoc }),
      stackDoc,
    );
    expect(stackNext.cameraRig?.keys[0]?.pose.aim).toEqual({
      mode: "point",
      at: [0.4, 0.2, 0],
    });
  });

  it("retains follow-media when the deleted video window is not its active source", () => {
    const doc: SceneDoc = {
      version: 1,
      duration: { mode: "follow-media", sourceDeviceId: "d1" },
      devices: [
        {
          id: "d1",
          model: "iphone-17-pro",
          media: { src: "assets/device.mp4", kind: "video" },
        },
      ],
      videoWindow: { media: { src: "assets/demo.mp4" }, radius: "macos" },
    };
    const next = apply(planContentDelete(row("video", { kind: "videoWindow" }), { doc }), doc);

    expect(next.duration).toEqual({ mode: "follow-media", sourceDeviceId: "d1" });
  });

  it("preserves the current length when an unpinned video window is the fallback source", () => {
    const doc: SceneDoc = {
      version: 1,
      duration: { mode: "follow-media" },
      devices: [{ id: "d1", model: "iphone-17-pro" }],
      videoWindow: { media: { src: "assets/demo.mp4" }, radius: "macos" },
    };
    const next = apply(planContentDelete(row("video", { kind: "videoWindow" }), { doc }), doc);

    expect(next.duration).toEqual({ mode: "manual" });
  });

  it("removes only screenshot-owned text and text-style keys", () => {
    const doc: SceneDoc = {
      version: 1,
      text: {
        "ls-label": "Screenshot label",
        "ls-screen": "Unrelated text using a screen id",
        "ls-labelExtra": "Different text key",
        title: "Keep me",
      },
      textStyle: {
        "ls-labelColor": "#ffffff",
        "ls-labelFont": "Inter@600",
        "ls-labelSize": 1.2,
        "ls-labelOffsetX": 0.1,
        "ls-labelOffsetY": -0.1,
        "ls-labelLineHeight": 1.3,
        "ls-labelRotationDeg": 4,
        "ls-screenColor": "#123456",
        "ls-labelExtraColor": "#abcdef",
        titleColor: "#000000",
      },
      layeredScreenshot: {
        layers: [
          {
            id: "layer-1",
            visible: true,
            z: 0,
            items: [
              { id: "label", kind: "text", attach: null },
              {
                id: "screen",
                kind: "screen",
                attach: { to: "label", side: "right" },
                src: "assets/screen.png",
                media: "image",
              },
            ],
          },
        ],
        pose: { spread: 0, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0, 0] },
      },
    };
    const next = apply(
      planContentDelete(row("screenshotStack", { kind: "screenshotStack" }), { doc }),
      doc,
    );

    expect(next.text).toEqual({
      "ls-screen": "Unrelated text using a screen id",
      "ls-labelExtra": "Different text key",
      title: "Keep me",
    });
    expect(next.textStyle).toEqual({
      "ls-screenColor": "#123456",
      "ls-labelExtraColor": "#abcdef",
      titleColor: "#000000",
    });
  });

  it("removes empty screenshot-owned text maps", () => {
    const doc: SceneDoc = {
      version: 1,
      text: { "ls-label": "Screenshot label" },
      textStyle: { "ls-labelSize": 1.2 },
      layeredScreenshot: {
        layers: [
          {
            id: "layer-1",
            visible: true,
            z: 0,
            items: [{ id: "label", kind: "text", attach: null }],
          },
        ],
        pose: { spread: 0, azimuthDeg: 0, elevationDeg: 0, zoom: 1, pan: [0, 0] },
      },
    };
    const next = apply(
      planContentDelete(row("screenshotStack", { kind: "screenshotStack" }), { doc }),
      doc,
    );

    expect(next.text).toBeUndefined();
    expect(next.textStyle).toBeUndefined();
  });

  it("hides and refuses deletion for legacy text", () => {
    const doc: SceneDoc = { version: 1, text: { title: "Hello" } };
    expect(planContentDelete(row("text", { kind: "text", id: "title" }), { doc })).toBeNull();
  });
});
