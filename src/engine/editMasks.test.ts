import { describe, expect, it } from "vitest";
import type { EditClip, EditMask, EditSource } from "./edit";
import {
  addHoldKey,
  clampRect,
  defaultMaskRange,
  defaultMaskRect,
  keyToleranceMs,
  type MaskRect,
  maskBlockPx,
  maskBlurSigmaPx,
  maskWindows,
  nextMaskId,
  offsetMaskKeys,
  packMaskRows,
  pruneOrphanMasks,
  rectFromCorners,
  removeMaskKey,
  retimeMaskEdge,
  sampleMaskRect,
  sourceMomentAt,
  timelineToSourceUnclamped,
  upsertMaskKey,
} from "./editMasks";
import { relayout } from "./editMath";

const clip = (id: string, inMs: number, outMs: number, speed = 1, sourceId = "s1"): EditClip => ({
  id,
  sourceId,
  inMs,
  outMs,
  speed,
  startMs: 0,
});
const freeze = (id: string, srcMs: number, holdMs: number, sourceId = "s1"): EditClip => ({
  id,
  sourceId,
  inMs: srcMs,
  outMs: srcMs,
  speed: 1,
  startMs: 0,
  holdMs,
});
const R = (x: number, y: number, w: number, h: number): MaskRect => [x, y, w, h];
const mask = (over: Partial<EditMask> = {}): EditMask => ({
  id: "m1",
  sourceId: "s1",
  style: "solid",
  startMs: 1000,
  endMs: 3000,
  keys: [{ sourceMs: 1000, rect: R(0.1, 0.1, 0.2, 0.2) }],
  ...over,
});
const video: EditSource = {
  id: "s1",
  rel: "assets/a.mp4",
  width: 1179,
  height: 2556,
  fps: 60,
  durationMs: 10_000,
};
const still: EditSource = { ...video, id: "s2", rel: "assets/b.png", kind: "image", fps: 0 };

describe("mask sampling", () => {
  const keys = [
    { sourceMs: 1000, rect: R(0, 0, 0.2, 0.2) },
    { sourceMs: 2000, rect: R(0.4, 0.2, 0.4, 0.2) },
  ];

  it("holds the first key before it and the last key after it", () => {
    expect(sampleMaskRect(keys, 0)).toEqual(R(0, 0, 0.2, 0.2));
    expect(sampleMaskRect(keys, 5000)).toEqual(R(0.4, 0.2, 0.4, 0.2));
  });

  it("glides linearly between keys", () => {
    const [x, y, w, h] = sampleMaskRect(keys, 1500) as MaskRect;
    expect(x).toBeCloseTo(0.2);
    expect(y).toBeCloseTo(0.1);
    expect(w).toBeCloseTo(0.3);
    expect(h).toBeCloseTo(0.2);
  });

  it("a single key is static and no keys sample nothing", () => {
    expect(sampleMaskRect([keys[0]], 9000)).toEqual(keys[0].rect);
    expect(sampleMaskRect([], 0)).toBeNull();
  });
});

describe("mask moments and windows", () => {
  it("sourceMomentAt reads freezes as their pinned frame and clamps the very end", () => {
    const clips = relayout([
      clip("c1", 0, 1000),
      freeze("c2", 400, 500),
      clip("c3", 2000, 4000, 2),
    ]);
    expect(sourceMomentAt(clips, 1200)).toMatchObject({
      clip: clips[1],
      sourceMs: 400,
      hold: true,
    });
    expect(sourceMomentAt(clips, 2000)).toMatchObject({ sourceMs: 3000, hold: false });
    expect(sourceMomentAt(clips, 99_999)).toMatchObject({ index: 2, sourceMs: 3998 });
    expect(sourceMomentAt([], 0)).toBeNull();
  });

  it("retimes a window by the clip's speed and marks only the mask's own ends", () => {
    const clips = relayout([clip("c1", 0, 2000, 2), clip("c2", 2000, 6000)]);
    expect(maskWindows(clips, mask(), false)).toEqual([
      {
        maskId: "m1",
        clipId: "c1",
        startMs: 500,
        endMs: 1000,
        startEdge: true,
        endEdge: false,
        hold: false,
      },
      {
        maskId: "m1",
        clipId: "c2",
        startMs: 1000,
        endMs: 2000,
        startEdge: false,
        endEdge: true,
        hold: false,
      },
    ]);
  });

  it("a duplicated segment shows the mask in each copy", () => {
    const clips = relayout([clip("c1", 0, 4000), clip("c2", 0, 4000)]);
    const windows = maskWindows(clips, mask(), false);
    expect(windows.map((w) => [w.startMs, w.endMs])).toEqual([
      [1000, 3000],
      [5000, 7000],
    ]);
  });

  it("a freeze is covered for its whole hold only when its pinned frame is", () => {
    const clips = relayout([freeze("c1", 1500, 800), freeze("c2", 3000, 800)]);
    expect(maskWindows(clips, mask(), false)).toEqual([
      {
        maskId: "m1",
        clipId: "c1",
        startMs: 0,
        endMs: 800,
        startEdge: false,
        endEdge: false,
        hold: true,
      },
    ]);
  });

  it("ignores other sources and spans the clips never show", () => {
    const clips = relayout([clip("c1", 0, 900), clip("c2", 1000, 2000, 1, "s2")]);
    expect(maskWindows(clips, mask(), false)).toEqual([]);
  });

  it("covers every clip of a masked still, whatever the span", () => {
    const clips = relayout([clip("c1", 0, 1000), freeze("c2", 0, 2000, "s2")]);
    const windows = maskWindows(clips, mask({ sourceId: "s2", startMs: 0, endMs: 0 }), true);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ clipId: "c2", startMs: 1000, endMs: 3000, hold: true });
  });

  it("packs every bar of a mask on one row, overlapping masks on the next", () => {
    const w = (maskId: string, startMs: number, endMs: number) => ({
      maskId,
      clipId: "c",
      startMs,
      endMs,
      startEdge: true,
      endEdge: true,
      hold: false,
    });
    const rows = packMaskRows(
      new Map([
        ["a", [w("a", 0, 1000), w("a", 3000, 4000)]],
        ["b", [w("b", 500, 1500)]],
        ["c", [w("c", 1500, 2500)]],
        ["d", []],
      ]),
    );
    expect(Object.fromEntries(rows)).toEqual({ a: 0, b: 1, c: 0 });
  });
});

describe("mask orphans", () => {
  it("drops masks no clip shows and masks of a missing source", () => {
    const masks = [
      mask(),
      mask({ id: "m2", startMs: 8000, endMs: 9000 }),
      mask({ id: "m3", sourceId: "gone" }),
    ];
    const clips = relayout([clip("c1", 0, 4000)]);
    expect(pruneOrphanMasks(clips, masks, [video]).map((m) => m.id)).toEqual(["m1"]);
  });

  it("returns the same array when nothing is orphaned, and prunes after a trim", () => {
    const masks = [mask()];
    expect(pruneOrphanMasks(relayout([clip("c1", 0, 4000)]), masks, [video])).toBe(masks);
    expect(pruneOrphanMasks(relayout([clip("c1", 3000, 4000)]), masks, [video])).toEqual([]);
  });

  it("keeps a still's mask while any clip of the still remains", () => {
    const masks = [mask({ sourceId: "s2" })];
    expect(pruneOrphanMasks(relayout([freeze("c1", 0, 2000, "s2")]), masks, [video, still])).toBe(
      masks,
    );
    expect(pruneOrphanMasks(relayout([clip("c1", 0, 4000)]), masks, [video, still])).toEqual([]);
  });
});

describe("mask editing", () => {
  it("defaultMaskRange covers 3 s of timeline at the clip's speed, clamped to the source", () => {
    const clips = relayout([clip("c1", 0, 10_000, 2)]);
    const at = (t: number) => {
      const moment = sourceMomentAt(clips, t);
      if (!moment) throw new Error("no moment");
      return defaultMaskRange(moment, video);
    };
    expect(at(1000)).toEqual({ startMs: 2000, endMs: 8000 });
    expect(at(4999)).toEqual({ startMs: 9900, endMs: 10_000 });
  });

  it("upsert edits the key within tolerance and inserts one in order otherwise", () => {
    const tol = keyToleranceMs(60, 1);
    expect(tol).toBeCloseTo(8.333);
    const m = mask();
    const edited = upsertMaskKey(m, 1005, R(0.3, 0.3, 0.2, 0.2), tol, false);
    expect(edited.keys).toEqual([{ sourceMs: 1000, rect: R(0.3, 0.3, 0.2, 0.2) }]);
    const added = upsertMaskKey(m, 500, R(0.5, 0.5, 0.2, 0.2), tol, false);
    expect(added.keys.map((k) => k.sourceMs)).toEqual([500, 1000]);
  });

  it("a still keeps exactly one key", () => {
    const m = mask({ keys: [{ sourceMs: 0, rect: R(0, 0, 0.5, 0.5) }] });
    expect(upsertMaskKey(m, 4000, R(0.1, 0.1, 0.2, 0.2), 8, true).keys).toEqual([
      { sourceMs: 0, rect: R(0.1, 0.1, 0.2, 0.2) },
    ]);
  });

  it("addHoldKey pins the current glide, removeMaskKey never drops the last key", () => {
    const m = mask({
      keys: [
        { sourceMs: 1000, rect: R(0, 0, 0.2, 0.2) },
        { sourceMs: 3000, rect: R(0.4, 0, 0.2, 0.2) },
      ],
    });
    const held = addHoldKey(m, 2000, 8);
    expect(held.keys.map((k) => k.sourceMs)).toEqual([1000, 2000, 3000]);
    expect(held.keys[1].rect[0]).toBeCloseTo(0.2);
    expect(addHoldKey(held, 2004, 8)).toBe(held);
    const single = mask();
    expect(removeMaskKey(single, 1000, 8)).toBe(single);
    expect(removeMaskKey(held, 2000, 8).keys).toHaveLength(2);
  });

  it("offsetMaskKeys moves the whole path by one delta that keeps every key in frame", () => {
    const m = mask({
      keys: [
        { sourceMs: 1000, rect: R(0.1, 0.1, 0.2, 0.2) },
        { sourceMs: 2000, rect: R(0.7, 0.5, 0.2, 0.2) },
      ],
    });
    const moved = offsetMaskKeys(m, 0.5, -0.5);
    expect(moved.keys[0].rect[0]).toBeCloseTo(0.2);
    expect(moved.keys[1].rect[0]).toBeCloseTo(0.8);
    expect(moved.keys[0].rect[1]).toBeCloseTo(0);
    expect(moved.keys[1].rect[1]).toBeCloseTo(0.4);
  });

  it("a bar end can be dragged across a contiguous split", () => {
    const clips = relayout([clip("c1", 0, 2000), clip("c2", 2000, 4000)]);
    const src = timelineToSourceUnclamped(clips[0], 2600);
    expect(src).toBe(2600);
    expect(retimeMaskEdge(mask(), "end", src, 10_000).endMs).toBe(2600);
  });

  it("retimeMaskEdge keeps the minimum span and stays in the source", () => {
    expect(retimeMaskEdge(mask(), "start", 2990, 10_000).startMs).toBe(2900);
    expect(retimeMaskEdge(mask(), "start", -50, 10_000).startMs).toBe(0);
    expect(retimeMaskEdge(mask(), "end", 1010, 10_000).endMs).toBe(1100);
    expect(retimeMaskEdge(mask(), "end", 20_000, 10_000).endMs).toBe(10_000);
  });

  it("rects stay in frame and above the minimum size", () => {
    expect(clampRect(R(0.95, -0.2, 0.2, 0))).toEqual(R(0.8, 0, 0.2, 0.01));
    expect(rectFromCorners([0.6, 0.6], [0.2, 0.3])).toEqual(R(0.2, 0.3, 0.39999999999999997, 0.3));
    const box = defaultMaskRect([0.5, 0.5], video);
    expect(box[2] * video.width).toBeCloseTo(0.35 * 1179);
    expect(box[3] * video.height).toBeCloseTo(0.12 * 1179);
  });

  it("nextMaskId counts past existing ids", () => {
    expect(nextMaskId([])).toBe("m1");
    expect(nextMaskId([mask(), mask({ id: "m7" })])).toBe("m8");
  });

  it("strength maps above the safe floor, matching edit_masks.rs", () => {
    expect(maskBlurSigmaPx({ strength: 0 }, video)).toBe(9.43);
    expect(maskBlurSigmaPx({}, video)).toBe(28.3);
    expect(maskBlurSigmaPx({ strength: 1 }, video)).toBe(47.16);
    expect(maskBlockPx({ strength: 0 }, video)).toBe(30);
    expect(maskBlockPx({}, video)).toBe(74);
    expect(maskBlockPx({ strength: 1 }, video)).toBe(118);
  });
});
