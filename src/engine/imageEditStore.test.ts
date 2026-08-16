import { beforeEach, describe, expect, it } from "vitest";
import { imageEditCommitMatches, useImageEditStore } from "./imageEditStore";

const store = () => useImageEditStore.getState();

describe("imageEditStore", () => {
  beforeEach(() => store().reset());

  it("keeps image selection scoped to its scene", () => {
    store().select({ sceneIndex: 2, imageId: "img1" });

    expect(store().selected).toEqual({ sceneIndex: 2, imageId: "img1" });
  });

  it("holds completed Stage and Overlay placement commits", () => {
    store().requestCommit({
      sceneIndex: 1,
      imageId: "img1",
      kind: "stage",
      placement: { position: [1, 2, 3], size: 1.4, rotationDeg: [10, 20, 30] },
    });
    expect(store().pendingCommit?.kind).toBe("stage");

    store().requestCommit({
      sceneIndex: 1,
      imageId: "img1",
      kind: "overlay",
      placement: {
        position: [0.2, -0.3],
        size: 0.4,
        rotationDeg: 12,
        shape: "circle",
        layer: "above",
      },
    });
    expect(store().pendingCommit?.kind).toBe("overlay");

    store().clearCommit();
    expect(store().pendingCommit).toBeNull();
  });

  it("keeps live placement separate from the one-shot commit", () => {
    const preview = {
      sceneIndex: 1,
      imageId: "img1",
      kind: "stage" as const,
      placement: {
        position: [1, 2, 3] as [number, number, number],
        size: 1.4,
        rotationDeg: [10, 20, 30] as [number, number, number],
      },
    };

    store().select({ sceneIndex: 1, imageId: "img1" });
    store().preview(preview);
    expect(store().previewPlacement).toEqual(preview);
    expect(store().pendingCommit).toBeNull();

    store().requestCommit(preview);
    store().clearCommit();
    expect(store().pendingCommit).toBeNull();
    expect(store().previewPlacement).toEqual(preview);

    store().clearPreview();
    expect(store().previewPlacement).toBeNull();
  });

  it("matches only the exact preview that produced a completed commit", () => {
    const stage = {
      sceneIndex: 1,
      imageId: "img1",
      kind: "stage" as const,
      placement: {
        position: [1, 2, 3] as [number, number, number],
        size: 1.4,
        rotationDeg: [10, 20, 30] as [number, number, number],
      },
    };
    expect(imageEditCommitMatches(stage, structuredClone(stage))).toBe(true);
    expect(
      imageEditCommitMatches(stage, {
        ...stage,
        imageId: "img2",
      }),
    ).toBe(false);
    expect(
      imageEditCommitMatches(stage, {
        ...stage,
        placement: { ...stage.placement, position: [1.1, 2, 3] },
      }),
    ).toBe(false);
  });

  it("drops live placement when the selected image changes or clears", () => {
    store().select({ sceneIndex: 0, imageId: "img1" });
    store().preview({
      sceneIndex: 0,
      imageId: "img1",
      kind: "overlay",
      placement: {
        position: [0.2, -0.3],
        size: 0.4,
        rotationDeg: 12,
        shape: "none",
        layer: "above",
      },
    });
    store().select({ sceneIndex: 0, imageId: "img1" });
    expect(store().previewPlacement).not.toBeNull();

    store().select({ sceneIndex: 0, imageId: "img2" });
    expect(store().previewPlacement).toBeNull();

    store().preview({
      sceneIndex: 0,
      imageId: "img2",
      kind: "stage",
      placement: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
    });
    store().select(null);
    expect(store().previewPlacement).toBeNull();
  });

  it("resets all editor-only state", () => {
    store().select({ sceneIndex: 0, imageId: "img1" });
    store().setGizmoMode("rotate");
    store().requestCommit({
      sceneIndex: 0,
      imageId: "img1",
      kind: "stage",
      placement: { position: [0, 0, 0], size: 1, rotationDeg: [0, 0, 0] },
    });

    store().reset();

    expect(store().selected).toBeNull();
    expect(store().gizmoMode).toBe("translate");
    expect(store().previewPlacement).toBeNull();
    expect(store().pendingCommit).toBeNull();
  });
});
