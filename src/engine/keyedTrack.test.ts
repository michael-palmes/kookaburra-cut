import { describe, expect, it } from "vitest";
import { DEFAULT_EASE } from "./ease";
import {
  addAnimationAuto,
  addedKey,
  clampTrackToDuration,
  deleteKeyMerged,
  duplicateKey,
  duplicateKeyBefore,
  junctionInfo,
  type KeyedTrack,
  type KeyedTrackSegment,
  keyWalls,
  MIN_KEY_GAP_MS,
  mergeGap,
  moveKey,
  moveSegment,
  resizeBounds,
  resizeSegment,
  setSegmentChannelEase,
  setSegmentSmooth,
  splitSegmentAt,
  type TrackContext,
} from "./keyedTrack";

type Pose = { d: number };

function track(
  keys: [string, number][],
  segments: [string, string][],
  extra: Record<string, unknown> = {},
): KeyedTrack<Pose> & Record<string, unknown> {
  return {
    ...extra,
    keys: keys.map(([id, tMs]) => ({ id, tMs, pose: { d: 1 } })),
    segments: segments.map(([from, to]) => ({ from, to, ease: "inOutSine" })),
  };
}

const K = (id: string, tMs: number, d = 1) => ({ id, tMs, pose: { d } });
const S = (from: string, to: string, ease = "linear") => ({ from, to, ease });

/** A whole-scene window with no transitions, the simple case each test narrows. */
const ctx = (over: Partial<TrackContext> = {}): TrackContext => ({
  durationMs: 4000,
  windowStartMs: 0,
  windowEndMs: 4000,
  transitionInMs: 0,
  transitionOutStartMs: 4000,
  ...over,
});

/** Pose-neutral seeds: the pose carries the time it was sampled at, so "which time was sampled" is assertable. */
const poseAt = (tMs: number): Pose => ({ d: tMs });

/** k1@0 ─linear─ k2@1000 ─outCubic─ k3@3000: one connected chain, k2 a junction. */
const chain = (): KeyedTrack<Pose> => ({
  keys: [K("k1", 0, 1), K("k2", 1000, 2), K("k3", 3000, 3)],
  segments: [S("k1", "k2"), S("k2", "k3", "outCubic")],
});

describe("clampTrackToDuration", () => {
  it("clamps an overhanging end key to the new end, pose untouched", () => {
    const t = track(
      [
        ["k1", 0],
        ["k2", 3000],
      ],
      [["k1", "k2"]],
    );
    const next = clampTrackToDuration(t, 2000);
    expect(next.keys.map((k) => k.tMs)).toEqual([0, 2000]);
    expect(next.keys[1].pose).toEqual({ d: 1 });
    expect(next.segments).toHaveLength(1);
  });

  it("removes a segment fully past the end and keeps walking backwards", () => {
    const t = track(
      [
        ["k1", 0],
        ["k2", 1000],
        ["k3", 2500],
        ["k4", 3500],
      ],
      [
        ["k1", "k2"],
        ["k3", "k4"],
      ],
    );
    const next = clampTrackToDuration(t, 2000);
    expect(next.segments).toEqual([{ from: "k1", to: "k2", ease: "inOutSine" }]);
    expect(next.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
  });

  it("removes as many segments as needed, clamping the last survivor", () => {
    const t = track(
      [
        ["k1", 0],
        ["k2", 1500],
        ["k3", 2500],
        ["k4", 3500],
      ],
      [
        ["k1", "k2"],
        ["k2", "k3"],
        ["k3", "k4"],
      ],
    );
    const next = clampTrackToDuration(t, 1000);
    expect(next.segments).toEqual([{ from: "k1", to: "k2", ease: "inOutSine" }]);
    expect(next.keys.map((k) => [k.id, k.tMs])).toEqual([
      ["k1", 0],
      ["k2", 1000],
    ]);
  });

  it("keeps a chained boundary key that a surviving segment still references", () => {
    const t = track(
      [
        ["k1", 0],
        ["k2", 1000],
        ["k3", 3000],
      ],
      [
        ["k1", "k2"],
        ["k2", "k3"],
      ],
    );
    const next = clampTrackToDuration(t, 500);
    expect(next.segments).toEqual([{ from: "k1", to: "k2", ease: "inOutSine" }]);
    expect(next.keys.map((k) => [k.id, k.tMs])).toEqual([
      ["k1", 0],
      ["k2", 500],
    ]);
  });

  it("drops a clamped segment whose span would fall under the minimum gap", () => {
    const t = track(
      [
        ["k1", 2000 - MIN_KEY_GAP_MS + 5],
        ["k2", 2600],
      ],
      [["k1", "k2"]],
    );
    const next = clampTrackToDuration(t, 2000);
    expect(next.segments).toEqual([]);
    expect(next.keys).toEqual([]);
  });

  it("keeps a clamped segment with exactly the minimum span", () => {
    const t = track(
      [
        ["k1", 2000 - MIN_KEY_GAP_MS],
        ["k2", 2600],
      ],
      [["k1", "k2"]],
    );
    const next = clampTrackToDuration(t, 2000);
    expect(next.segments).toHaveLength(1);
    expect(next.keys.map((k) => k.tMs)).toEqual([2000 - MIN_KEY_GAP_MS, 2000]);
  });

  it("growth and clean tracks are identity no-ops", () => {
    const t = track(
      [
        ["k1", 0],
        ["k2", 1000],
      ],
      [["k1", "k2"]],
    );
    expect(clampTrackToDuration(t, 4000)).toBe(t);
    expect(clampTrackToDuration(t, 1000)).toBe(t);
  });

  it("carries extra track fields through (presentLoop convention)", () => {
    const t = track(
      [
        ["k1", 0],
        ["k2", 3000],
      ],
      [["k1", "k2"]],
      { presentLoop: { mode: "bounce" } },
    );
    const next = clampTrackToDuration(t, 2000);
    expect(next.presentLoop).toEqual({ mode: "bounce" });
  });
});

describe("setSegmentChannelEase / setSegmentSmooth", () => {
  const rig: KeyedTrack<{ n: number }> = {
    keys: [
      { id: "a", tMs: 0, pose: { n: 0 } },
      { id: "b", tMs: 500, pose: { n: 1 } },
      { id: "c", tMs: 1000, pose: { n: 2 } },
    ],
    segments: [
      { from: "a", to: "b", ease: "linear" },
      { from: "b", to: "c", ease: "inOutQuad" },
    ],
  };

  it("sets one channel on one segment, leaving its neighbours untouched", () => {
    const next = setSegmentChannelEase(rig, 0, "easeLens", "outExpo");
    expect(next?.segments[0]).toMatchObject({ ease: "linear", easeLens: "outExpo" });
    expect(next?.segments[1]).toEqual(rig.segments[1]);
  });

  it("clearing DELETES the field rather than duplicating the segment's ease", () => {
    const set = setSegmentChannelEase(rig, 0, "easeRotation", "inSine");
    const cleared = setSegmentChannelEase(
      set as KeyedTrack<{ n: number }>,
      0,
      "easeRotation",
      undefined,
    );
    expect(cleared?.segments[0]).not.toHaveProperty("easeRotation");
  });

  it("returns null for an unknown segment index", () => {
    expect(setSegmentChannelEase(rig, 7, "easePosition", "linear")).toBeNull();
    expect(setSegmentSmooth(rig, 7, false)).toBeNull();
  });

  it("smooth polarity: turning it off writes false, turning it back on deletes the field", () => {
    const off = setSegmentSmooth(rig, 1, false);
    expect(off?.segments[1]).toMatchObject({ smooth: false });
    const on = setSegmentSmooth(off as KeyedTrack<{ n: number }>, 1, true);
    expect(on?.segments[1]).not.toHaveProperty("smooth");
  });
});

describe("junctionInfo", () => {
  it("names both segments on a junction and one at each end", () => {
    expect(junctionInfo(chain(), "k2")).toMatchObject({
      prevSeg: { docIndex: 0 },
      nextSeg: { docIndex: 1 },
    });
    expect(junctionInfo(chain(), "k1").prevSeg).toBeNull();
    expect(junctionInfo(chain(), "k3").nextSeg).toBeNull();
  });

  it("reports nothing for an unattached key or an unknown id", () => {
    const stray = { ...chain(), keys: [...chain().keys, K("k9", 3500)] };
    expect(junctionInfo(stray, "k9")).toEqual({ prevSeg: null, nextSeg: null });
    expect(junctionInfo(stray, "nope")).toEqual({ prevSeg: null, nextSeg: null });
  });
});

describe("addAnimationAuto", () => {
  const empty = (): KeyedTrack<Pose> => ({ keys: [], segments: [] });

  it("case 1: starts at the end of the transition in and runs 25% of the window", () => {
    const c = ctx({
      windowStartMs: 200,
      windowEndMs: 3800,
      transitionInMs: 400,
      transitionOutStartMs: 3600,
    });
    const next = addAnimationAuto(empty(), c, 0, poseAt, 200);
    expect(next?.keys).toEqual([
      { id: "k1", tMs: 400, pose: { d: 400 } },
      { id: "k2", tMs: 1300, pose: { d: 1300 } },
    ]);
    expect(next?.segments).toEqual([{ from: "k1", to: "k2", ease: DEFAULT_EASE }]);
  });

  it("case 1: absorbs a lone static key, seeding the start pose from it", () => {
    const statik: KeyedTrack<Pose> = { keys: [K("k1", 0, 9)], segments: [] };
    const next = addAnimationAuto(statik, ctx(), 0, poseAt, 200);
    expect(next?.keys).toHaveLength(2);
    expect(next?.keys[0]).toEqual({ id: "k1", tMs: 0, pose: { d: 9 } });
    expect(next?.keys[1].pose).toEqual({ d: 1000 });
  });

  it("case 1: clamps the end to the start of the transition out", () => {
    const next = addAnimationAuto(empty(), ctx({ transitionOutStartMs: 600 }), 0, poseAt, 200);
    expect(next?.keys[1].tMs).toBe(600);
  });

  it("case 2: chains off the last end key to a new key at the playhead", () => {
    const start: KeyedTrack<Pose> = {
      keys: [K("k1", 0), K("k2", 1000)],
      segments: [S("k1", "k2")],
    };
    const next = addAnimationAuto(start, ctx(), 2500, poseAt, 200);
    expect(next?.segments[1]).toEqual({ from: "k2", to: "k3", ease: DEFAULT_EASE });
    expect(next?.keys[2]).toEqual({ id: "k3", tMs: 2500, pose: { d: 2500 } });
  });

  it("case 2: a playhead inside the outgoing transition is honoured, clamped only to the window end", () => {
    const start: KeyedTrack<Pose> = {
      keys: [K("k1", 0), K("k2", 1000)],
      segments: [S("k1", "k2")],
    };
    const c = ctx({ windowEndMs: 3800, transitionOutStartMs: 2000 });
    expect(addAnimationAuto(start, c, 3000, poseAt, 200)?.keys[2].tMs).toBe(3000);
    expect(addAnimationAuto(start, c, 5000, poseAt, 200)?.keys[2].tMs).toBe(3800);
  });

  it("case 3: a playhead on (or before) the chain appends 25% of the window after it", () => {
    const start: KeyedTrack<Pose> = {
      keys: [K("k1", 0), K("k2", 1000)],
      segments: [S("k1", "k2")],
    };
    const next = addAnimationAuto(start, ctx(), 500, poseAt, 200);
    expect(next?.keys[2].tMs).toBe(2000);
    expect(next?.segments[1].from).toBe("k2");
  });

  it("case 3: truncates against a legacy stray key's wall", () => {
    const strayed: KeyedTrack<Pose> = {
      keys: [K("k1", 0), K("k2", 1000), K("k9", 1500)],
      segments: [S("k1", "k2")],
    };
    expect(addAnimationAuto(strayed, ctx(), 0, poseAt, 200)?.keys[3].tMs).toBe(
      1500 - MIN_KEY_GAP_MS,
    );
  });

  it("case 4: null whenever the minimum length does not fit", () => {
    const c = ctx({ transitionInMs: 3900, transitionOutStartMs: 3950 });
    expect(addAnimationAuto(empty(), c, 0, poseAt, 200)).toBeNull();
    const late: KeyedTrack<Pose> = {
      keys: [K("k1", 3000), K("k2", 3900)],
      segments: [S("k1", "k2")],
    };
    // Case 3: no room before the transition out.
    expect(addAnimationAuto(late, ctx({ transitionOutStartMs: 3950 }), 0, poseAt, 200)).toBeNull();
    // Case 2: the playhead clears the chain but the window end does not.
    expect(addAnimationAuto(late, ctx({ windowEndMs: 3950 }), 4200, poseAt, 200)).toBeNull();
  });
});

describe("duplicateKey", () => {
  it("splits the following animation in half, holding the pose across the new front half", () => {
    const next = duplicateKey(chain(), ctx(), "k2", 200);
    expect(next?.keys[3]).toEqual({ id: "k4", tMs: 2000, pose: { d: 2 } });
    expect(next?.segments).toEqual([
      { from: "k1", to: "k2", ease: "linear" },
      { from: "k4", to: "k3", ease: "outCubic" },
      { from: "k2", to: "k4", ease: DEFAULT_EASE },
    ]);
    const hold = next?.segments[2];
    const from = next?.keys.find((k) => k.id === hold?.from);
    const to = next?.keys.find((k) => k.id === hold?.to);
    expect(from?.pose).toEqual(to?.pose);
  });

  it("keeps the compressed segment's channel eases and smoothing", () => {
    const rich: KeyedTrack<Pose> & {
      segments: (KeyedTrackSegment & { easeLens?: string; smooth?: boolean })[];
    } = {
      keys: chain().keys,
      segments: [
        S("k1", "k2"),
        { ...S("k2", "k3", "outCubic"), easeLens: "inSine", smooth: false },
      ],
    };
    const next = duplicateKey(rich, ctx(), "k2", 200);
    expect(next?.segments[1]).toEqual({
      from: "k4",
      to: "k3",
      ease: "outCubic",
      easeLens: "inSine",
      smooth: false,
    });
  });

  it("appends a hold after the last key under the case-3 rules", () => {
    const next = duplicateKey(chain(), ctx(), "k3", 200);
    expect(next?.keys[3]).toEqual({ id: "k4", tMs: 4000, pose: { d: 3 } });
    expect(next?.segments[2]).toEqual({ from: "k3", to: "k4", ease: DEFAULT_EASE });
  });

  it("is disabled when half the following animation is under the minimum length", () => {
    expect(duplicateKey(chain(), ctx(), "k2", 1200)).toBeNull();
  });

  it("is disabled at the end of the track when no room is left", () => {
    expect(duplicateKey(chain(), ctx({ transitionOutStartMs: 3100 }), "k3", 200)).toBeNull();
    expect(duplicateKey(chain(), ctx(), "nope", 200)).toBeNull();
  });
});

describe("duplicateKeyBefore", () => {
  it("splits the previous animation in half, holding the pose across the new back half", () => {
    const next = duplicateKeyBefore(chain(), ctx(), "k2", 200);
    expect(next?.keys[3]).toEqual({ id: "k4", tMs: 500, pose: { d: 2 } });
    expect(next?.segments).toEqual([
      { from: "k1", to: "k4", ease: "linear" },
      { from: "k2", to: "k3", ease: "outCubic" },
      { from: "k4", to: "k2", ease: DEFAULT_EASE },
    ]);
  });

  it("inserts a hold before the first key, floored at the end of the transition in", () => {
    const lead: KeyedTrack<Pose> = {
      keys: [K("a", 1500, 7), K("b", 2500)],
      segments: [S("a", "b")],
    };
    expect(duplicateKeyBefore(lead, ctx({ transitionInMs: 300 }), "a", 200)?.keys[2]).toEqual({
      id: "k1",
      tMs: 500,
      pose: { d: 7 },
    });
    expect(duplicateKeyBefore(lead, ctx({ transitionInMs: 1200 }), "a", 200)?.keys[2].tMs).toBe(
      1200,
    );
  });

  it("respects an earlier stray key's wall", () => {
    const lead: KeyedTrack<Pose> = {
      keys: [K("a", 1500), K("b", 2500), K("s", 1000)],
      segments: [S("a", "b")],
    };
    expect(duplicateKeyBefore(lead, ctx(), "a", 200)?.keys[3].tMs).toBe(1000 + MIN_KEY_GAP_MS);
  });

  it("is disabled with half a short previous animation, or no room before the key", () => {
    expect(duplicateKeyBefore(chain(), ctx(), "k2", 600)).toBeNull();
    const lead: KeyedTrack<Pose> = { keys: [K("a", 1500), K("b", 2500)], segments: [S("a", "b")] };
    expect(duplicateKeyBefore(lead, ctx({ transitionInMs: 1400 }), "a", 200)).toBeNull();
  });
});

describe("deleteKeyMerged", () => {
  it("merges a junction's two animations, the FIRST segment's settings winning", () => {
    const rich: KeyedTrack<Pose> & {
      segments: (KeyedTrackSegment & { easeLens?: string; smooth?: boolean })[];
    } = {
      keys: chain().keys,
      segments: [
        { ...S("k1", "k2"), easeLens: "inSine", smooth: false },
        S("k2", "k3", "outCubic"),
      ],
    };
    const result = deleteKeyMerged(rich, "k2");
    expect(result?.track.segments).toEqual([
      { from: "k1", to: "k3", ease: "linear", easeLens: "inSine", smooth: false },
    ]);
    expect(result?.track.keys.map((k) => k.id)).toEqual(["k1", "k3"]);
    expect(result?.frozenPose).toBeUndefined();
  });

  it("an end key takes its own animation and nothing else", () => {
    const result = deleteKeyMerged(chain(), "k3");
    expect(result?.track.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(result?.track.segments).toEqual([S("k1", "k2")]);
  });

  it("losing the last animation collapses the track and hands back the surviving pose", () => {
    const one: KeyedTrack<Pose> = {
      keys: [K("k1", 0, 4), K("k2", 1000, 5)],
      segments: [S("k1", "k2")],
    };
    expect(deleteKeyMerged(one, "k2")).toEqual({
      track: { keys: [], segments: [] },
      frozenPose: { d: 4 },
    });
    expect(deleteKeyMerged(one, "k1")?.frozenPose).toEqual({ d: 5 });
  });

  it("drops the partner key a legacy gapped animation leaves behind", () => {
    const gapped: KeyedTrack<Pose> = {
      keys: [K("k1", 0), K("k2", 1000), K("k3", 2500), K("k4", 3500)],
      segments: [S("k1", "k2"), S("k3", "k4")],
    };
    const result = deleteKeyMerged(gapped, "k4");
    expect(result?.track.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(result?.track.segments).toEqual([S("k1", "k2")]);
    expect(result?.frozenPose).toBeUndefined();
  });

  it("an unattached legacy key just goes; an unknown one is null", () => {
    const strayed: KeyedTrack<Pose> = { ...chain(), keys: [...chain().keys, K("k9", 3500)] };
    const result = deleteKeyMerged(strayed, "k9");
    expect(result?.track.keys.map((k) => k.id)).toEqual(["k1", "k2", "k3"]);
    expect(result?.track.segments).toHaveLength(2);
    expect(deleteKeyMerged(chain(), "nope")).toBeNull();
  });
});

describe("resizeSegment / resizeBounds", () => {
  /** k1@0 ─ k2@1000, a 1000ms legacy gap, then k3@2000 ─ k4@2500. */
  const gapped = (): KeyedTrack<Pose> => ({
    keys: [K("k1", 0), K("k2", 1000), K("k3", 2000), K("k4", 2500)],
    segments: [S("k1", "k2"), S("k3", "k4")],
  });

  it("ripples later keys by the same delta, preserving the legacy gap", () => {
    const next = resizeSegment(gapped(), ctx(), 0, 1500);
    expect(next?.keys.map((k) => k.tMs)).toEqual([0, 1500, 2500, 3000]);
  });

  it("bounds are the minimum length and the room before the window end", () => {
    expect(resizeBounds(gapped(), ctx(), 0, 300)).toEqual({
      spanMs: 1000,
      minMs: 300,
      maxMs: 2500,
    });
    expect(resizeSegment(gapped(), ctx(), 0, 9999)?.keys.map((k) => k.tMs)).toEqual([
      0, 2500, 3500, 4000,
    ]);
    expect(resizeSegment(gapped(), ctx(), 0, 0, 300)?.keys.map((k) => k.tMs)).toEqual([
      0, 300, 1300, 1800,
    ]);
  });

  it("grandfathers an overhanging tail: it may keep its span, never extend it", () => {
    const over = gapped();
    over.keys[3].tMs = 4500;
    expect(resizeBounds(over, ctx(), 0, 300)?.maxMs).toBe(1000);
  });

  it("an unchanged span is an identity no-op, an unknown index is null", () => {
    const t = gapped();
    expect(resizeSegment(t, ctx(), 0, 1000)).toBe(t);
    expect(resizeSegment(t, ctx(), 7, 1000)).toBeNull();
    expect(resizeBounds(t, ctx(), 7)).toBeNull();
  });
});

describe("mergeGap", () => {
  const gapped = (): KeyedTrack<Pose> => ({
    keys: [K("k1", 0), K("k2", 1000, 2), K("k3", 2500, 3), K("k4", 3500)],
    segments: [S("k1", "k2"), S("k3", "k4")],
  });

  it("drags an end key onto the next start key, keeping the stationary time and pose", () => {
    const next = mergeGap(gapped(), "k2", "k3");
    expect(next?.keys.map((k) => [k.id, k.tMs])).toEqual([
      ["k1", 0],
      ["k3", 2500],
      ["k4", 3500],
    ]);
    expect(next?.segments).toEqual([S("k1", "k3"), S("k3", "k4")]);
    expect(next?.keys[1].pose).toEqual({ d: 3 });
  });

  it("drags a start key onto the previous end key", () => {
    const next = mergeGap(gapped(), "k3", "k2");
    expect(next?.segments).toEqual([S("k1", "k2"), S("k2", "k4")]);
    expect(next?.keys.find((k) => k.id === "k2")).toEqual({ id: "k2", tMs: 1000, pose: { d: 2 } });
  });

  it("refuses the same key, an unknown key, and the two ends of one animation", () => {
    expect(mergeGap(gapped(), "k2", "k2")).toBeNull();
    expect(mergeGap(gapped(), "k2", "nope")).toBeNull();
    expect(mergeGap(gapped(), "k2", "k1")).toBeNull();
  });
});

describe("splitSegmentAt", () => {
  const base = (): KeyedTrack<Pose> => ({
    keys: [K("k1", 0), K("k2", 1000, 2), K("k3", 2000, 3)],
    segments: [
      { from: "k1", to: "k2", ease: "outQuad", easePosition: "linear" } as KeyedTrackSegment,
      S("k2", "k3"),
    ],
  });

  it("inserts the sampled pose at the split, both halves keeping ease and channel settings", () => {
    const next = splitSegmentAt(base(), 0, 400, { d: 9 });
    const added = next?.keys.find((k) => !["k1", "k2", "k3"].includes(k.id));
    expect(added).toMatchObject({ tMs: 400, pose: { d: 9 } });
    expect(next?.segments).toEqual([
      { from: "k1", to: added?.id, ease: "outQuad", easePosition: "linear" },
      { from: added?.id, to: "k2", ease: "outQuad", easePosition: "linear" },
      S("k2", "k3"),
    ]);
  });

  it("refuses a split leaving either half under the minimum length", () => {
    expect(splitSegmentAt(base(), 0, 200, { d: 9 }, 250)).toBeNull();
    expect(splitSegmentAt(base(), 0, 800, { d: 9 }, 250)).toBeNull();
    expect(splitSegmentAt(base(), 0, 500, { d: 9 }, 250)).not.toBeNull();
  });

  it("refuses an unknown doc index", () => {
    expect(splitSegmentAt(base(), 5, 400, { d: 9 })).toBeNull();
  });
});

describe("addedKey", () => {
  it("hands back the endpoint of a whole animation seeded on an empty track", () => {
    const next = addAnimationAuto({ keys: [], segments: [] }, ctx(), 0, poseAt, 200);
    expect(next && addedKey({ keys: [], segments: [] }, next)).toEqual({
      id: "k2",
      tMs: 1000,
      pose: { d: 1000 },
    });
  });

  it("still finds the endpoint when the absorbed lone key's id is reused", () => {
    const statik: KeyedTrack<Pose> = { keys: [K("k1", 0, 9)], segments: [] };
    const next = addAnimationAuto(statik, ctx(), 0, poseAt, 200);
    expect(next && addedKey(statik, next)?.id).toBe("k2");
  });

  it("finds the duplicate, the earlier duplicate and the split key", () => {
    const after = duplicateKey(chain(), ctx(), "k2", 200);
    expect(after && addedKey(chain(), after)).toMatchObject({ tMs: 2000, pose: { d: 2 } });
    const before = duplicateKeyBefore(chain(), ctx(), "k2", 200);
    expect(before && addedKey(chain(), before)).toMatchObject({ tMs: 500, pose: { d: 2 } });
    const split = splitSegmentAt(chain(), 0, 400, { d: 9 }, 200);
    expect(split && addedKey(chain(), split)).toMatchObject({ tMs: 400, pose: { d: 9 } });
  });

  it("is null when the op added nothing", () => {
    expect(addedKey(chain(), chain())).toBeNull();
    expect(addedKey(chain(), { keys: [], segments: [] })).toBeNull();
  });
});

describe("minimum-length walls", () => {
  /** k1@0 ─ k2@1000 chained, plus an unchained legacy key at 1500. */
  const mixed = (): KeyedTrack<Pose> => ({
    keys: [K("k1", 0), K("k2", 1000), K("k9", 1500)],
    segments: [S("k1", "k2")],
  });

  it("a chained neighbour holds minLenMs, an unchained one the plain data floor", () => {
    expect(keyWalls(mixed(), "k2", 4000, 300)).toEqual({ lo: 300, hi: 1500 - MIN_KEY_GAP_MS });
    expect(keyWalls(mixed(), "k2", 4000)).toEqual({
      lo: MIN_KEY_GAP_MS,
      hi: 1500 - MIN_KEY_GAP_MS,
    });
  });

  it("moveKey clamps a junction drag to the caller's minimum", () => {
    expect(moveKey(mixed(), "k2", 100, 4000, 300)?.keys[1].tMs).toBe(300);
    expect(moveKey(mixed(), "k2", 100, 4000)?.keys[1].tMs).toBe(100);
  });

  it("moveSegment keeps the neighbouring animation above the minimum too", () => {
    const chained: KeyedTrack<Pose> = {
      keys: [K("a", 0), K("b", 1000), K("c", 2000)],
      segments: [S("a", "b"), S("b", "c")],
    };
    expect(moveSegment(chained, "b", "c", -900, 4000, 300)?.keys.map((k) => k.tMs)).toEqual([
      0, 300, 1300,
    ]);
    expect(moveSegment(chained, "b", "c", -900, 4000)?.keys.map((k) => k.tMs)).toEqual([
      0, 100, 1100,
    ]);
  });

  it("an overhanging key still keeps (but never extends) its overhang", () => {
    const over: KeyedTrack<Pose> = {
      keys: [K("a", 0), K("b", 4800)],
      segments: [S("a", "b")],
    };
    expect(moveKey(over, "b", 5200, 4000, 300)?.keys[1].tMs).toBe(4800);
    expect(moveKey(over, "b", 4200, 4000, 300)?.keys[1].tMs).toBe(4200);
  });
});
