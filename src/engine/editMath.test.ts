import { describe, expect, it } from "vitest";
import type { EditClip, EditTap, EditZoomKey } from "./edit";
import {
  addTap,
  aspectCropRect,
  type CropRect,
  clipIndexAt,
  clipTimelineMs,
  cropPixels,
  DEFAULT_HOLD_MS,
  edgeTargetsMs,
  fitZoomRect,
  freezeAt,
  freezeAtEnd,
  imageClip,
  insertClipAt,
  MIN_CLIP_SOURCE_MS,
  MIN_HOLD_MS,
  moveClip,
  moveTap,
  moveZoomKey,
  nextClipId,
  nextSourceId,
  nextTapId,
  outputToSource,
  posInCrop,
  relayout,
  removeClip,
  removeTap,
  removeZoomKey,
  retimeTap,
  setClipCrop,
  setClipHold,
  setClipSpeed,
  setZoomKey,
  setZoomKeyEase,
  snapCropRect,
  snapMs,
  snapZoomMs,
  splitAt,
  tapPosInCrop,
  tapPosInZoom,
  tapWindows,
  timelineDurationMs,
  timelineToSource,
  trimClipIn,
  trimClipOut,
  zoomKeyIndex,
  zoomRectAt,
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

describe("freeze frames", () => {
  const freeze = (id: string, srcMs: number, holdMs: number, startMs = 0): EditClip => ({
    id,
    sourceId: "s1",
    inMs: srcMs,
    outMs: srcMs,
    speed: 1,
    holdMs,
    startMs,
  });

  it("a freeze's timeline duration is its hold, and it always reads its pinned frame", () => {
    const f = freeze("c2", 700, 2000, 500);
    expect(clipTimelineMs(f)).toBe(2000);
    expect(timelineToSource(f, 1600)).toBe(700);
  });

  it("freezeAt splits the containing clip and holds the frame under the playhead", () => {
    const next = freezeAt(relayout([clip("c1", 0, 1000)]), 400, 2000);
    expect(next?.map((c) => c.holdMs)).toEqual([undefined, 2000, undefined]);
    expect(next?.[1]).toMatchObject({ inMs: 400, outMs: 400 });
    expect(next?.[0].outMs).toBe(400);
    expect(next?.[2].inMs).toBe(400);
    expect(next?.map((c) => c.startMs)).toEqual([0, 400, 2400]);
  });

  it("freezeAt slips in at a clip edge instead of leaving a sliver", () => {
    const atStart = freezeAt(relayout([clip("c1", 0, 1000)]), 50, 1000);
    expect(atStart?.map((c) => c.holdMs)).toEqual([1000, undefined]);
    const atEnd = freezeAt(relayout([clip("c1", 0, 1000)]), 960, 1000);
    expect(atEnd?.map((c) => c.holdMs)).toEqual([undefined, 1000]);
  });

  it("freezeAt refuses off-timeline points and existing freezes", () => {
    const laid = relayout([clip("c1", 0, 1000)]);
    expect(freezeAt(laid, 1500, 1000)).toBeNull();
    const frozen = freezeAt(laid, 400, 1000);
    expect(frozen && freezeAt(frozen, 500, 1000)).toBeNull();
  });

  it("freezeAtEnd appends the final displayed source frame of a retimed last clip", () => {
    const laid = relayout([
      clip("c1", 0, 1000),
      { ...clip("c2", 200, 2200), sourceId: "s2", speed: 2 },
    ]);
    const next = freezeAtEnd(laid, 50, 2000);
    expect(next?.at(-1)).toMatchObject({
      id: "c3",
      sourceId: "s2",
      inMs: 2160,
      outMs: 2160,
      holdMs: 2000,
      startMs: 2000,
    });
  });

  it("freezeAtEnd is disabled when the last timeline item is already a freeze", () => {
    expect(
      freezeAtEnd(relayout([clip("c1", 0, 1000), freeze("c2", 980, 2000)]), 50, 1000),
    ).toBeNull();
    expect(freezeAtEnd([], 50, 1000)).toBeNull();
  });

  it("setClipHold retimes only freezes, with a floor", () => {
    const laid = relayout([clip("c1", 0, 1000), freeze("c2", 500, 2000)]);
    expect(setClipHold(laid, "c2", 3500)[1].holdMs).toBe(3500);
    expect(setClipHold(laid, "c2", 10)[1].holdMs).toBe(MIN_HOLD_MS);
    expect(setClipHold(laid, "c1", 3500)[0].holdMs).toBeUndefined();
  });

  it("split, trim and speed leave freezes untouched", () => {
    const laid = relayout([freeze("c1", 500, 2000)]);
    expect(splitAt(laid, 1000, "c9")).toBeNull();
    expect(trimClipIn(laid, "c1", 100)[0].inMs).toBe(500);
    expect(trimClipOut(laid, "c1", 900, 5000)[0].outMs).toBe(500);
    expect(setClipSpeed(laid, "c1", 2)[0].speed).toBe(1);
  });

  describe("insertClipAt", () => {
    const incoming = (id: string): EditClip => ({
      id,
      sourceId: "s2",
      inMs: 0,
      outMs: 3000,
      speed: 1,
      startMs: 0,
    });

    it("splits the containing clip and splices the new clip between the halves", () => {
      const next = insertClipAt(relayout([clip("c1", 0, 1000)]), 400, incoming("c2"));
      expect(next.map((c) => c.sourceId)).toEqual(["s1", "s2", "s1"]);
      expect(next[0].outMs).toBe(400);
      expect(next[2].inMs).toBe(400);
      expect(next.map((c) => c.startMs)).toEqual([0, 400, 3400]);
      expect(new Set(next.map((c) => c.id)).size).toBe(3);
    });

    it("slips to a clip edge instead of leaving a sliver", () => {
      const atStart = insertClipAt(relayout([clip("c1", 0, 1000)]), 50, incoming("c2"));
      expect(atStart.map((c) => c.sourceId)).toEqual(["s2", "s1"]);
      const atEnd = insertClipAt(relayout([clip("c1", 0, 1000)]), 960, incoming("c2"));
      expect(atEnd.map((c) => c.sourceId)).toEqual(["s1", "s2"]);
    });

    it("appends when t is off the timeline, including exactly at the end", () => {
      const laid = relayout([clip("c1", 0, 1000)]);
      expect(insertClipAt(laid, 1000, incoming("c2")).map((c) => c.sourceId)).toEqual(["s1", "s2"]);
      expect(insertClipAt([], 0, incoming("c1")).map((c) => c.sourceId)).toEqual(["s2"]);
    });

    it("slips to the genuinely nearer edge when both halves are short", () => {
      const laid = relayout([clip("c1", 0, 150)]);
      expect(insertClipAt(laid, 90, incoming("c2")).map((c) => c.sourceId)).toEqual(["s1", "s2"]);
      expect(insertClipAt(laid, 60, incoming("c2")).map((c) => c.sourceId)).toEqual(["s2", "s1"]);
    });

    it("slips to the nearer edge of a freeze instead of splitting it", () => {
      const laid = relayout([clip("c1", 0, 1000), freeze("c2", 500, 2000)]);
      const nearStart = insertClipAt(laid, 1200, incoming("c3"));
      expect(nearStart.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
      const nearEnd = insertClipAt(laid, 2800, incoming("c3"));
      expect(nearEnd.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    });
  });
});

describe("image clips", () => {
  it("a still lands as a zero-span hold on the next free id", () => {
    const laid = relayout([clip("c1", 0, 1000)]);
    const still = imageClip(laid, "s2", DEFAULT_HOLD_MS);
    expect(still).toEqual({
      id: "c2",
      sourceId: "s2",
      inMs: 0,
      outMs: 0,
      speed: 1,
      holdMs: DEFAULT_HOLD_MS,
      startMs: 0,
    });
    expect(clipTimelineMs(still)).toBe(DEFAULT_HOLD_MS);
    expect(imageClip([], "s1", 10).holdMs).toBe(MIN_HOLD_MS);
  });

  it("splices into the timeline like any other clip and lays out on its hold", () => {
    const laid = relayout([clip("c1", 0, 1000)]);
    const next = insertClipAt(laid, 400, imageClip(laid, "s2", DEFAULT_HOLD_MS));
    expect(next.map((c) => c.sourceId)).toEqual(["s1", "s2", "s1"]);
    expect(next.map((c) => c.startMs)).toEqual([0, 400, 2400]);
    expect(timelineDurationMs(next)).toBe(3000);
  });

  it("trims by its hold alone: no span to split, trim or retime", () => {
    const laid = relayout([imageClip([], "s2", DEFAULT_HOLD_MS)]);
    expect(setClipHold(laid, "c1", 800)[0].holdMs).toBe(800);
    expect(setClipHold(laid, "c1", 10)[0].holdMs).toBe(MIN_HOLD_MS);
    expect(splitAt(laid, 1000, "c9")).toBeNull();
    expect(trimClipIn(laid, "c1", 100)[0].inMs).toBe(0);
    expect(trimClipOut(laid, "c1", 900, 5000)[0].outMs).toBe(0);
    expect(setClipSpeed(laid, "c1", 2)[0].speed).toBe(1);
    expect(outputToSource(laid, 500)).toBeNull();
  });
});

describe("taps", () => {
  const tap = (id: string, sourceMs: number, pos: [number, number] = [0.5, 0.5]): EditTap => ({
    id,
    sourceId: "s1",
    sourceMs,
    pos,
  });
  const freeze = (id: string, srcMs: number, holdMs: number): EditClip => ({
    id,
    sourceId: "s1",
    inMs: srcMs,
    outMs: srcMs,
    speed: 1,
    holdMs,
    startMs: 0,
  });

  it("outputToSource maps the playhead through the clip, retimed and rounded to integers", () => {
    const clips = relayout([clip("c1", 0, 1000), clip("c2", 2000, 4000, 2)]);
    expect(outputToSource(clips, 500)).toEqual({ sourceId: "s1", sourceMs: 500 });
    expect(outputToSource(clips, 1500)).toEqual({ sourceId: "s1", sourceMs: 3000 });
    const rounded = outputToSource(relayout([clip("c1", 0, 1000, 0.75)]), 1);
    expect(rounded && Number.isInteger(rounded.sourceMs)).toBe(true);
  });

  it("outputToSource is null off-timeline and on freezes", () => {
    const clips = relayout([clip("c1", 0, 1000), freeze("c2", 500, 2000)]);
    expect(outputToSource(clips, 5000)).toBeNull();
    expect(outputToSource(clips, 1500)).toBeNull(); // inside the freeze
  });

  it("tapWindows places one window per containing clip, retimed by speed", () => {
    const clips = relayout([clip("c1", 0, 1000), clip("c2", 2000, 4000, 2)]);
    expect(tapWindows(clips, tap("t1", 500), 550)).toEqual([{ startMs: 500, endMs: 1000 }]);
    expect(tapWindows(clips, tap("t2", 3000), 550)).toEqual([{ startMs: 1500, endMs: 2000 }]);
  });

  it("tapWindows uses [inMs, outMs) containment", () => {
    const clips = relayout([clip("c1", 1000, 2000)]);
    expect(tapWindows(clips, tap("t1", 999), 550)).toEqual([]);
    expect(tapWindows(clips, tap("t2", 1000), 550)).toHaveLength(1);
    expect(tapWindows(clips, tap("t3", 2000), 550)).toEqual([]);
  });

  it("tapWindows clamps a window at the clip's output end", () => {
    const clips = relayout([clip("c1", 0, 1000), clip("c2", 5000, 6000)]);
    expect(tapWindows(clips, tap("t1", 900), 550)).toEqual([{ startMs: 900, endMs: 1000 }]);
  });

  it("a duplicated segment shows the tap in each copy", () => {
    const clips = relayout([clip("c1", 0, 1000), clip("c2", 0, 1000)]);
    expect(tapWindows(clips, tap("t1", 400), 550)).toEqual([
      { startMs: 400, endMs: 950 },
      { startMs: 1400, endMs: 1950 },
    ]);
  });

  it("freezes never surface a tap, even at the pinned frame", () => {
    const clips = relayout([freeze("c1", 500, 2000)]);
    expect(tapWindows(clips, tap("t1", 500), 550)).toEqual([]);
  });

  it("a tap whose source span was trimmed out has no windows", () => {
    const clips = relayout([clip("c1", 0, 400)]);
    expect(tapWindows(clips, tap("t1", 700), 550)).toEqual([]);
  });

  it("add, move, retime and remove are pure and targeted", () => {
    const taps = [tap("t1", 100), tap("t2", 200)];
    expect(addTap(taps, tap("t3", 300))).toHaveLength(3);
    expect(moveTap(taps, "t1", [0.1, 0.9])[0].pos).toEqual([0.1, 0.9]);
    expect(moveTap(taps, "t1", [0.1, 0.9])[1].pos).toEqual([0.5, 0.5]);
    expect(retimeTap(taps, "t2", "s2", 900)[1]).toMatchObject({ sourceId: "s2", sourceMs: 900 });
    expect(removeTap(taps, "t1").map((t) => t.id)).toEqual(["t2"]);
  });

  it("nextTapId continues the t<n> sequence and survives foreign ids", () => {
    expect(nextTapId([tap("t1", 0), tap("t5", 0), { ...tap("x", 0), id: "intro" }])).toBe("t6");
    expect(nextTapId([])).toBe("t1");
  });
});

describe("static crop", () => {
  const phone = { width: 1179, height: 2556 };
  const crop: [number, number, number, number] = [0.25, 0.25, 0.5, 0.5];

  it("cropPixels cuts on even pixels inside the frame", () => {
    expect(cropPixels([0, 0, 1, 1], phone)).toEqual([0, 0, 1178, 2556]);
    expect(cropPixels([0.1, 0.2, 0.5, 0.25], { width: 1170, height: 2532 })).toEqual([
      118, 506, 586, 634,
    ]);
    expect(cropPixels([0.99, 0.99, 0.5, 0.5], phone)).toEqual([588, 1278, 590, 1278]);
    expect(cropPixels([-0.2, 0.5, 0.001, 2], phone)).toEqual([0, 0, 2, 2556]);
    for (const v of cropPixels([0.3333, 0.3333, 0.3333, 0.3333], { width: 333, height: 777 })) {
      expect(v % 2).toBe(0);
    }
  });

  it("snapCropRect keeps the minimum size and is stable on its own output", () => {
    const snapped = snapCropRect([0, 0, 0.001, 0.001], phone);
    expect(snapped[2]).toBeGreaterThanOrEqual(0.049);
    expect(cropPixels(snapped, phone)).toEqual([0, 0, 58, 128]);
    const once = snapCropRect([0.31, 0.12, 0.43, 0.27], phone);
    expect(snapCropRect(once, phone)).toEqual(once);
  });

  it("aspectCropRect fits the largest centred rect at an aspect, slid inside the frame", () => {
    const land = { width: 1920, height: 1080 };
    expect(cropPixels(aspectCropRect(land, 9 / 16), land)).toEqual([656, 0, 608, 1080]);
    expect(cropPixels(aspectCropRect(land, 9 / 16, [0.02, 0.5]), land)).toEqual([0, 0, 608, 1080]);
    expect(cropPixels(aspectCropRect(phone, 9 / 16), phone)).toEqual([0, 230, 1178, 2096]);
  });

  it("taps map into the crop's pixels and drop outside it", () => {
    expect(posInCrop([0.25, 0.75], crop)).toBe(true);
    expect(posInCrop([0.76, 0.5], crop)).toBe(false);
    expect(tapPosInCrop([0.1, 0.5], crop, phone)).toBeNull();
    const [u, v] = tapPosInCrop([0.5, 0.5], crop, phone) ?? [0, 0];
    expect(u).toBeCloseTo((0.5 * 1179 - 294) / 590, 12);
    expect(v).toBeCloseTo((1278 - 640) / 1278, 12);
    const tap: EditTap = { id: "t1", sourceId: "s1", sourceMs: 500, pos: [0.1, 0.5] };
    const cropped = relayout([{ ...clip("c1", 0, 1000), crop }, clip("c2", 0, 1000)]);
    expect(tapWindows(cropped, tap, 550)).toEqual([{ startMs: 1500, endMs: 2000 }]);
  });

  it("splits and freezes keep the clip's crop; setClipCrop sets and clears it", () => {
    const clips = setClipCrop(relayout([clip("c1", 0, 2000)]), "c1", crop);
    expect(clips[0].crop).toEqual(crop);
    const split = splitAt(clips, 1000, "c2") ?? [];
    expect(split.map((c) => c.crop)).toEqual([crop, crop]);
    expect((freezeAt(clips, 1000, 500) ?? [])[1].crop).toEqual(crop);
    expect((freezeAtEnd(clips, 60, 500) ?? [])[1].crop).toEqual(crop);
    expect("crop" in setClipCrop(clips, "c1", null)[0]).toBe(false);
    expect("crop" in (freezeAt(relayout([clip("c1", 0, 2000)]), 1000, 500) ?? [])[1]).toBe(false);
  });
});

describe("keyed zoom", () => {
  const full: CropRect = [0, 0, 1, 1];
  const quad: CropRect = [0.25, 0.25, 0.5, 0.5];
  const corner: CropRect = [0.5, 0.5, 0.25, 0.25];
  const keys: EditZoomKey[] = [
    { tMs: 0, rect: full, ease: "smooth" },
    { tMs: 1000, rect: quad },
    { tMs: 2000, rect: corner },
  ];
  const zoomed = (inMs = 0, outMs = 4000, speed = 1): EditClip => ({
    ...clip("c1", inMs, outMs, speed),
    zoom: { keys },
  });
  const near = (a: CropRect | null, b: CropRect | null) =>
    (a ?? []).every((v, i) => Math.abs(v - (b ?? [])[i]) < 1e-9);

  it("key times live on the output frame grid", () => {
    expect([8, 9, 1000, -25].map((ms) => snapZoomMs(ms, 60))).toEqual([0, 17, 1000, -17]);
    expect(snapZoomMs(1000, 29.97)).toBe(1001);
    expect(zoomKeyIndex(keys, 1008, 60)).toBe(1);
    expect(zoomKeyIndex(keys, 1009, 60)).toBe(-1);
  });

  it("glides between keys (smooth or linear) and holds outside them", () => {
    const c = zoomed();
    expect(zoomRectAt(c, -500)).toEqual(full);
    expect(zoomRectAt(c, 500)).toEqual([0.125, 0.125, 0.75, 0.75]);
    expect(zoomRectAt(c, 250)?.[0]).toBeCloseTo(0.25 * (0.0625 * 2.5), 12);
    expect(zoomRectAt(c, 1500)).toEqual([0.375, 0.375, 0.375, 0.375]);
    expect(zoomRectAt(c, 9000)).toEqual(corner);
    expect(zoomRectAt({ ...clip("c1", 0, 1000), crop: quad }, 300)).toEqual(quad);
    expect(zoomRectAt(clip("c1", 0, 1000), 300)).toBeNull();
  });

  it("glides on output frames: a key's frame, not its ms, anchors the glide", () => {
    const c: EditClip = {
      ...clip("c1", 0, 2000),
      zoom: {
        keys: [
          { tMs: 9, rect: full },
          { tMs: 1000, rect: quad },
        ],
      },
    };
    expect(zoomRectAt(c, 500, 60)?.[0]).toBeCloseTo((0.25 * 29) / 59, 12);
    expect(zoomRectAt(c, 500, 30)?.[0]).toBeCloseTo(0.125, 12);
    expect(near(zoomRectAt(c, 1000 / 60, 60), full)).toBe(true);
  });

  it("a split carries the zoom on through the cut", () => {
    const clips = relayout([zoomed()]);
    const split = splitAt(clips, 1500, "c2") ?? [];
    const [left, right] = split;
    for (const t of [0, 500, 1400]) expect(zoomRectAt(left, t)).toEqual(zoomRectAt(clips[0], t));
    for (const t of [0, 300, 600, 1200]) {
      expect(near(zoomRectAt(right, t), zoomRectAt(clips[0], t + 1500))).toBe(true);
    }
    expect(right.zoom?.keys.map((k) => k.tMs)).toEqual([-500, 500]);
  });

  it("trims and speed changes keep keys on the frames they framed; a freeze takes the framing as a crop", () => {
    const clips = relayout([zoomed()]);
    const trimmed = trimClipIn(clips, "c1", 500)[0];
    expect(trimmed.zoom?.keys.map((k) => k.tMs)).toEqual([-500, 500, 1500]);
    const fast = setClipSpeed(clips, "c1", 2)[0];
    expect(fast.zoom?.keys.map((k) => k.tMs)).toEqual([0, 500, 1000]);
    const freeze = (freezeAt(clips, 1500, 800) ?? [])[1];
    expect(freeze.holdMs).toBe(800);
    expect(freeze.crop).toEqual(zoomRectAt(clips[0], 1500));
    expect(freeze.zoom).toBeUndefined();
  });

  it("set, ease, move and remove keys; a crop gives way and setClipCrop takes the zoom away", () => {
    const cropped = relayout([{ ...clip("c1", 0, 4000), crop: quad }]);
    const one = setZoomKey(cropped, "c1", 1004, corner)[0];
    expect(one.crop).toBeUndefined();
    expect(one.zoom?.keys).toEqual([{ tMs: 1000, rect: corner }]);
    const two = setZoomKey([one], "c1", 500, full, 60, "smooth");
    expect(two[0].zoom?.keys).toEqual([
      { tMs: 500, rect: full, ease: "smooth" },
      { tMs: 1000, rect: corner },
    ]);
    expect(setZoomKey(two, "c1", 500, quad)[0].zoom?.keys[0]).toEqual({
      tMs: 500,
      rect: quad,
      ease: "smooth",
    });
    expect(setZoomKeyEase(two, "c1", 500, "linear")[0].zoom?.keys[0]).toEqual({
      tMs: 500,
      rect: full,
    });
    expect(moveZoomKey(two, "c1", 500, 1500)[0].zoom?.keys.map((k) => k.tMs)).toEqual([1000, 1500]);
    expect(removeZoomKey(two, "c1", 1000)[0].zoom?.keys).toHaveLength(1);
    expect("zoom" in removeZoomKey([one], "c1", 1000)[0]).toBe(false);
    expect("zoom" in setClipCrop(two, "c1", quad)[0]).toBe(false);
    expect(Object.keys(setClipCrop(two, "c1", null)[0])).not.toContain("zoom");
  });

  it("taps drop when the framing cuts them out as they land, and map across the framing", () => {
    const clips = relayout([zoomed()]);
    const tap: EditTap = { id: "t1", sourceId: "s1", sourceMs: 1500, pos: [0.5, 0.4] };
    expect(tapWindows(clips, tap, 550)).toEqual([{ startMs: 1500, endMs: 2050 }]);
    expect(tapWindows(clips, { ...tap, pos: [0.2, 0.2] }, 550)).toEqual([]);
    expect(tapPosInZoom([0.5, 0.5], quad)).toEqual([0.5, 0.5]);
    expect(tapPosInZoom([0.1, 0.5], quad)).toBeNull();
  });

  it("fitZoomRect covers a box at the output's shape and stays inside the frame", () => {
    const phone = { width: 1170, height: 2532 };
    const [x, y, w, h] = fitZoomRect([0.1, 0.1, 0.2, 0.6], phone, 1080 / 1920);
    expect(cropPixels([x, y, w, h], phone)).toEqual([0, 254, 854, 1520]);
    expect((w * 1170) / (h * 2532)).toBeCloseTo(1080 / 1920, 2);
    expect(fitZoomRect([0, 0, 1, 1], phone, 1170 / 2532)).toEqual([0, 0, 1, 1]);
  });
});
