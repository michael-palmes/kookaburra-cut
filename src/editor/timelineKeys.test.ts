import { beforeEach, describe, expect, it } from "vitest";
import type { EditDoc, EditMask } from "../engine/edit";
import { maskWindows } from "../engine/editMasks";
import { relayout, snapMs } from "../engine/editMath";
import { applyEditOp } from "../engine/editOps";
import { LARGE_STEP_FRAMES } from "../ui/laneKeys";
import { bindEditorHistory, pushEditorHistory, takeEditorUndo } from "./editorHistory";
import {
  clipLaneItems,
  maskEdgeDraft,
  maskEdgeOp,
  maskLaneItems,
  reorderIndex,
  type TimelineKeyContext,
  timelineItemName,
  timelineNudge,
  trimDraft,
  trimOp,
  zoomKeyTarget,
} from "./timelineKeys";

const FPS = 60;
const FRAME = 1000 / FPS;
const PX_PER_MS = 0.2;

const mask: EditMask = {
  id: "m1",
  sourceId: "s1",
  style: "blur",
  startMs: 1200,
  endMs: 1800,
  keys: [{ sourceMs: 1200, rect: [0.1, 0.1, 0.2, 0.2] }],
};

const doc: EditDoc = {
  version: 3,
  name: "tour",
  sources: [
    { id: "s1", rel: "assets/tour.mp4", width: 1920, height: 1080, fps: 60, durationMs: 10000 },
  ],
  settings: { width: 1920, height: 1080, fps: FPS },
  clips: relayout([
    { id: "c1", sourceId: "s1", inMs: 0, outMs: 2000, speed: 1, startMs: 0 },
    {
      id: "c2",
      sourceId: "s1",
      inMs: 3000,
      outMs: 6000,
      speed: 2,
      startMs: 0,
      zoom: {
        keys: [
          { tMs: 500, rect: [0, 0, 1, 1] },
          { tMs: 1000, rect: [0.25, 0.25, 0.5, 0.5], ease: "smooth" },
        ],
      },
    },
    { id: "c3", sourceId: "s1", inMs: 7000, outMs: 7000, speed: 1, startMs: 0, holdMs: 1000 },
  ]),
  masks: [mask],
};

const ctx: TimelineKeyContext = {
  clips: doc.clips,
  masks: doc.masks ?? [],
  fps: FPS,
  sourceDurationMs: () => 10000,
  isImage: () => false,
};

const items = clipLaneItems(doc.clips, (clip) => clip.id);
const item = (id: string) => {
  const found = [...items, ...maskLaneItems(doc.clips, ctx.masks, () => false)].find(
    (i) => i.id === id,
  );
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const applied = (op: Parameters<typeof applyEditOp>[1] | null | undefined) => {
  if (!op) throw new Error("no op");
  const result = applyEditOp(doc, op);
  if (!result.ok) throw new Error(result.message);
  return result.doc;
};
/** A playhead nowhere near any edge, so the drags below never snap. */
const FAR = 99999;

describe("clipLaneItems", () => {
  it("lists each clip then its zoom keys, and names them by kind, label and time", () => {
    expect(items.map((i) => i.id)).toEqual([
      "clip:c1",
      "clip:c2",
      "zoom:c2@500",
      "zoom:c2@1000",
      "clip:c3",
    ]);
    expect(timelineItemName(item("clip:c1"), ctx)).toBe("Clip, c1, 0:00.00 to 0:02.00");
    expect(timelineItemName(item("clip:c3"), ctx)).toBe("Freeze, c3, 0:03.50 to 0:04.50");
    expect(timelineItemName(item("zoom:c2@500"), ctx)).toBe("Zoom key, 0:02.50");
    expect(timelineItemName(item("mask:m1"), ctx)).toBe("Mask, blur, 0:01.20 to 0:01.80");
  });
});

describe("keyboard edits commit the op the drag commits", () => {
  it("reorders a clip one place, as a drag past its neighbour does", () => {
    const keyboard = timelineNudge(ctx, item("clip:c1"), { kind: "move", frames: 1 });
    const to = reorderIndex(doc.clips, 0, 900 * PX_PER_MS, PX_PER_MS);
    expect(keyboard?.op).toEqual({ op: "moveClip", from: 0, to });
    expect(keyboard?.message).toBe("Clip moved to 2 of 3");
    expect(applied(keyboard?.op).clips.map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
  });

  it("holds a clip at the ends", () => {
    const first = timelineNudge(ctx, item("clip:c1"), { kind: "move", frames: -1 });
    expect(first).toEqual({ op: null, message: "Clip can't move further" });
    expect(timelineNudge(ctx, item("clip:c3"), { kind: "move", frames: 1 })?.op).toBeNull();
  });

  it("trims a clip's in and out points one frame, or ten with ⇧", () => {
    for (const [edge, frames] of [
      ["start", 1],
      ["start", -LARGE_STEP_FRAMES],
      ["end", -1],
      ["end", LARGE_STEP_FRAMES],
    ] as const) {
      const clip = doc.clips[1];
      const kind = edge === "start" ? "trim-in" : "trim-out";
      const keyboard = timelineNudge(ctx, item("clip:c2"), { kind: "trim", edge, frames });
      // The drag: the edge travels the same pixels, snapping only to a far-off playhead.
      const edgeTl = edge === "start" ? clip.startMs : clip.startMs + (clip.outMs - clip.inMs) / 2;
      const dragged = snapMs(edgeTl + (frames * FRAME * PX_PER_MS) / PX_PER_MS, [FAR], 40);
      const draft = trimDraft(doc.clips, "c2", kind, dragged, 10000);
      expect(keyboard?.op).toEqual(trimOp(kind, "c2", doc.clips, draft));
      // And the op lands the same clips the drag drew.
      expect(applied(keyboard?.op).clips).toEqual(draft);
    }
  });

  it("clamps a trim exactly as the drag clamps", () => {
    const far = timelineNudge(ctx, item("clip:c1"), { kind: "trim", edge: "start", frames: 9999 });
    const draft = trimDraft(doc.clips, "c1", "trim-in", 9999 * FRAME, 10000);
    expect(far?.op).toEqual(trimOp("trim-in", "c1", doc.clips, draft));
    const parked = applied(far?.op);
    const again = timelineNudge({ ...ctx, clips: parked.clips }, item("clip:c1"), {
      kind: "trim",
      edge: "start",
      frames: 1,
    });
    expect(again).toEqual({ op: null, message: "In point can't move further" });
  });

  it("retimes a freeze from its end only", () => {
    const end = timelineNudge(ctx, item("clip:c3"), { kind: "trim", edge: "end", frames: 1 });
    const clip = doc.clips[2];
    const draft = trimDraft(doc.clips, "c3", "hold", clip.startMs + 1000 + FRAME, 10000);
    expect(end?.op).toEqual(trimOp("hold", "c3", doc.clips, draft));
    expect(end?.message).toBe("Freeze length 0:01.02");
    expect(
      timelineNudge(ctx, item("clip:c3"), { kind: "trim", edge: "start", frames: 1 }),
    ).toBeNull();
  });

  it("moves a zoom key one frame as its drag does", () => {
    const keyboard = timelineNudge(ctx, item("zoom:c2@500"), { kind: "move", frames: 1 });
    const toMs = zoomKeyTarget(doc.clips[1], 500, FRAME, [FAR], 40, FPS);
    expect(keyboard?.op).toEqual({ op: "moveZoomKey", clipId: "c2", tMs: 500, toMs });
    expect(toMs).toBe(517);
    expect(applied(keyboard?.op).clips[1].zoom?.keys.map((k) => k.tMs)).toEqual([517, 1000]);
    expect(
      timelineNudge(ctx, item("zoom:c2@500"), { kind: "trim", edge: "end", frames: 1 }),
    ).toBeNull();
  });

  it("retimes a mask's ends as dragging them does", () => {
    for (const edge of ["start", "end"] as const) {
      const keyboard = timelineNudge(ctx, item("mask:m1"), { kind: "trim", edge, frames: 1 });
      const [w] = maskWindows([doc.clips[0]], mask, false);
      const t = (edge === "start" ? w.startMs : w.endMs) + FRAME;
      const draft = maskEdgeDraft(mask, edge, doc.clips[0], t, 10000);
      expect(keyboard?.op).toEqual(maskEdgeOp(mask, draft, edge));
      expect(applied(keyboard?.op).masks?.[0]).toEqual(draft);
    }
    expect(timelineNudge(ctx, item("mask:m1"), { kind: "move", frames: 1 })).toBeNull();
  });
});

describe("undo", () => {
  beforeEach(() => {
    bindEditorHistory(null, null);
    bindEditorHistory("ws:demo", "tour");
  });

  it("takes one step per key press and restores the doc before it", () => {
    const op = timelineNudge(ctx, item("clip:c2"), { kind: "trim", edge: "end", frames: -1 })?.op;
    const after = applied(op);
    pushEditorHistory({ label: "trim out", before: doc, after });
    const entry = takeEditorUndo();
    expect(entry?.before).toEqual(doc);
    expect(takeEditorUndo()).toBeNull();
  });
});
