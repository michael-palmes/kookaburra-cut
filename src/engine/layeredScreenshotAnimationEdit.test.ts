import { describe, expect, it } from "vitest";
import {
  addSegmentAt,
  type LayeredScreenshotAnimationDoc,
  moveKey,
  panCentreSnap,
  trackLayout,
} from "./layeredScreenshotAnimationEdit";
import type { LayeredScreenshotPose, SceneDocLayeredScreenshot } from "./sceneDocSchema";
import { defaultLayeredScreenshotPose } from "./sceneLayeredScreenshot";

const pose = (over: Partial<LayeredScreenshotPose> = {}): LayeredScreenshotPose => ({
  ...defaultLayeredScreenshotPose(),
  ...over,
});

// The generic behaviour is pinned exhaustively by sceneCameraEdit.test.ts; these are LS-shape smokes.
describe("the LS animation doc type", () => {
  it("the sidecar animation block is assignable to the edit doc (compile-time pin)", () => {
    const block: NonNullable<SceneDocLayeredScreenshot["animation"]> = {
      keys: [{ id: "k1", tMs: 0, pose: pose() }],
      segments: [],
    };
    const doc: LayeredScreenshotAnimationDoc = block;
    expect(trackLayout(doc).keys).toHaveLength(1);
  });

  it("mutations carry LS poses through", () => {
    const doc: LayeredScreenshotAnimationDoc = { keys: [], segments: [] };
    const added = addSegmentAt(doc, 0, pose(), pose({ spread: 1, azimuthDeg: 30 }), 5000);
    if (!added) throw new Error("segment expected");
    expect(added.keys[1].pose.spread).toBe(1);
    const moved = moveKey(added, added.keys[1].id, 2000, 5000);
    expect(moved?.keys[1].tMs).toBe(2000);
    expect(moved?.keys[1].pose.azimuthDeg).toBe(30);
  });
});

describe("panCentreSnap", () => {
  it("captures both axes within the threshold", () => {
    const r = panCentreSnap(pose({ pan: [0.02, -0.03] }), 0.05);
    expect(r.pose.pan).toEqual([0, 0]);
    expect(r.snappedX).toBe(true);
    expect(r.snappedY).toBe(true);
  });

  it("leaves a pan outside the threshold untouched", () => {
    const p = pose({ pan: [0.4, -0.4] });
    const r = panCentreSnap(p, 0.05);
    expect(r.pose).toBe(p);
    expect(r.snappedX).toBe(false);
    expect(r.snappedY).toBe(false);
  });

  it("captures one axis independently and keeps the other pose fields", () => {
    const r = panCentreSnap(pose({ pan: [0.01, 0.5], zoom: 2, spread: 0.7 }), 0.05);
    expect(r.pose.pan).toEqual([0, 0.5]);
    expect(r.snappedX).toBe(true);
    expect(r.snappedY).toBe(false);
    expect(r.pose.zoom).toBe(2);
    expect(r.pose.spread).toBe(0.7);
  });
});
