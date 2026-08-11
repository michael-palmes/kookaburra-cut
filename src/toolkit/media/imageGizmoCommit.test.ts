import { describe, expect, it } from "vitest";
import { overlayImageGizmoCommit, stageImageGizmoCommit } from "./imageGizmoCommit";

describe("image gizmo commits", () => {
  it("rounds and clamps a Stage pose to the inspector grid", () => {
    expect(
      stageImageGizmoCommit(2, "img1", {
        position: [4.123, -9, -4.126],
        rotationDeg: [190, -181.24, 359.96],
        size: 8,
      }),
    ).toEqual({
      sceneIndex: 2,
      imageId: "img1",
      kind: "stage",
      placement: {
        position: [4, -3, -4],
        rotationDeg: [-170, 178.8, 0],
        size: 5,
      },
    });
  });

  it("rounds and clamps an Overlay pose while retaining appearance", () => {
    expect(
      overlayImageGizmoCommit(3, "img2", {
        position: [1.42, -0.346],
        size: 0.012,
        rotationDeg: 400.04,
        shape: "circle",
        layer: "below",
      }),
    ).toEqual({
      sceneIndex: 3,
      imageId: "img2",
      kind: "overlay",
      placement: {
        position: [1, -0.35],
        size: 0.03,
        rotationDeg: 40,
        shape: "circle",
        layer: "below",
      },
    });
  });
});
