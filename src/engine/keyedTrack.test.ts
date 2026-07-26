import { describe, expect, it } from "vitest";
import {
  clampTrackToDuration,
  type KeyedTrack,
  MIN_KEY_GAP_MS,
  setSegmentChannelEase,
  setSegmentSmooth,
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
