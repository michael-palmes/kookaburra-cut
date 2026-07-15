import { describe, expect, it } from "vitest";
import {
  addSegmentAt,
  type CameraDoc,
  cameraLayout,
  MIN_KEY_GAP_MS,
  moveKey,
  moveSegment,
  nearestKey,
  nextKeyId,
  removeKey,
  removeSegment,
  setSegmentEase,
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
