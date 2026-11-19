import { FPS } from "../engine/format";
import {
  deleteKeyMerged,
  type KeyedTrack,
  type MergedDelete,
  moveKey,
  moveSegment,
  nextKeyId,
  removeSegment,
  type TrackLayout,
} from "../engine/keyedTrack";
import { formatSceneLengthMs } from "./durationText";

/** The animation lane's edits as plain functions, so a drag, the selected-key arrows and the focused-item keys all write through one path and an export can never tell them apart. */

export const FRAME_MS = 1000 / FPS;

/** Round to the export frame grid, then to whole ms (sidecar times stay integers). */
export function snapToFrame(ms: number): number {
  return Math.round(Math.round(ms / FRAME_MS) * FRAME_MS);
}

/** Retime one key, as dropping its diamond at `targetMs` does. */
export function retimeKey<P, T extends KeyedTrack<P>>(
  track: T,
  keyId: string,
  targetMs: number,
  durationMs: number,
  minLenMs: number,
): T | null {
  return moveKey(track, keyId, snapToFrame(targetMs), durationMs, minLenMs);
}

/** Shift one animation, as dragging its bar by `deltaMs` does. */
export function shiftSegment<P, T extends KeyedTrack<P>>(
  track: T,
  fromId: string,
  toId: string,
  deltaMs: number,
  durationMs: number,
  minLenMs: number,
): T | null {
  return moveSegment(track, fromId, toId, snapToFrame(deltaMs), durationMs, minLenMs);
}

/** A diamond drag's track: the pointer's travel, snapped to the nearest beat or playhead in reach (the playhead wins ties), then retimed. */
export function keyDragResult<P, T extends KeyedTrack<P>>(
  orig: T,
  keyId: string,
  dxPx: number,
  pxPerMs: number,
  snapRadiusMs: number,
  snapCandidates: readonly number[],
  durationMs: number,
  minLenMs: number,
): T | null {
  const key = orig.keys.find((k) => k.id === keyId);
  if (!key || pxPerMs <= 0) return null;
  let target = key.tMs + dxPx / pxPerMs;
  let snapped: number | null = null;
  let best = snapRadiusMs;
  for (const candidate of snapCandidates) {
    const d = Math.abs(target - candidate);
    if (d <= best) {
      best = d;
      snapped = candidate;
    }
  }
  if (snapped !== null) target = snapped;
  return retimeKey(orig, keyId, target, durationMs, minLenMs);
}

/** A bar drag's track. */
export function segmentDragResult<P, T extends KeyedTrack<P>>(
  orig: T,
  fromId: string,
  toId: string,
  dxPx: number,
  pxPerMs: number,
  durationMs: number,
  minLenMs: number,
): T | null {
  if (pxPerMs <= 0) return null;
  return shiftSegment(orig, fromId, toId, dxPx / pxPerMs, durationMs, minLenMs);
}

/** What a merged delete writes: the collapsed track, or the static single-key doc freezing the surviving pose, so losing the last animation holds the shot instead of leaving a lone diamond. */
export function withFrozenPose<P, T extends KeyedTrack<P>>(result: MergedDelete<P, T>): T {
  if (result.frozenPose === undefined) return result.track;
  return {
    ...result.track,
    keys: [{ id: nextKeyId(result.track), tMs: 0, pose: result.frozenPose }],
    segments: [],
  };
}

export type TrackLaneItem =
  | { kind: "key"; id: string; keyId: string; tMs: number }
  | {
      kind: "segment";
      id: string;
      docIndex: number;
      fromId: string;
      toId: string;
      fromTMs: number;
      toTMs: number;
      ease: string;
    };

export const keyItemId = (keyId: string) => `key:${keyId}`;
export const segmentItemId = (fromId: string, toId: string) => `seg:${fromId}>${toId}`;

/** The lane's items in time order: each animation sits between its two keys. */
export function trackLaneItems<P>(
  layout: TrackLayout<P>,
  shownKeys: readonly { id: string; tMs: number }[],
): TrackLaneItem[] {
  const items: (TrackLaneItem & { at: number })[] = [
    ...shownKeys.map((k) => ({
      kind: "key" as const,
      id: keyItemId(k.id),
      keyId: k.id,
      tMs: k.tMs,
      at: k.tMs,
    })),
    ...layout.segments.map((s) => ({
      kind: "segment" as const,
      id: segmentItemId(s.fromId, s.toId),
      docIndex: s.docIndex,
      fromId: s.fromId,
      toId: s.toId,
      fromTMs: s.fromTMs,
      toTMs: s.toTMs,
      ease: s.ease,
      at: (s.fromTMs + s.toTMs) / 2,
    })),
  ];
  items.sort((a, b) => a.at - b.at || (a.kind === "key" ? -1 : 1));
  return items.map(({ at: _at, ...item }) => item as TrackLaneItem);
}

/** A focused item's move or trim, one frame per step: a key retimes, an animation shifts, and an animation's start or end retimes the key at that end, exactly as dragging that diamond does. Null when the item has nothing to trim. */
export function trackLaneNudge<P, T extends KeyedTrack<P>>(
  track: T,
  item: TrackLaneItem,
  intent:
    | { kind: "move"; frames: number }
    | { kind: "trim"; edge: "start" | "end"; frames: number },
  durationMs: number,
  minLenMs: number,
): T | null {
  const deltaMs = intent.frames * FRAME_MS;
  if (item.kind === "key") {
    if (intent.kind === "trim") return null;
    const key = track.keys.find((k) => k.id === item.keyId);
    return key ? retimeKey(track, key.id, key.tMs + deltaMs, durationMs, minLenMs) : null;
  }
  if (intent.kind === "move") {
    return shiftSegment(track, item.fromId, item.toId, deltaMs, durationMs, minLenMs);
  }
  const keyId = intent.edge === "start" ? item.fromId : item.toId;
  const key = track.keys.find((k) => k.id === keyId);
  return key ? retimeKey(track, keyId, key.tMs + deltaMs, durationMs, minLenMs) : null;
}

/** Delete a key the connected way: it joins the animations either side, and the last one leaves the pose frozen. */
export function deleteKeySelection<P, T extends KeyedTrack<P>>(track: T, keyId: string): T | null {
  const merged = deleteKeyMerged(track, keyId);
  return merged ? withFrozenPose(merged) : null;
}

/** Delete an item as the Delete key and the menus do: an animation goes alone; a key joins its neighbours. */
export function deleteTrackLaneItem<P, T extends KeyedTrack<P>>(
  track: T,
  item: TrackLaneItem,
): T | null {
  return item.kind === "segment"
    ? removeSegment(track, item.docIndex)
    : deleteKeySelection(track, item.keyId);
}

/** The ease as a reader would say it: "inOutQuad" reads "In out quad". */
export function easeLabel(ease: string): string {
  if (ease === "jump") return "Jump cut";
  const words = ease
    .replace(/([A-Z])/g, " $1")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Kind, label and time, the name a screen reader gives each item. */
export function trackLaneItemName(item: TrackLaneItem, still = false): string {
  if (item.kind === "key") {
    return `Keyframe${still ? ", still" : ""}, ${formatSceneLengthMs(item.tMs)}`;
  }
  return `Animation, ${easeLabel(item.ease)}, ${formatSceneLengthMs(item.fromTMs)} to ${formatSceneLengthMs(item.toTMs)}`;
}

/** The polite announcement after a keyboard move or trim. */
export function trackLaneEditMessage<P>(
  item: TrackLaneItem,
  intent: { kind: "move" } | { kind: "trim"; edge: "start" | "end" },
  next: KeyedTrack<P> | null,
  changed: boolean,
): string {
  const noun = item.kind === "key" ? "Keyframe" : "Animation";
  if (!next || !changed) return `${noun} can't move further`;
  const at = (keyId: string) => next.keys.find((k) => k.id === keyId)?.tMs ?? 0;
  if (item.kind === "key") return `Keyframe moved to ${formatSceneLengthMs(at(item.keyId))}`;
  if (intent.kind === "move") return `Animation moved to ${formatSceneLengthMs(at(item.fromId))}`;
  return intent.edge === "start"
    ? `Animation starts at ${formatSceneLengthMs(at(item.fromId))}`
    : `Animation ends at ${formatSceneLengthMs(at(item.toId))}`;
}
