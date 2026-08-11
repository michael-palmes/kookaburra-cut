import { beforeEach, describe, expect, it } from "vitest";
import { useImageEditStore } from "./imageEditStore";

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
    expect(store().pendingCommit).toBeNull();
  });
});
