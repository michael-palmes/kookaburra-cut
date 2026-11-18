import { describe, expect, it } from "vitest";
import {
  deleteKeyMerged,
  type KeyedTrack,
  moveKey,
  removeSegment,
  trackLayout,
} from "../engine/keyedTrack";
import { LARGE_STEP_FRAMES } from "./laneKeys";
import {
  deleteTrackLaneItem,
  easeLabel,
  FRAME_MS,
  keyDragResult,
  retimeKey,
  segmentDragResult,
  snapToFrame,
  type TrackLaneItem,
  trackLaneEditMessage,
  trackLaneItemName,
  trackLaneItems,
  trackLaneNudge,
  withFrozenPose,
} from "./trackLaneKeys";

type Track = KeyedTrack<{ x: number }>;

const track: Track = {
  keys: [
    { id: "a", tMs: 400, pose: { x: 0 } },
    { id: "b", tMs: 1500, pose: { x: 1 } },
    { id: "c", tMs: 3000, pose: { x: 2 } },
  ],
  segments: [
    { from: "a", to: "b", ease: "inOutQuad" },
    { from: "b", to: "c", ease: "jump" },
  ],
};
const DURATION = 4000;
const MIN_LEN = 200;
/** A lane 600px wide over 4 s: what the drags below travel in. */
const PX_PER_MS = 0.15;

const items = trackLaneItems(trackLayout(track), trackLayout(track).keys);
const item = (id: string) => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const keyB = item("key:b");
const segAB = item("seg:a>b");
const keyTime = (t: Track | null, id: string) => t?.keys.find((k) => k.id === id)?.tMs;

/** The pointer's version of the same edit: a drag of `frames` frames' worth of pixels, nowhere near a snap target. */
const dragPx = (frames: number) => frames * FRAME_MS * PX_PER_MS;

describe("trackLaneItems", () => {
  it("orders keys and animations by time, each animation between its keys", () => {
    expect(items.map((i) => i.id)).toEqual(["key:a", "seg:a>b", "key:b", "seg:b>c", "key:c"]);
  });

  it("names each item by kind, label and time", () => {
    expect(trackLaneItemName(keyB)).toBe("Keyframe, 0:01.50");
    expect(trackLaneItemName(keyB, true)).toBe("Keyframe, still, 0:01.50");
    expect(trackLaneItemName(segAB)).toBe("Animation, In out quad, 0:00.40 to 0:01.50");
    expect(trackLaneItemName(item("seg:b>c"))).toBe("Animation, Jump cut, 0:01.50 to 0:03.00");
    expect(easeLabel("linear")).toBe("Linear");
  });
});

describe("keyboard edits write what the pointer writes", () => {
  it("moves a key one frame, or ten with ⇧, exactly as a drag does", () => {
    for (const frames of [1, -1, LARGE_STEP_FRAMES, -LARGE_STEP_FRAMES]) {
      const keyboard = trackLaneNudge(track, keyB, { kind: "move", frames }, DURATION, MIN_LEN);
      const pointer = keyDragResult(
        track,
        "b",
        dragPx(frames),
        PX_PER_MS,
        0,
        [],
        DURATION,
        MIN_LEN,
      );
      expect(keyboard).toEqual(pointer);
      expect(keyTime(keyboard, "b")).toBe(snapToFrame(1500 + frames * FRAME_MS));
    }
  });

  it("matches the selected-key arrows the lane already had", () => {
    const keyboard = trackLaneNudge(track, keyB, { kind: "move", frames: 1 }, DURATION, MIN_LEN);
    expect(keyboard).toEqual(retimeKey(track, "b", 1500 + FRAME_MS, DURATION, MIN_LEN));
    expect(keyboard).toEqual(moveKey(track, "b", snapToFrame(1500 + FRAME_MS), DURATION, MIN_LEN));
  });

  it("moves an animation as dragging its bar does", () => {
    for (const frames of [1, -LARGE_STEP_FRAMES]) {
      const keyboard = trackLaneNudge(track, segAB, { kind: "move", frames }, DURATION, MIN_LEN);
      const pointer = segmentDragResult(
        track,
        "a",
        "b",
        dragPx(frames),
        PX_PER_MS,
        DURATION,
        MIN_LEN,
      );
      expect(keyboard).toEqual(pointer);
    }
  });

  it("trims an animation's start and end as dragging its end diamonds does", () => {
    const start = trackLaneNudge(
      track,
      segAB,
      { kind: "trim", edge: "start", frames: 1 },
      DURATION,
      MIN_LEN,
    );
    expect(start).toEqual(
      keyDragResult(track, "a", dragPx(1), PX_PER_MS, 0, [], DURATION, MIN_LEN),
    );
    expect(keyTime(start, "a")).toBe(417);
    const end = trackLaneNudge(
      track,
      segAB,
      { kind: "trim", edge: "end", frames: -1 },
      DURATION,
      MIN_LEN,
    );
    expect(end).toEqual(keyDragResult(track, "b", dragPx(-1), PX_PER_MS, 0, [], DURATION, MIN_LEN));
    expect(
      trackLaneNudge(track, keyB, { kind: "trim", edge: "start", frames: 1 }, DURATION, MIN_LEN),
    ).toBeNull();
  });

  it("clamps at the walls exactly as the drag clamps", () => {
    const far = -1000;
    const keyboard = trackLaneNudge(track, keyB, { kind: "move", frames: far }, DURATION, MIN_LEN);
    const pointer = keyDragResult(track, "b", dragPx(far), PX_PER_MS, 0, [], DURATION, MIN_LEN);
    expect(keyboard).toEqual(pointer);
    expect(keyTime(keyboard, "b")).toBe(400 + MIN_LEN);
    const end = trackLaneNudge(
      track,
      item("key:c"),
      { kind: "move", frames: 1000 },
      DURATION,
      MIN_LEN,
    );
    expect(keyTime(end, "c")).toBe(DURATION);
    // At the wall the next press changes nothing, which the lane announces instead of committing.
    const parked = end as Track;
    const again = trackLaneNudge(
      parked,
      item("key:c"),
      { kind: "move", frames: 1 },
      DURATION,
      MIN_LEN,
    );
    expect(again).toBe(parked);
    expect(trackLaneEditMessage(item("key:c"), { kind: "move" }, again, again !== parked)).toBe(
      "Keyframe can't move further",
    );
  });

  it("deletes as the Delete key and the menus do", () => {
    expect(deleteTrackLaneItem(track, segAB)).toEqual(removeSegment(track, 0));
    const merged = deleteKeyMerged(track, "b");
    expect(merged).not.toBeNull();
    if (merged) expect(deleteTrackLaneItem(track, keyB)).toEqual(withFrozenPose(merged));
  });

  it("freezes the pose when the last animation goes", () => {
    const one: Track = {
      keys: [
        { id: "a", tMs: 0, pose: { x: 0 } },
        { id: "b", tMs: 1000, pose: { x: 5 } },
      ],
      segments: [{ from: "a", to: "b", ease: "linear" }],
    };
    const key: TrackLaneItem = { kind: "key", id: "key:a", keyId: "a", tMs: 0 };
    const next = deleteTrackLaneItem(one, key);
    expect(next?.segments).toEqual([]);
    expect(next?.keys).toHaveLength(1);
  });
});

describe("trackLaneEditMessage", () => {
  it("says where the item landed", () => {
    const moved = trackLaneNudge(track, keyB, { kind: "move", frames: 1 }, DURATION, MIN_LEN);
    expect(trackLaneEditMessage(keyB, { kind: "move" }, moved, true)).toBe(
      "Keyframe moved to 0:01.52",
    );
    const shifted = trackLaneNudge(track, segAB, { kind: "move", frames: 1 }, DURATION, MIN_LEN);
    expect(trackLaneEditMessage(segAB, { kind: "move" }, shifted, true)).toBe(
      "Animation moved to 0:00.42",
    );
    const trimmed = trackLaneNudge(
      track,
      segAB,
      { kind: "trim", edge: "end", frames: 1 },
      DURATION,
      MIN_LEN,
    );
    expect(trackLaneEditMessage(segAB, { kind: "trim", edge: "end" }, trimmed, true)).toBe(
      "Animation ends at 0:01.52",
    );
  });
});
