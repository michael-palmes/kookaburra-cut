import { describe, expect, it } from "vitest";
import type { SceneImageOverlayPlacement } from "../engine/sceneDocSchema";
import { overlayMediaGizmoBox } from "./ImageOverlayGizmo";

const RECT = { width: 1600, height: 900 };
const FRAME_ASPECT = 16 / 9;

const placement = (over: Partial<SceneImageOverlayPlacement> = {}): SceneImageOverlayPlacement => ({
  position: [0, 0],
  size: 0.3,
  rotationDeg: 0,
  shape: "none",
  layer: "above",
  ...over,
});

describe("overlayMediaGizmoBox", () => {
  it("sizes a still by its own aspect: the size IS the width", () => {
    const phone = overlayMediaGizmoBox("image", placement(), 1170 / 2532, FRAME_ASPECT, RECT);
    expect(phone.width).toBeCloseTo(0.3 * RECT.width, 6);
    expect(phone.height).toBeCloseTo(phone.width / (1170 / 2532), 6);
    // A landscape still keeps the same rule, so the box is never square by default.
    const wide = overlayMediaGizmoBox("image", placement(), 16 / 9, FRAME_ASPECT, RECT);
    expect(wide.height).toBeCloseTo(wide.width / (16 / 9), 6);
  });

  it("keeps the window's contain fit for a clip, whatever chrome it wears", () => {
    const wide = overlayMediaGizmoBox(
      "video",
      placement({ size: 0.72 }),
      16 / 9,
      FRAME_ASPECT,
      RECT,
    );
    expect(wide.width).toBeCloseTo(0.72 * RECT.width, 6);
    const tall = overlayMediaGizmoBox(
      "video",
      placement({ size: 0.72 }),
      9 / 16,
      FRAME_ASPECT,
      RECT,
    );
    expect(tall.height).toBeCloseTo(0.72 * RECT.height, 6);
    expect(tall.width).toBeCloseTo(tall.height * (9 / 16), 6);
  });

  it("makes a circle crop square", () => {
    const circle = overlayMediaGizmoBox(
      "image",
      placement({ shape: "circle" }),
      1170 / 2532,
      FRAME_ASPECT,
      RECT,
    );
    expect(circle.height).toBe(circle.width);
  });
});
