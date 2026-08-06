import { describe, expect, it } from "vitest";
import {
  addKeyAtBeat,
  appliedOrbitPoseAt,
  buildSyncTrack,
  pickSyncMoments,
  SYNC_MAX_KEYS,
  SYNC_PULL_BACK,
  SYNC_PUSH_IN,
} from "./beatCameraSync";
import { DEFAULT_EASE } from "./ease";
import { defaultOrbitPose } from "./sceneCamera";

const ctx = {
  durationMs: 8000,
  windowStartMs: 0,
  windowEndMs: 8000,
  transitionInMs: 0,
  transitionOutStartMs: 8000,
};
const pose = defaultOrbitPose();
const poseAt = () => pose;
const m = (tMs: number, strength: number) => ({ tMs, strength });

describe("pickSyncMoments", () => {
  it("keeps the strongest, spaces them and returns time order", () => {
    expect(
      pickSyncMoments([m(1500, 0.5), m(2000, 1), m(2600, 0.9), m(5000, 0.8)], 0, 8000),
    ).toEqual([2000, 5000]);
  });

  it("leaves room after the span start and drops beats past the end", () => {
    expect(pickSyncMoments([m(800, 1), m(7000, 0.2)], 0, 6000)).toEqual([]);
  });

  it("caps the pick", () => {
    const many = Array.from({ length: 20 }, (_, i) => m(1300 + i * 1300, 0.5));
    expect(pickSyncMoments(many, 0, 60_000)).toHaveLength(SYNC_MAX_KEYS);
  });
});

describe("buildSyncTrack", () => {
  const track = buildSyncTrack(pose, [2000, 4000, 6000], 0);

  it("chains a base key into alternating push/pull keys on the beats", () => {
    expect(track.keys.map((k) => k.tMs)).toEqual([0, 2000, 4000, 6000]);
    expect(track.keys[1].pose.distance).toBeCloseTo(pose.distance * SYNC_PUSH_IN);
    expect(track.keys[2].pose.distance).toBeCloseTo(pose.distance * SYNC_PULL_BACK);
    expect(track.segments).toEqual([
      { from: "k1", to: "k2", ease: DEFAULT_EASE },
      { from: "k2", to: "k3", ease: DEFAULT_EASE },
      { from: "k3", to: "k4", ease: DEFAULT_EASE },
    ]);
  });
});

describe("addKeyAtBeat", () => {
  it("starts a first animation ending on the beat", () => {
    const next = addKeyAtBeat({ keys: [], segments: [] }, ctx, 3000, poseAt);
    expect(next).not.toBeNull();
    const times = (next?.keys ?? []).map((k) => k.tMs).sort((a, b) => a - b);
    expect(times.at(-1)).toBe(3000);
    expect(next?.segments).toHaveLength(1);
  });

  it("splits the segment under the beat", () => {
    const base = buildSyncTrack(pose, [4000], 0);
    const next = addKeyAtBeat(base, ctx, 2000, poseAt);
    expect(next?.keys.some((k) => k.tMs === 2000)).toBe(true);
    expect(next?.segments).toHaveLength(2);
  });

  it("extends past the tail, refuses a cramped beat", () => {
    const base = buildSyncTrack(pose, [4000], 0);
    const grown = addKeyAtBeat(base, ctx, 6000, poseAt);
    expect(grown?.keys.some((k) => k.tMs === 6000)).toBe(true);
    expect(addKeyAtBeat(base, ctx, 4005, poseAt)).toBeNull();
  });
});

describe("appliedOrbitPoseAt", () => {
  it("falls back to the house default", () => {
    expect(appliedOrbitPoseAt(undefined, undefined, 0, 0)).toEqual(defaultOrbitPose());
  });
});
