import type { EditClip, EditMask } from "../engine/edit";
import { maskWindows, retimeMaskEdge, timelineToSourceUnclamped } from "../engine/editMasks";
import {
  clipTimelineMs,
  setClipHold,
  snapMs,
  snapZoomMs,
  trimClipIn,
  trimClipOut,
} from "../engine/editMath";
import type { EditOp } from "../engine/editOps";
import { formatSceneLengthMs } from "../ui/durationText";

/** The video editor timeline's edits as plain functions: a drag and a focused item's keys build the same draft and emit the same op, so the edit document cannot tell them apart. */

export type TrimKind = "trim-in" | "trim-out" | "hold";

function effectiveSpeed(speed: number): number {
  return speed > 0 ? speed : 1;
}

/** The clips with one edge of `id` moved to timeline `edgeTl`, as the trim and hold handles draw them. */
export function trimDraft(
  orig: EditClip[],
  id: string,
  kind: TrimKind,
  edgeTl: number,
  sourceDurationMs: number | undefined,
): EditClip[] {
  const clip = orig.find((c) => c.id === id);
  if (!clip) return orig;
  const speed = effectiveSpeed(clip.speed);
  const startTl = clip.startMs;
  const endTl = startTl + clipTimelineMs(clip);
  if (kind === "hold") return setClipHold(orig, id, edgeTl - startTl);
  if (kind === "trim-in") return trimClipIn(orig, id, clip.outMs - (endTl - edgeTl) * speed);
  return trimClipOut(
    orig,
    id,
    clip.inMs + (edgeTl - startTl) * speed,
    sourceDurationMs ?? clip.outMs,
  );
}

/** The op a finished trim commits; null when nothing moved. */
export function trimOp(
  kind: TrimKind,
  id: string,
  orig: EditClip[],
  draft: EditClip[],
): EditOp | null {
  const a = orig.find((c) => c.id === id);
  const b = draft.find((c) => c.id === id);
  if (!a || !b || (a.inMs === b.inMs && a.outMs === b.outMs && a.holdMs === b.holdMs)) return null;
  if (kind === "hold") return { op: "setHold", clipId: id, holdMs: b.holdMs ?? 0 };
  if (kind === "trim-in") return { op: "trimIn", clipId: id, inMs: b.inMs };
  return { op: "trimOut", clipId: id, outMs: b.outMs };
}

/** Where a reorder drag lands the clip: the slot its centre has passed. */
export function reorderIndex(
  orig: EditClip[],
  fromIndex: number,
  dxPx: number,
  pxPerMs: number,
): number {
  const dragged = orig[fromIndex];
  if (!dragged) return fromIndex;
  const centrePx = dragged.startMs * pxPerMs + dxPx + (clipTimelineMs(dragged) * pxPerMs) / 2;
  let cum = 0;
  let toIndex = 0;
  for (const c of orig) {
    if (c.id === dragged.id) continue;
    const w = clipTimelineMs(c) * pxPerMs;
    if (centrePx > cum + w / 2) toIndex++;
    cum += w;
  }
  return toIndex;
}

/** A zoom key's clip-local time after travelling `dxMs`: held in the clip, snapped to `snapTargets`, then onto the output frame grid. */
export function zoomKeyTarget(
  clip: EditClip,
  tMs: number,
  dxMs: number,
  snapTargets: number[],
  thresholdMs: number,
  fps: number,
): number {
  const raw = Math.min(clipTimelineMs(clip), Math.max(0, tMs + dxMs));
  return snapZoomMs(snapMs(raw, snapTargets, thresholdMs), fps);
}

/** A mask with one end dropped at timeline `tMs` inside `clip`. */
export function maskEdgeDraft(
  mask: EditMask,
  edge: "start" | "end",
  clip: EditClip,
  tMs: number,
  sourceDurationMs: number,
): EditMask {
  return retimeMaskEdge(mask, edge, timelineToSourceUnclamped(clip, tMs), sourceDurationMs);
}

/** The op a finished mask-edge drag commits; null when the span did not change. */
export function maskEdgeOp(orig: EditMask, draft: EditMask, edge: "start" | "end"): EditOp | null {
  if (draft.startMs === orig.startMs && draft.endMs === orig.endMs) return null;
  return {
    op: "retimeMaskEdge",
    maskId: orig.id,
    edge,
    sourceMs: edge === "start" ? draft.startMs : draft.endMs,
  };
}

export type TimelineItem =
  | { kind: "clip"; id: string; clipId: string; index: number; name: string; frozen: boolean }
  | { kind: "zoomKey"; id: string; clipId: string; tMs: number }
  | { kind: "mask"; id: string; maskId: string; style: string };

export const clipItemId = (clipId: string) => `clip:${clipId}`;
export const zoomItemId = (clipId: string, tMs: number) => `zoom:${clipId}@${tMs}`;
export const maskItemId = (maskId: string) => `mask:${maskId}`;

/** The track's items in time order: each clip, then the zoom keys on it. */
export function clipLaneItems(
  clips: EditClip[],
  nameOf: (clip: EditClip) => string,
): TimelineItem[] {
  return clips.flatMap((clip, index) => [
    {
      kind: "clip" as const,
      id: clipItemId(clip.id),
      clipId: clip.id,
      index,
      name: nameOf(clip),
      frozen: clip.holdMs !== undefined,
    },
    ...(clip.zoom?.keys ?? [])
      .filter((k) => k.tMs >= 0 && k.tMs <= clipTimelineMs(clip))
      .sort((a, b) => a.tMs - b.tMs)
      .map((k) => ({
        kind: "zoomKey" as const,
        id: zoomItemId(clip.id, k.tMs),
        clipId: clip.id,
        tMs: k.tMs,
      })),
  ]);
}

/** One item per mask a clip shows, in order of where each first appears. */
export function maskLaneItems(
  clips: EditClip[],
  masks: EditMask[],
  isImage: (sourceId: string) => boolean,
): TimelineItem[] {
  return masks
    .map((mask) => ({ mask, at: maskWindows(clips, mask, isImage(mask.sourceId))[0]?.startMs }))
    .filter((m): m is { mask: EditMask; at: number } => m.at !== undefined)
    .sort((a, b) => a.at - b.at)
    .map(({ mask }) => ({
      kind: "mask" as const,
      id: maskItemId(mask.id),
      maskId: mask.id,
      style: mask.style,
    }));
}

export interface TimelineKeyContext {
  clips: EditClip[];
  masks: EditMask[];
  fps: number;
  sourceDurationMs: (sourceId: string) => number | undefined;
  isImage: (sourceId: string) => boolean;
}

/** A focused item's move or trim, one output frame per step (a clip moves one place): the op its drag would commit, and what to announce. Null when the key means nothing for this item. */
export function timelineNudge(
  ctx: TimelineKeyContext,
  item: TimelineItem,
  intent:
    | { kind: "move"; frames: number }
    | { kind: "trim"; edge: "start" | "end"; frames: number },
): { op: EditOp | null; message: string } | null {
  const frameMs = 1000 / (ctx.fps > 0 ? ctx.fps : 60);
  const dxMs = intent.frames * frameMs;
  if (item.kind === "clip") {
    const clip = ctx.clips[item.index];
    if (!clip) return null;
    if (intent.kind === "move") {
      const to = item.index + Math.sign(intent.frames);
      if (to < 0 || to >= ctx.clips.length) return { op: null, message: "Clip can't move further" };
      return {
        op: { op: "moveClip", from: item.index, to },
        message: `Clip moved to ${to + 1} of ${ctx.clips.length}`,
      };
    }
    const frozen = clip.holdMs !== undefined;
    if (frozen && intent.edge === "start") return null;
    const kind: TrimKind = frozen ? "hold" : intent.edge === "start" ? "trim-in" : "trim-out";
    const startTl = clip.startMs;
    const endTl = startTl + clipTimelineMs(clip);
    const edgeTl = (intent.edge === "start" ? startTl : endTl) + dxMs;
    const draft = trimDraft(ctx.clips, clip.id, kind, edgeTl, ctx.sourceDurationMs(clip.sourceId));
    const op = trimOp(kind, clip.id, ctx.clips, draft);
    const after = draft.find((c) => c.id === clip.id) ?? clip;
    const label = kind === "hold" ? "Freeze length" : kind === "trim-in" ? "In point" : "Out point";
    if (!op) return { op: null, message: `${label} can't move further` };
    const value =
      kind === "hold" ? (after.holdMs ?? 0) : kind === "trim-in" ? after.inMs : after.outMs;
    return { op, message: `${label} ${formatSceneLengthMs(value)}` };
  }
  if (item.kind === "zoomKey") {
    if (intent.kind === "trim") return null;
    const clip = ctx.clips.find((c) => c.id === item.clipId);
    if (!clip) return null;
    const toMs = zoomKeyTarget(clip, item.tMs, dxMs, [], 0, ctx.fps);
    if (toMs === item.tMs) return { op: null, message: "Zoom key can't move further" };
    return {
      op: { op: "moveZoomKey", clipId: clip.id, tMs: item.tMs, toMs },
      message: `Zoom key moved to ${formatSceneLengthMs(clip.startMs + toMs)}`,
    };
  }
  if (intent.kind === "move") return null;
  const mask = ctx.masks.find((m) => m.id === item.maskId);
  if (!mask) return null;
  const image = ctx.isImage(mask.sourceId);
  const edgeKey = intent.edge === "start" ? "startEdge" : "endEdge";
  for (const clip of ctx.clips) {
    const [w] = maskWindows([clip], mask, image);
    if (!w?.[edgeKey]) continue;
    const t = (intent.edge === "start" ? w.startMs : w.endMs) + dxMs;
    const draft = maskEdgeDraft(
      mask,
      intent.edge,
      clip,
      t,
      ctx.sourceDurationMs(mask.sourceId) ?? 0,
    );
    const op = maskEdgeOp(mask, draft, intent.edge);
    const label = intent.edge === "start" ? "Mask starts" : "Mask ends";
    if (!op) return { op: null, message: `${label} can't move further` };
    const [moved] = maskWindows([clip], draft, image);
    const at = moved ? (intent.edge === "start" ? moved.startMs : moved.endMs) : t;
    return { op, message: `${label} at ${formatSceneLengthMs(at)}` };
  }
  return null;
}

/** Kind, label and time for each item. */
export function timelineItemName(item: TimelineItem, ctx: TimelineKeyContext): string {
  const span = (start: number, end: number) =>
    `${formatSceneLengthMs(start)} to ${formatSceneLengthMs(end)}`;
  if (item.kind === "clip") {
    const clip = ctx.clips[item.index];
    const start = clip?.startMs ?? 0;
    return `${item.frozen ? "Freeze" : "Clip"}, ${item.name}, ${span(start, clip ? start + clipTimelineMs(clip) : start)}`;
  }
  if (item.kind === "zoomKey") {
    const clip = ctx.clips.find((c) => c.id === item.clipId);
    return `Zoom key, ${formatSceneLengthMs((clip?.startMs ?? 0) + item.tMs)}`;
  }
  const mask = ctx.masks.find((m) => m.id === item.maskId);
  const windows = mask ? maskWindows(ctx.clips, mask, ctx.isImage(mask.sourceId)) : [];
  const first = windows[0];
  const last = windows[windows.length - 1];
  return first && last
    ? `Mask, ${item.style}, ${span(first.startMs, last.endMs)}`
    : `Mask, ${item.style}`;
}
