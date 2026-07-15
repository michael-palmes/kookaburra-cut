import { describe, expect, it } from "vitest";
import type { EditClip } from "./edit";
import {
  clipIndexAt,
  clipTimelineMs,
  edgeTargetsMs,
  MIN_CLIP_SOURCE_MS,
  moveClip,
  nextClipId,
  nextSourceId,
  relayout,
  removeClip,
  setClipSpeed,
  snapMs,
  splitAt,
  timelineDurationMs,
  timelineToSource,
  trimClipIn,
  trimClipOut,
} from "./editMath";

function clip(id: string, inMs: number, outMs: number, speed = 1, startMs = 0): EditClip {
  return { id, sourceId: "s1", inMs, outMs, speed, startMs };
}

describe("relayout", () => {
  it("butts clips together with retimed durations", () => {
    const laid = relayout([clip("c1", 0, 1000), clip("c2", 0, 1000, 2), clip("c3", 500, 1000)]);
    expect(laid.map((c) => c.startMs)).toEqual([0, 1000, 1500]);
  });

  it("rounds fractional starts to integers (u64 on the Rust side)", () => {
    const laid = relayout([clip("c1", 0, 1000, 0.75), clip("c2", 0, 1000)]);
    expect(laid[1].startMs).toBe(1333);
    expect(Number.isInteger(laid[1].startMs)).toBe(true);
  });

  it("treats a non-positive speed as 1", () => {
    expect(clipTimelineMs(clip("c1", 0, 1000, 0))).toBe(1000);
  });
});

describe("clipIndexAt / timelineToSource", () => {
  const clips = relayout([clip("c1", 0, 1000), clip("c2", 2000, 4000, 2)]);

  it("finds the clip with start-inclusive, end-exclusive spans", () => {
    expect(clipIndexAt(clips, 0)).toBe(0);
    expect(clipIndexAt(clips, 999)).toBe(0);
    expect(clipIndexAt(clips, 1000)).toBe(1);
    expect(clipIndexAt(clips, 1999)).toBe(1);
    expect(clipIndexAt(clips, 2000)).toBe(-1);
    expect(clipIndexAt(clips, -1)).toBe(-1);
  });

  it("maps timeline time to retimed source time", () => {
    expect(timelineToSource(clips[1], 1500)).toBe(3000); // 500ms in at 2× = 1000ms of source
  });

  it("clamps to the clip's source span", () => {
    expect(timelineToSource(clips[0], -50)).toBe(0);
    expect(timelineToSource(clips[1], 99999)).toBe(4000);
  });
});

describe("splitAt", () => {
  const clips = relayout([clip("c1", 0, 1000), clip("c2", 2000, 4000, 2)]);

  it("splits the clip under t at the retimed source point", () => {
    const next = splitAt(clips, 1500, "c9");
    expect(next).not.toBeNull();
    expect(next?.map((c) => c.id)).toEqual(["c1", "c2", "c9"]);
    expect(next?.[1]).toMatchObject({ inMs: 2000, outMs: 3000, startMs: 1000 });
    expect(next?.[2]).toMatchObject({ inMs: 3000, outMs: 4000, startMs: 1500 });
    expect(timelineDurationMs(next ?? [])).toBe(timelineDurationMs(clips));
  });

  it("refuses a split that leaves a sliver", () => {
    expect(splitAt(clips, MIN_CLIP_SOURCE_MS - 1, "c9")).toBeNull();
    expect(splitAt(clips, 999.5, "c9")).toBeNull();
  });

  it("refuses a split past the end", () => {
    expect(splitAt(clips, 2000, "c9")).toBeNull();
  });
});

describe("mutations", () => {
  const clips = relayout([clip("c1", 0, 1000), clip("c2", 0, 2000), clip("c3", 0, 500)]);

  it("removeClip closes the gap", () => {
    const next = removeClip(clips, "c2");
    expect(next.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(next.map((c) => c.startMs)).toEqual([0, 1000]);
  });

  it("moveClip reorders and relays", () => {
    const next = moveClip(clips, 2, 0);
    expect(next.map((c) => c.id)).toEqual(["c3", "c1", "c2"]);
    expect(next.map((c) => c.startMs)).toEqual([0, 500, 1500]);
  });

  it("moveClip is a no-op for same or invalid indices", () => {
    expect(moveClip(clips, 1, 1)).toBe(clips);
    expect(moveClip(clips, -1, 0)).toBe(clips);
  });

  it("setClipSpeed retimes downstream starts", () => {
    const next = setClipSpeed(clips, "c1", 2);
    expect(next[1].startMs).toBe(500);
  });

  it("trimClipIn clamps to [0, out - floor]", () => {
    expect(trimClipIn(clips, "c1", -50)[0].inMs).toBe(0);
    expect(trimClipIn(clips, "c1", 5000)[0].inMs).toBe(1000 - MIN_CLIP_SOURCE_MS);
    expect(trimClipIn(clips, "c1", 250)[0].inMs).toBe(250);
  });

  it("trimClipOut clamps to [in + floor, source duration]", () => {
    expect(trimClipOut(clips, "c1", 20, 3800)[0].outMs).toBe(MIN_CLIP_SOURCE_MS);
    expect(trimClipOut(clips, "c1", 9999, 3800)[0].outMs).toBe(3800);
    expect(trimClipOut(clips, "c1", 800, 3800)[0].outMs).toBe(800);
  });
});

describe("snapping", () => {
  it("edgeTargetsMs lists 0 and every clip end", () => {
    const clips = relayout([clip("c1", 0, 1000), clip("c2", 0, 2000, 2)]);
    expect(edgeTargetsMs(clips)).toEqual([0, 1000, 2000]);
  });

  it("snapMs picks the nearest target inside the threshold only", () => {
    expect(snapMs(980, [0, 1000], 30)).toBe(1000);
    expect(snapMs(950, [0, 1000], 30)).toBe(950);
    expect(snapMs(15, [0, 1000], 30)).toBe(0);
  });
});

describe("nextClipId / nextSourceId", () => {
  it("continues the c<n> sequence and survives foreign ids", () => {
    expect(nextClipId([clip("c1", 0, 1), clip("c7", 0, 1), clip("intro", 0, 1)])).toBe("c8");
    expect(nextClipId([])).toBe("c1");
  });

  it("continues the s<n> sequence for sources", () => {
    expect(nextSourceId([{ id: "s1" }, { id: "s3" }])).toBe("s4");
    expect(nextSourceId([])).toBe("s1");
  });
});
