import type { EditClip, EditDoc, EditMask, EditMaskStyle, EditTap } from "./edit";
import {
  addHoldKey,
  clampRect,
  defaultMaskRange,
  keyToleranceMs,
  type MaskRect,
  nextMaskId,
  offsetMaskKeys,
  pruneOrphanMasks,
  removeMaskKey,
  replaceMask,
  retimeMaskEdge,
  type SourceMoment,
  sourceMomentAt,
  upsertMaskKey,
} from "./editMasks";
import {
  addTap,
  clipIndexAt,
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

/** The editor's document mutations as pure ops: each reproduces an EditorApp handler exactly, so the editor and `kb video` (kblib/video/editops.py mirrors this file, pinned by edit-vectors.json) share one spec. The input is relaid out first and never mutated; a success applies the editor's commit normalisation (orphan masks pruned). Where a handler silently does nothing, the op fails with a code and leaves the doc alone. Timeline times (`atMs`) may be fractional like the playhead; source times are integers. Check order: argument shape (`bad-arg`), then lookups (`unknown-*`), then the handler's own refusals. */

export type SourceMeta = {
  rel: string;
  kind: "video" | "image";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
};

export type EditOp =
  | { op: "addClip"; source: SourceMeta; index?: number }
  | { op: "insertClip"; source: SourceMeta; atMs: number }
  | { op: "split"; atMs: number }
  | { op: "freeze"; atMs: number; holdMs?: number }
  | { op: "removeClip"; clipId: string }
  | { op: "moveClip"; from: number; to: number }
  | { op: "setSpeed"; clipId: string; speed: number }
  | { op: "trimIn"; clipId: string; inMs: number }
  | { op: "trimOut"; clipId: string; outMs: number }
  | { op: "setHold"; clipId: string; holdMs: number }
  | { op: "addTap"; atMs: number; pos: [number, number] }
  | { op: "addTapAtSource"; sourceId: string; sourceMs: number; pos: [number, number] }
  | { op: "moveTap"; tapId: string; pos: [number, number] }
  | { op: "retimeTap"; tapId: string; atMs: number }
  | { op: "removeTap"; tapId: string }
  | { op: "setTapLook"; style?: string; color?: string; size?: number }
  | {
      op: "addMask";
      atMs: number;
      rect: [number, number, number, number];
      style?: EditMaskStyle;
      strength?: number;
      color?: string;
    }
  | { op: "setMaskRect"; maskId: string; atMs: number; rect: [number, number, number, number] }
  | { op: "offsetMask"; maskId: string; dx: number; dy: number }
  | { op: "addMaskKey"; maskId: string; atMs: number }
  | { op: "removeMaskKey"; maskId: string; atMs: number }
  | { op: "retimeMaskEdge"; maskId: string; edge: "start" | "end"; sourceMs: number }
  | {
      op: "setMaskLook";
      maskId: string;
      style?: EditMaskStyle;
      strength?: number | null;
      color?: string | null;
    }
  | { op: "removeMask"; maskId: string };

export type EditOpName = EditOp["op"];

export type EditOpErrorCode =
  | "no-clip"
  | "no-split"
  | "no-freeze"
  | "unknown-clip"
  | "unknown-tap"
  | "unknown-mask"
  | "unknown-source"
  | "source-mismatch"
  | "image-source"
  | "no-change"
  | "bad-arg";

export type EditOpResult =
  | { ok: true; doc: EditDoc; label: string; created?: string }
  | { ok: false; code: EditOpErrorCode; message: string };

export const MASK_STYLES: readonly EditMaskStyle[] = ["solid", "blur", "pixelate"];
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** The output rate every op reads: the doc's, or 60 when unset. */
export function editFps(doc: EditDoc): number {
  return doc.settings.fps > 0 ? doc.settings.fps : 60;
}

const fail = (code: EditOpErrorCode, message: string): EditOpResult => ({
  ok: false,
  code,
  message,
});

/** The editor's commitDoc normalisation: a mask no clip shows any more goes with the edit that orphaned it. */
function done(draft: EditDoc, label: string, created?: string): EditOpResult {
  const masks = draft.masks && pruneOrphanMasks(draft.clips, draft.masks, draft.sources);
  const doc = masks === draft.masks ? draft : { ...draft, masks };
  return created === undefined ? { ok: true, doc, label } : { ok: true, doc, label, created };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const given = (v: unknown) => v !== undefined && v !== null;

function isPos(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => isNum(n) && n >= 0 && n <= 1);
}

function isRect(v: unknown): v is MaskRect {
  return Array.isArray(v) && v.length === 4 && v.every(isNum);
}

function sourceProblem(s: SourceMeta | undefined): string | null {
  if (!s || typeof s !== "object") return "source must be an object";
  if (!isId(s.rel)) return "source.rel must be a project-relative path";
  if (s.kind !== "video" && s.kind !== "image") return 'source.kind must be "video" or "image"';
  for (const key of ["width", "height", "durationMs"] as const) {
    if (!Number.isInteger(s[key]) || s[key] < 0) return `source.${key} must be a whole number`;
  }
  if (!isNum(s.fps) || s.fps < 0) return "source.fps must be a number";
  return null;
}

function lookProblem(style: unknown, strength: unknown, color: unknown): string | null {
  if (given(style) && !MASK_STYLES.includes(style as EditMaskStyle)) {
    return "style must be solid, blur or pixelate";
  }
  if (given(strength) && !(isNum(strength) && strength >= 0 && strength <= 1)) {
    return "strength must be 0 to 1";
  }
  if (given(color) && !(typeof color === "string" && HEX_COLOUR.test(color))) {
    return "color must be #rrggbb";
  }
  return null;
}

/** The handler's frame on screen for mask edits, with the key tolerance at its clip's speed. */
function maskMomentAt(
  doc: EditDoc,
  atMs: number,
): { moment: SourceMoment; tolMs: number; image: boolean } | null {
  const moment = sourceMomentAt(doc.clips, atMs);
  if (!moment) return null;
  const source = doc.sources.find((s) => s.id === moment.sourceId);
  return {
    moment,
    tolMs: keyToleranceMs(editFps(doc), moment.hold ? 1 : moment.clip.speed),
    image: source?.kind === "image",
  };
}

/** spliceClip's source reuse (by rel) and clip build: a video's full span, an image's default hold. The clip takes the probe's kind and length even when its source already exists. */
function spliceSource(doc: EditDoc, meta: SourceMeta): { doc: EditDoc; clip: EditClip } {
  const existing = doc.sources.find((s) => s.rel === meta.rel);
  const sourceId = existing?.id ?? nextSourceId(doc.sources);
  const sources = existing
    ? doc.sources
    : [
        ...doc.sources,
        {
          id: sourceId,
          rel: meta.rel,
          kind: meta.kind,
          width: meta.width,
          height: meta.height,
          fps: meta.fps,
          durationMs: meta.durationMs,
        },
      ];
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
  return { doc: { ...doc, sources }, clip };
}

const atMsProblem = (v: unknown) => (isNum(v) ? null : "atMs must be a finite number");

type Found<T> = { found: T } | { error: EditOpResult };

function findClip(doc: EditDoc, id: unknown): Found<EditClip> {
  if (!isId(id)) return { error: fail("bad-arg", "clipId must be a clip id like c1") };
  const found = doc.clips.find((c) => c.id === id);
  return found ? { found } : { error: fail("unknown-clip", `No clip ${id} in this edit.`) };
}

function findTap(doc: EditDoc, id: unknown): Found<EditTap> {
  if (!isId(id)) return { error: fail("bad-arg", "tapId must be a tap id like t1") };
  const found = (doc.taps ?? []).find((t) => t.id === id);
  return found ? { found } : { error: fail("unknown-tap", `No tap ${id} in this edit.`) };
}

function findMask(doc: EditDoc, id: unknown): Found<EditMask> {
  if (!isId(id)) return { error: fail("bad-arg", "maskId must be a mask id like m1") };
  const found = (doc.masks ?? []).find((m) => m.id === id);
  return found ? { found } : { error: fail("unknown-mask", `No mask ${id} in this edit.`) };
}

const noMoment = (atMs: number) =>
  fail("no-clip", `Nothing plays at ${atMs}ms: move onto a clip of the timeline.`);

const noTapMoment = (atMs: number) =>
  fail(
    "no-clip",
    `No tap moment at ${atMs}ms: it is off the timeline or on a freeze or still, which have no moment to anchor a tap.`,
  );

function mismatch(mask: EditMask, sourceId: string): EditOpResult {
  return fail(
    "source-mismatch",
    `${mask.id} is on ${mask.sourceId} but that frame shows ${sourceId}: pick a frame of ${mask.sourceId}.`,
  );
}

function without(mask: EditMask, key: "strength" | "color"): EditMask {
  const next = { ...mask };
  delete next[key];
  return next;
}

const TAP_LABELS = { style: "change tap style", color: "change tap colour", size: "resize tap" };
const MASK_LABELS = {
  style: "change mask style",
  strength: "change mask strength",
  color: "change mask colour",
};

export function applyEditOp(input: EditDoc, op: EditOp): EditOpResult {
  if (!op || typeof op !== "object") return fail("bad-arg", "An op must be an object.");
  const doc: EditDoc = { ...input, clips: relayout(input.clips) };
  switch (op.op) {
    case "addClip": {
      const bad = sourceProblem(op.source);
      if (bad) return fail("bad-arg", bad);
      if (given(op.index) && !Number.isInteger(op.index)) {
        return fail("bad-arg", "index must be a whole clip position");
      }
      const { doc: withSource, clip } = spliceSource(doc, op.source);
      const clips = [...withSource.clips];
      clips.splice(Math.max(0, Math.min(clips.length, op.index ?? clips.length)), 0, clip);
      return done({ ...withSource, clips: relayout(clips) }, "add clip", clip.id);
    }
    case "insertClip": {
      const bad = sourceProblem(op.source) ?? atMsProblem(op.atMs);
      if (bad) return fail("bad-arg", bad);
      const { doc: withSource, clip } = spliceSource(doc, op.source);
      return done(
        { ...withSource, clips: insertClipAt(withSource.clips, op.atMs, clip) },
        "insert clip",
        clip.id,
      );
    }
    case "split": {
      const bad = atMsProblem(op.atMs);
      if (bad) return fail("bad-arg", bad);
      if (clipIndexAt(doc.clips, op.atMs) < 0) return noMoment(op.atMs);
      const id = nextClipId(doc.clips);
      const clips = splitAt(doc.clips, op.atMs, id);
      if (!clips) {
        return fail(
          "no-split",
          `Can't split at ${op.atMs}ms: it is on a freeze or still, or a half would be under 100ms of source.`,
        );
      }
      return done({ ...doc, clips }, "split clip", id);
    }
    case "freeze": {
      const holdMs = op.holdMs ?? DEFAULT_HOLD_MS;
      const bad =
        atMsProblem(op.atMs) ?? (isNum(holdMs) && holdMs > 0 ? null : "holdMs must be > 0");
      if (bad) return fail("bad-arg", bad);
      if (doc.clips.length === 0) return noMoment(op.atMs);
      const fps = editFps(doc);
      const atEnd = Math.abs(op.atMs - timelineDurationMs(doc.clips)) <= 500 / fps;
      if (!atEnd && clipIndexAt(doc.clips, op.atMs) < 0) return noMoment(op.atMs);
      const id = nextClipId(doc.clips);
      const clips = atEnd
        ? freezeAtEnd(doc.clips, fps, holdMs)
        : freezeAt(doc.clips, op.atMs, holdMs);
      if (!clips) {
        return fail("no-freeze", `Can't freeze at ${op.atMs}ms: that frame is already a hold.`);
      }
      return done({ ...doc, clips }, "freeze frame", id);
    }
    case "removeClip": {
      const clip = findClip(doc, op.clipId);
      if ("error" in clip) return clip.error;
      return done({ ...doc, clips: removeClip(doc.clips, clip.found.id) }, "remove clip");
    }
    case "moveClip": {
      const { from, to } = op;
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return fail("bad-arg", "from and to must be whole clip positions");
      }
      if (from < 0 || from >= doc.clips.length) {
        return fail("bad-arg", `from must be a clip position, 0 to ${doc.clips.length - 1}`);
      }
      return done({ ...doc, clips: moveClip(doc.clips, from, to) }, "reorder clip");
    }
    case "setSpeed": {
      if (!isNum(op.speed) || op.speed <= 0) return fail("bad-arg", "speed must be > 0");
      const clip = findClip(doc, op.clipId);
      if ("error" in clip) return clip.error;
      if (clip.found.holdMs !== undefined) return holdClip(clip.found);
      return done(
        { ...doc, clips: setClipSpeed(doc.clips, clip.found.id, op.speed) },
        "change clip speed",
      );
    }
    case "trimIn": {
      if (!isNum(op.inMs)) return fail("bad-arg", "inMs must be a number");
      const clip = findClip(doc, op.clipId);
      if ("error" in clip) return clip.error;
      if (clip.found.holdMs !== undefined) return holdClip(clip.found);
      return done(
        { ...doc, clips: trimClipIn(doc.clips, clip.found.id, op.inMs) },
        "trim clip start",
      );
    }
    case "trimOut": {
      if (!isNum(op.outMs)) return fail("bad-arg", "outMs must be a number");
      const clip = findClip(doc, op.clipId);
      if ("error" in clip) return clip.error;
      if (clip.found.holdMs !== undefined) return holdClip(clip.found);
      const source = doc.sources.find((s) => s.id === clip.found.sourceId);
      const limit = source?.durationMs ?? clip.found.outMs;
      return done(
        { ...doc, clips: trimClipOut(doc.clips, clip.found.id, op.outMs, limit) },
        "trim clip end",
      );
    }
    case "setHold": {
      if (!isNum(op.holdMs) || op.holdMs <= 0) return fail("bad-arg", "holdMs must be > 0");
      const clip = findClip(doc, op.clipId);
      if ("error" in clip) return clip.error;
      if (clip.found.holdMs === undefined) {
        return fail(
          "bad-arg",
          `${clip.found.id} is not a freeze or still: change its speed or trim it instead.`,
        );
      }
      return done(
        { ...doc, clips: setClipHold(doc.clips, clip.found.id, op.holdMs) },
        "retime freeze",
      );
    }
    case "addTap": {
      const bad = atMsProblem(op.atMs) ?? (isPos(op.pos) ? null : "pos must be [x, y] in 0..1");
      if (bad) return fail("bad-arg", bad);
      const at = outputToSource(doc.clips, op.atMs);
      if (!at) return noTapMoment(op.atMs);
      const taps = doc.taps ?? [];
      const id = nextTapId(taps);
      const tap = { id, sourceId: at.sourceId, sourceMs: at.sourceMs, pos: op.pos };
      return done({ ...doc, taps: addTap(taps, tap) }, "add tap", id);
    }
    case "addTapAtSource": {
      if (!isId(op.sourceId)) return fail("bad-arg", "sourceId must be a source id like s1");
      if (!Number.isInteger(op.sourceMs) || op.sourceMs < 0) {
        return fail("bad-arg", "sourceMs must be a whole number of source ms");
      }
      if (!isPos(op.pos)) return fail("bad-arg", "pos must be [x, y] in 0..1");
      const source = doc.sources.find((s) => s.id === op.sourceId);
      if (!source) return fail("unknown-source", `No source ${op.sourceId} in this edit.`);
      if (source.kind === "image") {
        return fail("image-source", `${source.id} is a still: a tap needs a video moment.`);
      }
      const taps = doc.taps ?? [];
      const id = nextTapId(taps);
      const tap = { id, sourceId: source.id, sourceMs: op.sourceMs, pos: op.pos };
      return done({ ...doc, taps: addTap(taps, tap) }, "add tap", id);
    }
    case "moveTap": {
      if (!isPos(op.pos)) return fail("bad-arg", "pos must be [x, y] in 0..1");
      const tap = findTap(doc, op.tapId);
      if ("error" in tap) return tap.error;
      return done({ ...doc, taps: moveTap(doc.taps ?? [], tap.found.id, op.pos) }, "move tap");
    }
    case "retimeTap": {
      const bad = atMsProblem(op.atMs);
      if (bad) return fail("bad-arg", bad);
      const tap = findTap(doc, op.tapId);
      if ("error" in tap) return tap.error;
      const at = outputToSource(doc.clips, op.atMs);
      if (!at) return noTapMoment(op.atMs);
      return done(
        { ...doc, taps: retimeTap(doc.taps ?? [], tap.found.id, at.sourceId, at.sourceMs) },
        "retime tap",
      );
    }
    case "removeTap": {
      const tap = findTap(doc, op.tapId);
      if ("error" in tap) return tap.error;
      return done({ ...doc, taps: removeTap(doc.taps ?? [], tap.found.id) }, "delete tap");
    }
    case "setTapLook": {
      const fields = (["style", "color", "size"] as const).filter((k) => given(op[k]));
      if (fields.length === 0) return fail("bad-arg", "Give a style, color or size.");
      if (given(op.style) && !isId(op.style)) {
        return fail("bad-arg", "style must be a tap style id");
      }
      if (given(op.color) && !isId(op.color)) {
        return fail("bad-arg", "color must be a tap colour id");
      }
      if (given(op.size) && !(isNum(op.size) && op.size > 0)) {
        return fail("bad-arg", "size must be > 0");
      }
      let next: EditDoc = doc;
      if (given(op.style)) next = { ...next, tapStyle: op.style };
      if (given(op.color)) next = { ...next, tapColor: op.color };
      if (given(op.size)) next = { ...next, tapSize: op.size };
      return done(next, fields.length === 1 ? TAP_LABELS[fields[0]] : "change tap look");
    }
    case "addMask": {
      const bad =
        atMsProblem(op.atMs) ??
        (isRect(op.rect) ? null : "rect must be [x, y, w, h] numbers") ??
        lookProblem(op.style, op.strength, op.color);
      if (bad) return fail("bad-arg", bad);
      const at = maskMomentAt(doc, op.atMs);
      if (!at) return noMoment(op.atMs);
      const source = doc.sources.find((s) => s.id === at.moment.sourceId);
      if (!source) return fail("unknown-source", `No source ${at.moment.sourceId} in this edit.`);
      const masks = doc.masks ?? [];
      const range = at.image ? { startMs: 0, endMs: 0 } : defaultMaskRange(at.moment, source);
      let mask: EditMask = {
        id: nextMaskId(masks),
        sourceId: source.id,
        style: "solid",
        ...range,
        keys: [{ sourceMs: at.image ? 0 : at.moment.sourceMs, rect: clampRect(op.rect) }],
      };
      if (given(op.style)) mask = { ...mask, style: op.style as EditMaskStyle };
      if (given(op.strength)) mask = { ...mask, strength: op.strength as number };
      if (given(op.color)) mask = { ...mask, color: op.color as string };
      return done({ ...doc, masks: [...masks, mask] }, "add mask", mask.id);
    }
    case "setMaskRect": {
      const bad =
        atMsProblem(op.atMs) ?? (isRect(op.rect) ? null : "rect must be [x, y, w, h] numbers");
      if (bad) return fail("bad-arg", bad);
      const mask = findMask(doc, op.maskId);
      if ("error" in mask) return mask.error;
      const at = maskMomentAt(doc, op.atMs);
      if (!at) return noMoment(op.atMs);
      if (at.moment.sourceId !== mask.found.sourceId) {
        return mismatch(mask.found, at.moment.sourceId);
      }
      const next = upsertMaskKey(mask.found, at.moment.sourceMs, op.rect, at.tolMs, at.image);
      return done({ ...doc, masks: replaceMask(doc.masks ?? [], next) }, "move mask");
    }
    case "offsetMask": {
      if (!isNum(op.dx) || !isNum(op.dy)) return fail("bad-arg", "dx and dy must be numbers");
      const mask = findMask(doc, op.maskId);
      if ("error" in mask) return mask.error;
      const next = offsetMaskKeys(mask.found, op.dx, op.dy);
      return done({ ...doc, masks: replaceMask(doc.masks ?? [], next) }, "move mask path");
    }
    case "addMaskKey":
    case "removeMaskKey": {
      const bad = atMsProblem(op.atMs);
      if (bad) return fail("bad-arg", bad);
      const mask = findMask(doc, op.maskId);
      if ("error" in mask) return mask.error;
      const at = maskMomentAt(doc, op.atMs);
      if (!at) return noMoment(op.atMs);
      const adding = op.op === "addMaskKey";
      if (adding && at.image) {
        return fail("image-source", "A mask on a still is one static box: it has no keys to add.");
      }
      if (at.moment.sourceId !== mask.found.sourceId) {
        return mismatch(mask.found, at.moment.sourceId);
      }
      const next = adding
        ? addHoldKey(mask.found, at.moment.sourceMs, at.tolMs)
        : removeMaskKey(mask.found, at.moment.sourceMs, at.tolMs);
      if (next === mask.found) {
        return fail(
          "no-change",
          adding
            ? `${mask.found.id} already has a key at ${op.atMs}ms.`
            : `${mask.found.id} has no key at ${op.atMs}ms to delete, or only one key left.`,
        );
      }
      return done(
        { ...doc, masks: replaceMask(doc.masks ?? [], next) },
        adding ? "add mask key" : "delete mask key",
      );
    }
    case "retimeMaskEdge": {
      if (op.edge !== "start" && op.edge !== "end") {
        return fail("bad-arg", 'edge must be "start" or "end"');
      }
      if (!isNum(op.sourceMs)) return fail("bad-arg", "sourceMs must be a number");
      const mask = findMask(doc, op.maskId);
      if ("error" in mask) return mask.error;
      const source = doc.sources.find((s) => s.id === mask.found.sourceId);
      if (source?.kind === "image") {
        return fail("image-source", "A mask on a still covers every frame: it has no span.");
      }
      const next = retimeMaskEdge(mask.found, op.edge, op.sourceMs, source?.durationMs ?? 0);
      return done({ ...doc, masks: replaceMask(doc.masks ?? [], next) }, "retime mask");
    }
    case "setMaskLook": {
      const fields = (["style", "strength", "color"] as const).filter((k) =>
        k === "style" ? given(op.style) : op[k] !== undefined,
      );
      if (fields.length === 0) return fail("bad-arg", "Give a style, strength or color.");
      const bad = lookProblem(op.style, op.strength, op.color);
      if (bad) return fail("bad-arg", bad);
      const mask = findMask(doc, op.maskId);
      if ("error" in mask) return mask.error;
      if (fields.length === 1 && fields[0] === "style" && op.style === mask.found.style) {
        return fail("no-change", `${mask.found.id} is already ${mask.found.style}.`);
      }
      let next: EditMask = mask.found;
      if (given(op.style)) next = { ...next, style: op.style as EditMaskStyle };
      if (op.strength === null) next = without(next, "strength");
      else if (op.strength !== undefined) next = { ...next, strength: op.strength };
      if (op.color === null) next = without(next, "color");
      else if (op.color !== undefined) next = { ...next, color: op.color };
      return done(
        { ...doc, masks: replaceMask(doc.masks ?? [], next) },
        fields.length === 1 ? MASK_LABELS[fields[0]] : "change mask look",
      );
    }
    case "removeMask": {
      const mask = findMask(doc, op.maskId);
      if ("error" in mask) return mask.error;
      return done(
        { ...doc, masks: (doc.masks ?? []).filter((m) => m.id !== mask.found.id) },
        "delete mask",
      );
    }
    default:
      return fail("bad-arg", `Unknown op ${String((op as { op?: unknown }).op)}.`);
  }
}

function holdClip(clip: EditClip): EditOpResult {
  return fail("bad-arg", `${clip.id} is a freeze or still: set its hold instead.`);
}
