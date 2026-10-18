import { describe, expect, it } from "vitest";
import { mulberry32, randomEditDoc, randomEditOp } from "../agentKit/editVectors";
import type { EditClip, EditDoc, EditMask, EditSource } from "./edit";
import {
  addHoldKey,
  clampRect,
  defaultMaskRange,
  keyToleranceMs,
  nextMaskId,
  offsetMaskKeys,
  pruneOrphanMasks,
  removeMaskKey,
  replaceMask,
  retimeMaskEdge,
  sourceMomentAt,
  upsertMaskKey,
} from "./editMasks";
import {
  addTap,
  DEFAULT_HOLD_MS,
  freezeAt,
  freezeAtEnd,
  imageClip,
  insertClipAt,
  moveClip,
  moveTap,
  nextClipId,
  nextSourceId,
  nextTapId,
  outputToSource,
  relayout,
  removeClip,
  removeTap,
  retimeTap,
  setClipHold,
  setClipSpeed,
  splitAt,
  timelineDurationMs,
  trimClipIn,
  trimClipOut,
} from "./editMath";
import { applyEditOp, type EditOp, type EditOpResult, type SourceMeta } from "./editOps";

const VIDEO: EditSource = {
  id: "s1",
  rel: "assets/a.mp4",
  kind: "video",
  width: 1170,
  height: 2532,
  fps: 60,
  durationMs: 12000,
};
const IMAGE: EditSource = {
  id: "s2",
  rel: "assets/b.png",
  kind: "image",
  width: 1920,
  height: 1080,
  fps: 0,
  durationMs: 0,
};
const m1: EditMask = {
  id: "m1",
  sourceId: "s1",
  style: "blur",
  startMs: 1000,
  endMs: 3000,
  keys: [
    { sourceMs: 1000, rect: [0.1, 0.1, 0.3, 0.1] },
    { sourceMs: 2000, rect: [0.2, 0.3, 0.4, 0.2] },
  ],
};
const m2: EditMask = {
  id: "m2",
  sourceId: "s2",
  style: "solid",
  startMs: 0,
  endMs: 0,
  keys: [{ sourceMs: 0, rect: [0.4, 0.4, 0.2, 0.2] }],
};

/** c1 0-4000, freeze c2 4000-5000, c3 at 2x 5000-6500, still c4 6500-8500. */
const DOC: EditDoc = {
  version: 2,
  name: "demo",
  sources: [VIDEO, IMAGE],
  settings: { width: 1170, height: 2532, fps: 60 },
  clips: relayout([
    { id: "c1", sourceId: "s1", inMs: 0, outMs: 4000, speed: 1, startMs: 0 },
    { id: "c2", sourceId: "s1", inMs: 4000, outMs: 4000, speed: 1, startMs: 0, holdMs: 1000 },
    { id: "c3", sourceId: "s1", inMs: 6000, outMs: 9000, speed: 2, startMs: 0 },
    { id: "c4", sourceId: "s2", inMs: 0, outMs: 0, speed: 1, startMs: 0, holdMs: 2000 },
  ]),
  taps: [{ id: "t1", sourceId: "s1", sourceMs: 1500, pos: [0.5, 0.4] }],
  masks: [m1, m2],
};

const NEW_VIDEO: SourceMeta = {
  rel: "assets/c.mp4",
  kind: "video",
  width: 1920,
  height: 1080,
  fps: 30,
  durationMs: 3000,
};
const NEW_IMAGE: SourceMeta = {
  rel: "assets/d.png",
  kind: "image",
  width: 800,
  height: 600,
  fps: 0,
  durationMs: 0,
};

function ok(op: EditOp, doc = DOC) {
  const result = applyEditOp(doc, op);
  if (!result.ok) throw new Error(`${op.op} failed: ${result.code} ${result.message}`);
  return result;
}

function code(op: unknown, doc = DOC) {
  const result = applyEditOp(doc, op as EditOp);
  expect(result.ok, `${JSON.stringify(op)} should fail`).toBe(false);
  return result.ok ? null : result.code;
}

const ids = (clips: EditClip[]) => clips.map((c) => c.id);

describe("applyEditOp", () => {
  it("never mutates its input and relays out first", () => {
    const frozen = structuredClone(DOC);
    const unlaid = { ...DOC, clips: DOC.clips.map((c) => ({ ...c, startMs: 7 })) };
    ok({ op: "split", atMs: 1000 }, unlaid);
    ok({ op: "addMask", atMs: 1500, rect: [0.1, 0.1, 0.2, 0.2] });
    expect(DOC).toEqual(frozen);
    expect(ok({ op: "removeTap", tapId: "t1" }, unlaid).doc.clips).toEqual(DOC.clips);
  });

  describe("clips", () => {
    it("addClip appends a full-length video, reuses a source by rel and clamps the index", () => {
      const added = ok({ op: "addClip", source: NEW_VIDEO });
      expect(added).toMatchObject({ label: "add clip", created: "c5" });
      expect(added.doc.sources.at(-1)).toEqual({ id: "s3", ...NEW_VIDEO });
      expect(added.doc.clips.at(-1)).toMatchObject({
        id: "c5",
        sourceId: "s3",
        inMs: 0,
        outMs: 3000,
      });
      const reused = ok({
        op: "addClip",
        source: { ...NEW_VIDEO, rel: "assets/a.mp4", durationMs: 5000 },
        index: -3,
      });
      expect(reused.doc.sources).toEqual(DOC.sources);
      expect(reused.doc.clips[0]).toMatchObject({ id: "c5", sourceId: "s1", outMs: 5000 });
      const image = ok({ op: "addClip", source: NEW_IMAGE, index: 2 });
      expect(image.doc.clips[2]).toMatchObject({ holdMs: DEFAULT_HOLD_MS, inMs: 0, outMs: 0 });
      expect(code({ op: "addClip", source: NEW_VIDEO, index: 0.5 })).toBe("bad-arg");
      expect(code({ op: "addClip", source: { ...NEW_VIDEO, kind: "audio" } })).toBe("bad-arg");
      expect(code({ op: "addClip", source: { ...NEW_VIDEO, durationMs: -1 } })).toBe("bad-arg");
    });

    it("insertClip splices at a time, slipping off freezes and appending past the end", () => {
      const mid = ok({ op: "insertClip", source: NEW_VIDEO, atMs: 2000 });
      expect(mid).toMatchObject({ label: "insert clip", created: "c5" });
      expect(ids(mid.doc.clips)).toEqual(["c1", "c5", "c6", "c2", "c3", "c4"]);
      expect(ids(ok({ op: "insertClip", source: NEW_IMAGE, atMs: 4200 }).doc.clips)).toEqual([
        "c1",
        "c5",
        "c2",
        "c3",
        "c4",
      ]);
      expect(ok({ op: "insertClip", source: NEW_VIDEO, atMs: 1e6 }).doc.clips.at(-1)?.id).toBe(
        "c5",
      );
      expect(code({ op: "insertClip", source: NEW_VIDEO })).toBe("bad-arg");
    });

    it("split cuts the clip under the time, refusing freezes, stills and the 100ms floor", () => {
      const split = ok({ op: "split", atMs: 1000.5 });
      expect(split).toMatchObject({ label: "split clip", created: "c5" });
      expect(split.doc.clips.slice(0, 2)).toMatchObject([
        { id: "c1", outMs: 1001 },
        { id: "c5", inMs: 1001 },
      ]);
      expect(code({ op: "split", atMs: 9000 })).toBe("no-clip");
      expect(code({ op: "split", atMs: 4500 })).toBe("no-split");
      expect(code({ op: "split", atMs: 7000 })).toBe("no-split");
      expect(code({ op: "split", atMs: 40 })).toBe("no-split");
      expect(code({ op: "split", atMs: Number.NaN })).toBe("bad-arg");
    });

    it("freeze holds the frame under the time, or the last frame at the end", () => {
      const mid = ok({ op: "freeze", atMs: 2000 });
      expect(mid).toMatchObject({ label: "freeze frame", created: "c5" });
      expect(mid.doc.clips[1]).toMatchObject({ id: "c5", inMs: 2000, outMs: 2000, holdMs: 2000 });
      const lastVideo = { ...DOC, clips: DOC.clips.slice(0, 3) };
      const end = ok({ op: "freeze", atMs: 6495, holdMs: 1500 }, lastVideo);
      expect(end.doc.clips.at(-1)).toMatchObject({ inMs: 8967, holdMs: 1500 });
      expect(code({ op: "freeze", atMs: 8500 })).toBe("no-freeze");
      expect(code({ op: "freeze", atMs: 4500 })).toBe("no-freeze");
      expect(code({ op: "freeze", atMs: 9000 })).toBe("no-clip");
      expect(code({ op: "freeze", atMs: 0 }, { ...DOC, clips: [] })).toBe("no-clip");
      expect(code({ op: "freeze", atMs: 2000, holdMs: 0 })).toBe("bad-arg");
    });

    it("the at-end rule reads half an output frame at the doc's rate (60 when unset)", () => {
      const lastVideo = {
        ...DOC,
        settings: { ...DOC.settings, fps: 0 },
        clips: DOC.clips.slice(0, 3),
      };
      expect(ok({ op: "freeze", atMs: 6491.7 }, lastVideo).doc.clips).toHaveLength(4);
      const at30 = { ...lastVideo, settings: { ...DOC.settings, fps: 30 } };
      expect(ok({ op: "freeze", atMs: 6484 }, at30).doc.clips.at(-1)?.holdMs).toBe(2000);
      // Just outside half a frame: a mid-clip freeze that slips past the source floor instead.
      expect(ok({ op: "freeze", atMs: 6491 }, lastVideo).doc.clips.at(-1)?.inMs).toBe(8982);
    });

    it("removeClip and moveClip relay out and prune masks they orphan", () => {
      const removed = ok({ op: "removeClip", clipId: "c4" });
      expect(removed.label).toBe("remove clip");
      expect(removed.doc.masks?.map((m) => m.id)).toEqual(["m1"]);
      expect(code({ op: "removeClip", clipId: "c9" })).toBe("unknown-clip");
      expect(code({ op: "removeClip", clipId: 3 })).toBe("bad-arg");
      const moved = ok({ op: "moveClip", from: 3, to: 0 });
      expect(moved.label).toBe("reorder clip");
      expect(moved.doc.clips.map((c) => [c.id, c.startMs])).toEqual([
        ["c4", 0],
        ["c1", 2000],
        ["c2", 6000],
        ["c3", 7000],
      ]);
      expect(code({ op: "moveClip", from: 4, to: 0 })).toBe("bad-arg");
      expect(code({ op: "moveClip", from: 0, to: 1.5 })).toBe("bad-arg");
    });

    it("setSpeed, trimIn and trimOut refuse holds and bad values", () => {
      expect(ok({ op: "setSpeed", clipId: "c1", speed: 1.35 })).toMatchObject({
        label: "change clip speed",
      });
      expect(code({ op: "setSpeed", clipId: "c1", speed: 0 })).toBe("bad-arg");
      expect(code({ op: "setSpeed", clipId: "c2", speed: 2 })).toBe("bad-arg");
      expect(code({ op: "setSpeed", clipId: "c9", speed: 2 })).toBe("unknown-clip");
      const trimIn = ok({ op: "trimIn", clipId: "c1", inMs: 3999 });
      expect(trimIn).toMatchObject({ label: "trim clip start" });
      expect(trimIn.doc.clips[0].inMs).toBe(3900);
      const trimOut = ok({ op: "trimOut", clipId: "c3", outMs: 20000 });
      expect(trimOut).toMatchObject({ label: "trim clip end" });
      expect(trimOut.doc.clips[2].outMs).toBe(12000);
      expect(code({ op: "trimIn", clipId: "c4", inMs: 10 })).toBe("bad-arg");
      expect(code({ op: "trimOut", clipId: "c2", outMs: 10 })).toBe("bad-arg");
    });

    it("trimOut on a clip whose source is missing caps at its own out-point, like the timeline", () => {
      const dangling = { ...DOC, clips: [{ ...DOC.clips[0], sourceId: "s9" }], masks: [] };
      expect(ok({ op: "trimOut", clipId: "c1", outMs: 9000 }, dangling).doc.clips[0].outMs).toBe(
        4000,
      );
    });

    it("setHold retimes freezes and stills only", () => {
      expect(ok({ op: "setHold", clipId: "c4", holdMs: 20 }).doc.clips[3].holdMs).toBe(100);
      expect(ok({ op: "setHold", clipId: "c2", holdMs: 2500.4 })).toMatchObject({
        label: "retime freeze",
      });
      expect(code({ op: "setHold", clipId: "c1", holdMs: 2000 })).toBe("bad-arg");
      expect(code({ op: "setHold", clipId: "c2", holdMs: 0 })).toBe("bad-arg");
    });
  });

  describe("taps", () => {
    it("addTap anchors at the source moment under the time", () => {
      const added = ok({ op: "addTap", atMs: 5500, pos: [0.2, 0.8] });
      expect(added).toMatchObject({ label: "add tap", created: "t2" });
      expect(added.doc.taps?.at(-1)).toEqual({
        id: "t2",
        sourceId: "s1",
        sourceMs: 7000,
        pos: [0.2, 0.8],
      });
      expect(code({ op: "addTap", atMs: 4500, pos: [0.5, 0.5] })).toBe("no-clip");
      expect(code({ op: "addTap", atMs: 7000, pos: [0.5, 0.5] })).toBe("no-clip");
      expect(code({ op: "addTap", atMs: 1000, pos: [1.01, 0.5] })).toBe("bad-arg");
    });

    it("addTapAtSource places by source time and refuses stills and unknown sources", () => {
      expect(
        ok({ op: "addTapAtSource", sourceId: "s1", sourceMs: 30000, pos: [0, 0] }).created,
      ).toBe("t2");
      expect(code({ op: "addTapAtSource", sourceId: "s2", sourceMs: 0, pos: [0, 0] })).toBe(
        "image-source",
      );
      expect(code({ op: "addTapAtSource", sourceId: "s9", sourceMs: 0, pos: [0, 0] })).toBe(
        "unknown-source",
      );
      expect(code({ op: "addTapAtSource", sourceId: "s1", sourceMs: 1.5, pos: [0, 0] })).toBe(
        "bad-arg",
      );
    });

    it("moveTap, retimeTap and removeTap find taps by id", () => {
      expect(ok({ op: "moveTap", tapId: "t1", pos: [0.9, 0.1] }).doc.taps?.[0].pos).toEqual([
        0.9, 0.1,
      ]);
      expect(ok({ op: "retimeTap", tapId: "t1", atMs: 5750.5 }).doc.taps?.[0]).toMatchObject({
        sourceMs: 7501,
      });
      expect(ok({ op: "removeTap", tapId: "t1" })).toMatchObject({ label: "delete tap" });
      expect(code({ op: "moveTap", tapId: "t9", pos: [0, 0] })).toBe("unknown-tap");
      expect(code({ op: "retimeTap", tapId: "t9", atMs: 0 })).toBe("unknown-tap");
      expect(code({ op: "retimeTap", tapId: "t1", atMs: 4500 })).toBe("no-clip");
      expect(code({ op: "removeTap", tapId: "t9" })).toBe("unknown-tap");
    });

    it("setTapLook sets the edit-wide look with the handler's label", () => {
      expect(ok({ op: "setTapLook", style: "glow" })).toMatchObject({ label: "change tap style" });
      expect(ok({ op: "setTapLook", color: "red" })).toMatchObject({ label: "change tap colour" });
      expect(ok({ op: "setTapLook", size: 2 })).toMatchObject({ label: "resize tap" });
      const all = ok({ op: "setTapLook", style: "ring", color: "dark", size: 0.5 });
      expect(all.label).toBe("change tap look");
      expect(all.doc).toMatchObject({ tapStyle: "ring", tapColor: "dark", tapSize: 0.5 });
      expect(code({ op: "setTapLook" })).toBe("bad-arg");
      expect(code({ op: "setTapLook", size: -1 })).toBe("bad-arg");
    });
  });

  describe("masks", () => {
    it("addMask draws a solid box over the next 3 s at the clip's speed, keyed here", () => {
      const added = ok({ op: "addMask", atMs: 5500, rect: [0.1, 0.2, 0.3, 0.1] });
      expect(added).toMatchObject({ label: "add mask", created: "m3" });
      expect(added.doc.masks?.at(-1)).toEqual({
        id: "m3",
        sourceId: "s1",
        style: "solid",
        startMs: 7000,
        endMs: 12000,
        keys: [{ sourceMs: 7000, rect: [0.1, 0.2, 0.3, 0.1] }],
      });
    });

    it("addMask on a still has no span and one key at 0; the look applies after", () => {
      const still = ok({
        op: "addMask",
        atMs: 7000,
        rect: [0.95, 0.95, 0.5, 0.001],
        style: "pixelate",
        strength: 0.8,
      });
      expect(still.doc.masks?.at(-1)).toMatchObject({
        sourceId: "s2",
        style: "pixelate",
        strength: 0.8,
        startMs: 0,
        endMs: 0,
        keys: [{ sourceMs: 0, rect: [0.5, 0.95, 0.5, 0.01] }],
      });
      expect(code({ op: "addMask", atMs: 0, rect: [0, 0, 1, 1] }, { ...DOC, clips: [] })).toBe(
        "no-clip",
      );
      expect(code({ op: "addMask", atMs: 0, rect: [0, 0, 1] })).toBe("bad-arg");
      expect(code({ op: "addMask", atMs: 0, rect: [0, 0, 1, 1], color: "red" })).toBe("bad-arg");
      const dangling = { ...DOC, clips: [{ ...DOC.clips[0], sourceId: "s9" }], masks: [] };
      expect(code({ op: "addMask", atMs: 10, rect: [0, 0, 1, 1] }, dangling)).toBe(
        "unknown-source",
      );
    });

    it("setMaskRect auto-keys at the frame on screen, editing a key within half a frame", () => {
      const replaced = ok({
        op: "setMaskRect",
        maskId: "m1",
        atMs: 1008,
        rect: [0.5, 0.5, 0.2, 0.2],
      });
      expect(replaced.label).toBe("move mask");
      expect(replaced.doc.masks?.[0].keys.map((k) => k.sourceMs)).toEqual([1000, 2000]);
      const inserted = ok({
        op: "setMaskRect",
        maskId: "m1",
        atMs: 1500.5,
        rect: [0, 0, 0.2, 0.2],
      });
      expect(inserted.doc.masks?.[0].keys.map((k) => k.sourceMs)).toEqual([1000, 1501, 2000]);
      expect(code({ op: "setMaskRect", maskId: "m1", atMs: 7000, rect: [0, 0, 1, 1] })).toBe(
        "source-mismatch",
      );
      expect(code({ op: "setMaskRect", maskId: "m9", atMs: 0, rect: [0, 0, 1, 1] })).toBe(
        "unknown-mask",
      );
    });

    it("offsetMask, retimeMaskEdge and removeMask", () => {
      const moved = ok({ op: "offsetMask", maskId: "m1", dx: 0.9, dy: 0 });
      expect(moved.label).toBe("move mask path");
      expect(moved.doc.masks?.[0].keys.map((k) => Number(k.rect[0].toFixed(9)))).toEqual([
        0.5, 0.6,
      ]);
      const retimed = ok({ op: "retimeMaskEdge", maskId: "m1", edge: "end", sourceMs: 99999 });
      expect(retimed).toMatchObject({ label: "retime mask" });
      expect(retimed.doc.masks?.[0].endMs).toBe(12000);
      expect(code({ op: "retimeMaskEdge", maskId: "m2", edge: "end", sourceMs: 10 })).toBe(
        "image-source",
      );
      expect(code({ op: "retimeMaskEdge", maskId: "m1", edge: "mid", sourceMs: 10 })).toBe(
        "bad-arg",
      );
      expect(ok({ op: "removeMask", maskId: "m2" }).doc.masks?.map((m) => m.id)).toEqual(["m1"]);
      expect(code({ op: "removeMask", maskId: "m9" })).toBe("unknown-mask");
    });

    it("addMaskKey and removeMaskKey refuse what their handlers silently skip", () => {
      expect(ok({ op: "addMaskKey", maskId: "m1", atMs: 1500 }).doc.masks?.[0].keys).toHaveLength(
        3,
      );
      expect(code({ op: "addMaskKey", maskId: "m1", atMs: 1004 })).toBe("no-change");
      expect(code({ op: "addMaskKey", maskId: "m2", atMs: 7000 })).toBe("image-source");
      expect(code({ op: "addMaskKey", maskId: "m2", atMs: 1500 })).toBe("source-mismatch");
      expect(
        ok({ op: "removeMaskKey", maskId: "m1", atMs: 2003 }).doc.masks?.[0].keys,
      ).toHaveLength(1);
      expect(code({ op: "removeMaskKey", maskId: "m1", atMs: 1500 })).toBe("no-change");
      expect(code({ op: "removeMaskKey", maskId: "m2", atMs: 7000 })).toBe("no-change");
      expect(code({ op: "removeMaskKey", maskId: "m1", atMs: 0 }, { ...DOC, clips: [] })).toBe(
        "no-clip",
      );
    });

    it("setMaskLook follows the strip: an unchanged style is no change, null clears a field", () => {
      expect(code({ op: "setMaskLook", maskId: "m1", style: "blur" })).toBe("no-change");
      expect(ok({ op: "setMaskLook", maskId: "m1", style: "solid" })).toMatchObject({
        label: "change mask style",
      });
      const strong = ok({ op: "setMaskLook", maskId: "m1", strength: 0.9 });
      expect(strong.label).toBe("change mask strength");
      const cleared = ok({ op: "setMaskLook", maskId: "m1", strength: null }, strong.doc);
      expect("strength" in (cleared.doc.masks?.[0] ?? {})).toBe(false);
      const coloured = ok({ op: "setMaskLook", maskId: "m2", color: "#abcdef" });
      expect(coloured.label).toBe("change mask colour");
      expect(
        ok({ op: "setMaskLook", maskId: "m2", style: "blur", color: null }, coloured.doc),
      ).toMatchObject({ label: "change mask look" });
      expect(code({ op: "setMaskLook", maskId: "m1" })).toBe("bad-arg");
      expect(code({ op: "setMaskLook", maskId: "m1", strength: 1.2 })).toBe("bad-arg");
      expect(code({ op: "setMaskLook", maskId: "m9", style: "solid" })).toBe("unknown-mask");
    });
  });

  it("setClipCrop snaps to even pixels, and resets", () => {
    const cropped = ok({ op: "setClipCrop", clipId: "c1", crop: [0.1, 0.2, 0.5, 0.25] });
    expect(cropped.label).toBe("crop clip");
    const crop = cropped.doc.clips[0].crop ?? [Number.NaN, 0, Number.NaN, 0];
    expect([crop[0] * 1170, crop[2] * 1170].map((v) => Math.round(v) % 2)).toEqual([0, 0]);
    expect(code({ op: "setClipCrop", clipId: "c1", crop }, cropped.doc)).toBe("no-change");
    const reset = ok({ op: "setClipCrop", clipId: "c1", crop: null }, cropped.doc);
    expect(reset.label).toBe("reset crop");
    expect("crop" in reset.doc.clips[0]).toBe(false);
    expect(code({ op: "setClipCrop", clipId: "c1", crop: null })).toBe("no-change");
    expect(code({ op: "setClipCrop", clipId: "c1", crop: [0, 0, 0, 1] })).toBe("bad-arg");
    expect(code({ op: "setClipCrop", clipId: "c1" })).toBe("bad-arg");
    expect(code({ op: "setClipCrop", clipId: "c9", crop: [0, 0, 1, 1] })).toBe("unknown-clip");
    const sizeless = { ...DOC, sources: [{ ...VIDEO, width: 0, height: 0 }, IMAGE] };
    expect(code({ op: "setClipCrop", clipId: "c1", crop: [0, 0, 1, 1] }, sizeless)).toBe("bad-arg");
    expect(
      ok({ op: "setClipCrop", clipId: "c4", crop: [0.25, 0, 0.5, 1] }).doc.clips[3].crop,
    ).toEqual([0.25, 0, 0.5, 1]);
  });

  it("setZoomKey snaps time to the frame grid, fits the output's shape and refuses off-clip times", () => {
    const added = ok({ op: "setZoomKey", clipId: "c1", atMs: 1004.4, rect: [0.1, 0.1, 0.2, 0.4] });
    expect(added.label).toBe("add zoom key");
    const [key] = added.doc.clips[0].zoom?.keys ?? [];
    expect(key.tMs).toBe(1000);
    expect((key.rect[2] * 1170) / (key.rect[3] * 2532)).toBeCloseTo(1170 / 2532, 2);
    expect(code({ op: "setZoomKey", clipId: "c1", atMs: 1000, rect: key.rect }, added.doc)).toBe(
      "no-change",
    );
    const moved = ok(
      { op: "setZoomKey", clipId: "c1", atMs: 1000, rect: [0, 0, 1, 1], ease: "smooth" },
      added.doc,
    );
    expect(moved.label).toBe("change zoom key");
    expect(moved.doc.clips[0].zoom?.keys).toEqual([
      { tMs: 1000, rect: [0, 0, 1, 1], ease: "smooth" },
    ]);
    expect(code({ op: "setZoomKey", clipId: "c1", atMs: 4500, rect: [0, 0, 1, 1] })).toBe(
      "no-clip",
    );
    expect(code({ op: "setZoomKey", clipId: "c1", atMs: 0, rect: [0, 0, 0, 1] })).toBe("bad-arg");
    expect(code({ op: "setZoomKey", clipId: "c9", atMs: 0, rect: [0, 0, 1, 1] })).toBe(
      "unknown-clip",
    );
    expect(
      ok({ op: "setZoomKey", clipId: "c2", atMs: 4500, rect: [0, 0, 1, 1] }).doc.clips[1].zoom,
    ).toBeDefined();
  });

  it("zoom keys delete, ease and retime by their frame, with refusals", () => {
    const one = ok({ op: "setZoomKey", clipId: "c1", atMs: 500, rect: [0, 0, 1, 1] }).doc;
    const two = ok({ op: "setZoomKey", clipId: "c1", atMs: 2000, rect: [0, 0, 0.5, 0.5] }, one).doc;
    expect(code({ op: "setZoomKeyEase", clipId: "c1", tMs: 500, ease: "linear" }, two)).toBe(
      "no-change",
    );
    const eased = ok({ op: "setZoomKeyEase", clipId: "c1", tMs: 504, ease: "smooth" }, two);
    expect(eased.doc.clips[0].zoom?.keys[0].ease).toBe("smooth");
    expect(code({ op: "moveZoomKey", clipId: "c1", tMs: 500, toMs: 2000 }, two)).toBe("bad-arg");
    expect(code({ op: "moveZoomKey", clipId: "c1", tMs: 500, toMs: 505 }, two)).toBe("no-change");
    const retimed = ok({ op: "moveZoomKey", clipId: "c1", tMs: 500, toMs: 2500.2 }, two);
    expect(retimed.doc.clips[0].zoom?.keys.map((k) => k.tMs)).toEqual([2000, 2500]);
    expect(code({ op: "removeZoomKey", clipId: "c1", tMs: 1000 }, two)).toBe("no-change");
    const gone = ok({ op: "removeZoomKey", clipId: "c1", tMs: 500 }, one);
    expect("zoom" in gone.doc.clips[0]).toBe(false);
    expect(code({ op: "removeZoomKey", clipId: "c1", tMs: Number.NaN })).toBe("bad-arg");
    const reset = ok({ op: "setClipCrop", clipId: "c1", crop: null }, two);
    expect("zoom" in reset.doc.clips[0]).toBe(false);
  });

  it("setMaskFade fits fades inside the span and refuses stills", () => {
    const faded = ok({ op: "setMaskFade", maskId: "m1", fadeInMs: 250.4, fadeOutMs: 500 });
    expect(faded.label).toBe("change mask fade");
    expect(faded.doc.masks?.[0]).toMatchObject({ fadeInMs: 250, fadeOutMs: 500 });
    const cleared = ok({ op: "setMaskFade", maskId: "m1", fadeInMs: null }, faded.doc);
    expect("fadeInMs" in (cleared.doc.masks?.[0] ?? {})).toBe(false);
    expect(cleared.doc.masks?.[0].fadeOutMs).toBe(500);
    expect(code({ op: "setMaskFade", maskId: "m1", fadeOutMs: 500 }, faded.doc)).toBe("no-change");
    expect(code({ op: "setMaskFade", maskId: "m1", fadeInMs: 1500, fadeOutMs: 600 })).toBe(
      "bad-arg",
    );
    expect(code({ op: "setMaskFade", maskId: "m1", fadeInMs: -1 })).toBe("bad-arg");
    expect(code({ op: "setMaskFade", maskId: "m1" })).toBe("bad-arg");
    expect(code({ op: "setMaskFade", maskId: "m2", fadeInMs: 100 })).toBe("image-source");
    expect(code({ op: "setMaskFade", maskId: "m9", fadeInMs: 100 })).toBe("unknown-mask");
  });

  it("refuses unknown ops", () => {
    expect(code({ op: "explode" })).toBe("bad-arg");
    expect(code(null)).toBe("bad-arg");
  });
});

// The handlers as EditorApp and Timeline wrote them before the ops existed (git history); the ops must match them wherever the editor could reach.

function commitNormalise(draft: EditDoc): EditDoc {
  const masks = draft.masks && pruneOrphanMasks(draft.clips, draft.masks, draft.sources);
  return masks === draft.masks ? draft : { ...draft, masks };
}

function legacyMoment(doc: EditDoc, ms: number) {
  const moment = sourceMomentAt(doc.clips, ms);
  if (!moment) return null;
  const source = doc.sources.find((s) => s.id === moment.sourceId);
  const fps = doc.settings.fps > 0 ? doc.settings.fps : 60;
  return {
    moment,
    tolMs: keyToleranceMs(fps, moment.hold ? 1 : moment.clip.speed),
    image: source?.kind === "image",
  };
}

function legacy(doc: EditDoc, op: EditOp): EditDoc | null {
  const withMask = (mask: EditMask) => ({ ...doc, masks: replaceMask(doc.masks ?? [], mask) });
  const findMask = (id: string) => doc.masks?.find((m) => m.id === id);
  switch (op.op) {
    case "addClip":
    case "insertClip": {
      const meta = op.source;
      const existing = doc.sources.find((s) => s.rel === meta.rel);
      const sourceId = existing?.id ?? nextSourceId(doc.sources);
      const sources = existing ? doc.sources : [...doc.sources, { id: sourceId, ...meta }];
      const clip: EditClip =
        meta.kind === "image"
          ? imageClip(doc.clips, sourceId, DEFAULT_HOLD_MS)
          : {
              id: nextClipId(doc.clips),
              sourceId,
              inMs: 0,
              outMs: meta.durationMs,
              speed: 1,
              startMs: 0,
            };
      let clips: EditClip[];
      if (op.op === "insertClip") clips = insertClipAt(doc.clips, op.atMs, clip);
      else {
        clips = [...doc.clips];
        clips.splice(Math.max(0, Math.min(clips.length, op.index ?? clips.length)), 0, clip);
        clips = relayout(clips);
      }
      return { ...doc, sources, clips };
    }
    case "split": {
      const next = splitAt(doc.clips, op.atMs, nextClipId(doc.clips));
      return next && { ...doc, clips: next };
    }
    case "freeze": {
      const fps = doc.settings.fps > 0 ? doc.settings.fps : 60;
      const atEnd = Math.abs(op.atMs - timelineDurationMs(doc.clips)) <= 500 / fps;
      const holdMs = op.holdMs ?? DEFAULT_HOLD_MS;
      const next = atEnd
        ? freezeAtEnd(doc.clips, fps, holdMs)
        : freezeAt(doc.clips, op.atMs, holdMs);
      return next && { ...doc, clips: next };
    }
    case "removeClip":
      return { ...doc, clips: removeClip(doc.clips, op.clipId) };
    case "moveClip":
      return { ...doc, clips: moveClip(doc.clips, op.from, op.to) };
    case "setSpeed":
      return { ...doc, clips: setClipSpeed(doc.clips, op.clipId, op.speed) };
    case "trimIn":
      return { ...doc, clips: trimClipIn(doc.clips, op.clipId, op.inMs) };
    case "trimOut": {
      const c = doc.clips.find((x) => x.id === op.clipId);
      const source = doc.sources.find((s) => s.id === c?.sourceId);
      return {
        ...doc,
        clips: trimClipOut(doc.clips, op.clipId, op.outMs, source?.durationMs ?? c?.outMs ?? 0),
      };
    }
    case "setHold":
      return { ...doc, clips: setClipHold(doc.clips, op.clipId, op.holdMs) };
    case "addTap": {
      const at = outputToSource(doc.clips, op.atMs);
      if (!at) return null;
      const taps = doc.taps ?? [];
      return { ...doc, taps: addTap(taps, { id: nextTapId(taps), ...at, pos: op.pos }) };
    }
    case "moveTap":
      return { ...doc, taps: moveTap(doc.taps ?? [], op.tapId, op.pos) };
    case "retimeTap": {
      const at = outputToSource(doc.clips, op.atMs);
      return at && { ...doc, taps: retimeTap(doc.taps ?? [], op.tapId, at.sourceId, at.sourceMs) };
    }
    case "removeTap":
      return { ...doc, taps: removeTap(doc.taps ?? [], op.tapId) };
    case "setTapLook": {
      let next = doc;
      if (op.style !== undefined) next = { ...next, tapStyle: op.style };
      if (op.color !== undefined) next = { ...next, tapColor: op.color };
      if (op.size !== undefined) next = { ...next, tapSize: op.size };
      return next;
    }
    case "addMask": {
      const at = legacyMoment(doc, op.atMs);
      if (!at) return null;
      const source = doc.sources.find((s) => s.id === at.moment.sourceId);
      if (!source) return null;
      const masks = doc.masks ?? [];
      const range = at.image ? { startMs: 0, endMs: 0 } : defaultMaskRange(at.moment, source);
      let mask: EditMask = {
        id: nextMaskId(masks),
        sourceId: source.id,
        style: "solid",
        ...range,
        // MaskLayer only ever hands over clamped boxes.
        keys: [{ sourceMs: at.image ? 0 : at.moment.sourceMs, rect: clampRect(op.rect) }],
      };
      if (op.style && mask.style !== op.style) mask = { ...mask, style: op.style };
      if (op.strength !== undefined) mask = { ...mask, strength: op.strength };
      if (op.color !== undefined) mask = { ...mask, color: op.color };
      return { ...doc, masks: [...masks, mask] };
    }
    case "setMaskRect": {
      const mask = findMask(op.maskId);
      const at = legacyMoment(doc, op.atMs);
      if (!mask || !at || at.moment.sourceId !== mask.sourceId) return null;
      return withMask(upsertMaskKey(mask, at.moment.sourceMs, op.rect, at.tolMs, at.image));
    }
    case "offsetMask": {
      const mask = findMask(op.maskId);
      return mask ? withMask(offsetMaskKeys(mask, op.dx, op.dy)) : null;
    }
    case "addMaskKey":
    case "removeMaskKey": {
      const mask = findMask(op.maskId);
      const at = legacyMoment(doc, op.atMs);
      if (!mask || !at || at.moment.sourceId !== mask.sourceId) return null;
      if (op.op === "addMaskKey" && at.image) return null;
      const next =
        op.op === "addMaskKey"
          ? addHoldKey(mask, at.moment.sourceMs, at.tolMs)
          : removeMaskKey(mask, at.moment.sourceMs, at.tolMs);
      return next === mask ? null : withMask(next);
    }
    case "retimeMaskEdge": {
      const mask = findMask(op.maskId);
      const source = doc.sources.find((s) => s.id === mask?.sourceId);
      // A still's bars carry no edge handles (maskWindows marks no edges on holds).
      if (!mask || source?.kind === "image") return null;
      return withMask(retimeMaskEdge(mask, op.edge, op.sourceMs, source?.durationMs ?? 0));
    }
    case "setMaskLook": {
      let mask = findMask(op.maskId);
      if (!mask) return null;
      const onlyStyle = op.strength === undefined && op.color === undefined;
      if (op.style !== undefined) {
        if (mask.style === op.style && onlyStyle) return null;
        mask = { ...mask, style: op.style };
      }
      if (op.strength !== undefined) mask = { ...mask, strength: op.strength ?? undefined };
      if (op.color !== undefined) mask = { ...mask, color: op.color ?? undefined };
      return withMask(mask);
    }
    case "removeMask":
      return { ...doc, masks: (doc.masks ?? []).filter((m) => m.id !== op.maskId) };
    default:
      return null;
  }
}

/** Codes the editor can never reach: it only sends known ids and in-range values. */
const UNREACHABLE = new Set([
  "bad-arg",
  "unknown-clip",
  "unknown-tap",
  "unknown-mask",
  "unknown-source",
]);

describe("applyEditOp matches the pre-op editor handlers", () => {
  it("over 400 seeded docs and ops", () => {
    let compared = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rand = mulberry32(seed);
      let doc = randomEditDoc(rand);
      for (let step = 0; step < 6; step++) {
        const op = randomEditOp(rand, doc);
        const result: EditOpResult = applyEditOp(doc, op);
        const fresh = ["addTapAtSource", "setClipCrop", "setMaskFade"].includes(op.op);
        if (fresh || (!result.ok && UNREACHABLE.has(result.code))) {
          if (result.ok) doc = result.doc;
          continue;
        }
        const expected = legacy(doc, op);
        const label = `seed ${seed} step ${step}: ${JSON.stringify(op)}`;
        if (expected === null) {
          expect(result.ok, label).toBe(false);
        } else {
          expect(result.ok, label).toBe(true);
          if (result.ok) {
            expect(result.doc, label).toEqual(commitNormalise(expected));
            doc = result.doc;
          }
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1500);
  });

  it("the timeline's committed edges re-apply unchanged", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 300; i++) {
      const doc = randomEditDoc(rand);
      for (const c of doc.clips) {
        const x = (rand() - 0.2) * 15000;
        const source = doc.sources.find((s) => s.id === c.sourceId);
        if (c.holdMs === undefined) {
          const drafted = trimClipIn(doc.clips, c.id, x);
          const inMs = drafted.find((d) => d.id === c.id)?.inMs ?? 0;
          expect(ok({ op: "trimIn", clipId: c.id, inMs }, doc).doc.clips).toEqual(drafted);
          const limit = source?.durationMs ?? c.outMs;
          const draftedOut = trimClipOut(doc.clips, c.id, x, limit);
          const outMs = draftedOut.find((d) => d.id === c.id)?.outMs ?? 0;
          expect(ok({ op: "trimOut", clipId: c.id, outMs }, doc).doc.clips).toEqual(draftedOut);
        } else {
          const drafted = setClipHold(doc.clips, c.id, Math.abs(x));
          const holdMs = drafted.find((d) => d.id === c.id)?.holdMs ?? 0;
          expect(ok({ op: "setHold", clipId: c.id, holdMs }, doc).doc.clips).toEqual(drafted);
        }
      }
      for (const mask of doc.masks ?? []) {
        const source = doc.sources.find((s) => s.id === mask.sourceId);
        if (source?.kind === "image") continue;
        const edge = rand() < 0.5 ? "start" : "end";
        const drafted = retimeMaskEdge(mask, edge, (rand() - 0.2) * 15000, source?.durationMs ?? 0);
        const sourceMs = edge === "start" ? drafted.startMs : drafted.endMs;
        const result = applyEditOp(doc, { op: "retimeMaskEdge", maskId: mask.id, edge, sourceMs });
        expect(result.ok && result.doc.masks).toEqual(
          commitNormalise({ ...doc, masks: replaceMask(doc.masks ?? [], drafted) }).masks,
        );
      }
    }
  });
});
