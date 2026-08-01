import { describe, expect, it } from "vitest";
import {
  addAnimationAuto,
  addSegmentAt,
  type CameraDoc,
  cameraLayout,
  deleteKeyMerged,
  duplicateKey,
  MIN_KEY_GAP_MS,
  mergeGap,
  moveKey,
  moveSegment,
  nearestKey,
  nextKeyId,
  panCentreSnap,
  playheadDriftTarget,
  removeKey,
  removeSegment,
  resizeSegment,
  setSegmentEase,
  syncSegmentStartToPrevious,
  type TrackContext,
} from "./sceneCameraEdit";
import type { SceneDocCameraPose } from "./sceneDocSchema";

const pose = (over: Partial<SceneDocCameraPose> = {}): SceneDocCameraPose => ({
  target: [0, 0, 0],
  azimuthDeg: 0,
  elevationDeg: 0,
  distance: 5,
  ...over,
});

/** k1@0 ── seg ── k2@1000   (gap)   k3@2500 ── seg ── k4@3500, scene 4000ms. */
const doc = (): CameraDoc => ({
  keys: [
    { id: "k1", tMs: 0, pose: pose() },
    { id: "k2", tMs: 1000, pose: pose({ azimuthDeg: 30 }) },
    { id: "k3", tMs: 2500, pose: pose({ azimuthDeg: 30 }) },
    { id: "k4", tMs: 3500, pose: pose({ distance: 3 }) },
  ],
  segments: [
    { from: "k1", to: "k2", ease: "inOutQuad" },
    { from: "k3", to: "k4", ease: "outCubic" },
  ],
});

const DUR = 4000;

describe("cameraLayout", () => {
  it("sorts keys, resolves segment times, keeps doc indices", () => {
    const l = cameraLayout(doc());
    expect(l.keys.map((k) => k.id)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(l.segments[1]).toMatchObject({ docIndex: 1, fromTMs: 2500, toTMs: 3500 });
  });

  it("drops unresolvable segments from the layout", () => {
    const broken = doc();
    broken.segments.push({ from: "k4", to: "ghost", ease: "linear" });
    expect(cameraLayout(broken).segments).toHaveLength(2);
  });
});

describe("moveKey", () => {
  it("moves within walls and rounds to whole ms", () => {
    const next = moveKey(doc(), "k2", 1200.6, DUR);
    expect(next?.keys.find((k) => k.id === "k2")?.tMs).toBe(1201);
  });

  it("clamps against neighbouring keys (hard walls)", () => {
    const next = moveKey(doc(), "k2", 3000, DUR);
    expect(next?.keys.find((k) => k.id === "k2")?.tMs).toBe(2500 - MIN_KEY_GAP_MS);
  });

  it("clamps to the scene edges and never creates a new overhang", () => {
    const next = moveKey(doc(), "k4", 9999, DUR);
    expect(next?.keys.find((k) => k.id === "k4")?.tMs).toBe(DUR);
  });

  it("lets an existing overhang key keep (but not extend) its position", () => {
    const withOverhang = doc();
    withOverhang.keys[3].tMs = 4800; // k4 overhangs a shortened scene
    expect(moveKey(withOverhang, "k4", 5200, DUR)?.keys[3].tMs).toBe(4800);
    expect(moveKey(withOverhang, "k4", 4200, DUR)?.keys[3].tMs).toBe(4200);
  });

  it("returns null for unknown keys", () => {
    expect(moveKey(doc(), "nope", 100, DUR)).toBeNull();
  });
});

describe("moveSegment", () => {
  it("shifts both keys rigidly", () => {
    const next = moveSegment(doc(), "k3", "k4", 200, DUR);
    expect(next?.keys.find((k) => k.id === "k3")?.tMs).toBe(2700);
    expect(next?.keys.find((k) => k.id === "k4")?.tMs).toBe(3700);
  });

  it("clamps against outside keys and the scene end", () => {
    const left = moveSegment(doc(), "k3", "k4", -9999, DUR);
    expect(left?.keys.find((k) => k.id === "k3")?.tMs).toBe(1000 + MIN_KEY_GAP_MS);
    const right = moveSegment(doc(), "k3", "k4", 9999, DUR);
    expect(right?.keys.find((k) => k.id === "k4")?.tMs).toBe(DUR);
  });
});

describe("addSegmentAt", () => {
  it("adds a 1s segment in free space with the default ease", () => {
    const next = addSegmentAt(doc(), 1200, pose(), pose(), DUR);
    expect(next?.segments).toHaveLength(3);
    const added = next?.segments[2];
    const from = next?.keys.find((k) => k.id === added?.from);
    const to = next?.keys.find((k) => k.id === added?.to);
    expect(from?.tMs).toBe(1200);
    expect(to?.tMs).toBe(2200); // full 1s span fits before k3's wall
    expect(added?.ease).toBe("inOutQuad");
  });

  it("truncates against the next key's wall when the span would collide", () => {
    const next = addSegmentAt(doc(), 1800, pose(), pose(), DUR);
    const added = next?.segments[2];
    const to = next?.keys.find((k) => k.id === added?.to);
    expect(to?.tMs).toBe(2500 - MIN_KEY_GAP_MS);
  });

  it("chains off an existing segment-end key (shared boundary)", () => {
    const next = addSegmentAt(doc(), 1000, pose(), pose(), DUR);
    expect(next?.segments[2].from).toBe("k2"); // shared, not duplicated
    expect(next?.keys).toHaveLength(5);
  });

  it("refuses inside an existing segment and in too-small gaps", () => {
    expect(addSegmentAt(doc(), 500, pose(), pose(), DUR)).toBeNull();
    const tight = doc();
    expect(addSegmentAt(tight, 2495, pose(), pose(), DUR)).toBeNull();
  });

  it("truncates at the scene end", () => {
    const next = addSegmentAt(doc(), 3600, pose(), pose(), DUR);
    // 3600 is past k4? No, k4@3500 is behind it; next wall is the scene end.
    const added = next?.segments[2];
    const to = next?.keys.find((k) => k.id === added?.to);
    expect(to?.tMs).toBe(DUR);
  });

  it("mints non-colliding key ids", () => {
    expect(nextKeyId(doc())).toBe("k5");
  });
});

describe("remove operations", () => {
  it("removeSegment drops orphaned keys but keeps shared ones", () => {
    const chained: CameraDoc = {
      keys: doc().keys,
      segments: [
        { from: "k1", to: "k2", ease: "linear" },
        { from: "k2", to: "k3", ease: "linear" },
      ],
    };
    const next = removeSegment(chained, 0);
    expect(next?.keys.map((k) => k.id)).toEqual(["k2", "k3", "k4"]); // k1 orphaned, k2 shared
    expect(next?.segments).toHaveLength(1);
  });

  it("removeKey drops the key and every referencing segment", () => {
    const next = removeKey(doc(), "k2");
    expect(next?.keys).toHaveLength(3);
    expect(next?.segments).toHaveLength(1);
    expect(next?.segments[0].from).toBe("k3");
  });
});

describe("ease + nearest", () => {
  it("setSegmentEase rewrites one segment", () => {
    const next = setSegmentEase(doc(), 1, "jump");
    expect(next?.segments[1].ease).toBe("jump");
    expect(next?.segments[0].ease).toBe("inOutQuad");
  });

  it("nearestKey picks the closest key to a time", () => {
    expect(nearestKey(doc(), 1600)?.id).toBe("k2");
    expect(nearestKey(doc(), 2100)?.id).toBe("k3");
  });
});

describe("syncSegmentStartToPrevious", () => {
  it("merges the start onto the previous end key and drops the old key", () => {
    const next = syncSegmentStartToPrevious(doc(), 1);
    expect(next?.segments[1]).toMatchObject({ from: "k2", to: "k4" });
    expect(next?.keys.some((k) => k.id === "k3")).toBe(false);
  });

  it("returns null when nothing precedes or already chained", () => {
    expect(syncSegmentStartToPrevious(doc(), 0)).toBeNull();
    const chained = syncSegmentStartToPrevious(doc(), 1);
    expect(chained && syncSegmentStartToPrevious(chained, 1)).toBeNull();
  });

  it("refuses when a stray key sits in the swallowed gap", () => {
    const withStray = doc();
    withStray.keys.push({ id: "k9", tMs: 1800, pose: pose() });
    expect(syncSegmentStartToPrevious(withStray, 1)).toBeNull();
  });
});

describe("playheadDriftTarget", () => {
  it("corrects a mid-animation playhead to the nearer 25% point", () => {
    expect(playheadDriftTarget(doc(), 400)).toBe(250);
    expect(playheadDriftTarget(doc(), 600)).toBe(750);
  });

  it("leaves the playhead alone near the ends, on keys, in gaps, and outside", () => {
    expect(playheadDriftTarget(doc(), 100)).toBeNull();
    expect(playheadDriftTarget(doc(), 950)).toBeNull();
    expect(playheadDriftTarget(doc(), 0)).toBeNull();
    expect(playheadDriftTarget(doc(), 1800)).toBeNull();
  });
});

describe("panCentreSnap", () => {
  const centre = [0, 0, 0] as const;

  it("captures both axes when the target sits within the threshold", () => {
    const snap = panCentreSnap(pose({ target: [0.05, -0.03, 0] }), centre, 0.1);
    expect(snap.snappedX).toBe(true);
    expect(snap.snappedY).toBe(true);
    expect(snap.pose.target[0]).toBeCloseTo(0);
    expect(snap.pose.target[1]).toBeCloseTo(0);
  });

  it("leaves a target outside the threshold untouched", () => {
    const p = pose({ target: [2, 1.5, 0] });
    const snap = panCentreSnap(p, centre, 0.1);
    expect(snap).toMatchObject({ snappedX: false, snappedY: false });
    expect(snap.pose).toBe(p);
  });

  it("captures one axis independently of the other", () => {
    const snap = panCentreSnap(pose({ target: [0.05, 2, 0] }), centre, 0.1);
    expect(snap.snappedX).toBe(true);
    expect(snap.snappedY).toBe(false);
    expect(snap.pose.target[0]).toBeCloseTo(0);
    expect(snap.pose.target[1]).toBeCloseTo(2);
  });

  it("never touches the view-axis (depth) component", () => {
    // Azimuth 90°: the camera looks along -X, so world X is depth and world Z is screen-right.
    const snap = panCentreSnap(pose({ target: [1.5, 0.02, -0.04], azimuthDeg: 90 }), centre, 0.1);
    expect(snap.snappedX).toBe(true);
    expect(snap.snappedY).toBe(true);
    expect(snap.pose.target[0]).toBeCloseTo(1.5);
    expect(snap.pose.target[1]).toBeCloseTo(0);
    expect(snap.pose.target[2]).toBeCloseTo(0);
  });

  it("projects along the tilted camera plane at non-zero elevation", () => {
    // Elevation 45°, offset straight up the camera's up axis by 0.05: within threshold, recentres fully.
    const el = Math.PI / 4;
    const up = [0, Math.cos(el), -Math.sin(el)] as const;
    const snap = panCentreSnap(
      pose({ target: [up[0] * 0.05, up[1] * 0.05, up[2] * 0.05], elevationDeg: 45 }),
      centre,
      0.1,
    );
    expect(snap.snappedY).toBe(true);
    expect(snap.pose.target[0]).toBeCloseTo(0);
    expect(snap.pose.target[1]).toBeCloseTo(0);
    expect(snap.pose.target[2]).toBeCloseTo(0);
  });
});

describe("connected camera edits", () => {
  const ctx: TrackContext = {
    durationMs: DUR,
    windowStartMs: 0,
    windowEndMs: DUR,
    transitionInMs: 0,
    transitionOutStartMs: DUR,
  };
  const poseAt = (tMs: number) => pose({ azimuthDeg: tMs / 100 });

  it("addAnimationAuto chains off the last end key with a pose-neutral seed", () => {
    const next = addAnimationAuto(doc(), ctx, 0, poseAt, 200);
    expect(next?.segments[2]).toMatchObject({ from: "k4", to: "k5" });
    expect(next?.keys[4]).toEqual({ id: "k5", tMs: 4000, pose: poseAt(4000) });
    expect(addAnimationAuto(doc(), ctx, 3800, poseAt, 200)?.keys[4].tMs).toBe(3800);
  });

  it("deleteKeyMerged hands back the pose the caller freezes as a static reframe", () => {
    const single: CameraDoc = {
      keys: [
        { id: "k1", tMs: 0, pose: pose({ distance: 7 }) },
        { id: "k2", tMs: 1000, pose: pose({ distance: 2 }) },
      ],
      segments: [{ from: "k1", to: "k2", ease: "inOutQuad" }],
    };
    const result = deleteKeyMerged(single, "k2");
    expect(result?.track).toMatchObject({ keys: [], segments: [] });
    expect(result?.frozenPose).toEqual(pose({ distance: 7 }));
  });

  it("mergeGap closes the fixture's legacy gap in either direction", () => {
    expect(mergeGap(doc(), "k3", "k2")?.segments).toEqual([
      { from: "k1", to: "k2", ease: "inOutQuad" },
      { from: "k2", to: "k4", ease: "outCubic" },
    ]);
    expect(mergeGap(doc(), "k2", "k3")?.keys.map((k) => k.id)).toEqual(["k1", "k3", "k4"]);
  });

  it("resizeSegment ripples the second animation along, gap intact", () => {
    expect(resizeSegment(doc(), ctx, 0, 1400)?.keys.map((k) => k.tMs)).toEqual([
      0, 1400, 2900, 3900,
    ]);
  });
});

describe("presentLoop preservation", () => {
  const looped = (): CameraDoc => ({ ...doc(), presentLoop: { mode: "smooth", blendMs: 1500 } });
  const loop = { mode: "smooth", blendMs: 1500 };
  const ctx: TrackContext = {
    durationMs: 4000,
    windowStartMs: 0,
    windowEndMs: 4000,
    transitionInMs: 0,
    transitionOutStartMs: 4000,
  };

  it("survives every mutation that rebuilds the doc", () => {
    const added = addSegmentAt(looped(), 1500, pose(), pose({ azimuthDeg: 10 }), 4000, 800);
    expect(added?.presentLoop).toEqual(loop);
    expect(removeSegment(looped(), 0)?.presentLoop).toEqual(loop);
    expect(removeKey(looped(), "k2")?.presentLoop).toEqual(loop);
    expect(syncSegmentStartToPrevious(looped(), 1)?.presentLoop).toEqual(loop);
    expect(moveKey(looped(), "k2", 1200, 4000)?.presentLoop).toEqual(loop);
  });

  it("survives the connected ops too, including the collapse to a frozen pose", () => {
    expect(addAnimationAuto(looped(), ctx, 0, () => pose(), 200)?.presentLoop).toEqual(loop);
    expect(duplicateKey(looped(), ctx, "k1", 200)?.presentLoop).toEqual(loop);
    expect(deleteKeyMerged(looped(), "k2")?.track.presentLoop).toEqual(loop);
    expect(mergeGap(looped(), "k3", "k2")?.presentLoop).toEqual(loop);
    expect(resizeSegment(looped(), ctx, 0, 1400)?.presentLoop).toEqual(loop);
  });
});
