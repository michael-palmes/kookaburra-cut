/** Generic keyed-track edit maths shared by the per-scene camera track and the layered-screenshot animation track: keys `{id, tMs, pose}` joined by eased segments, mutated under the GAP-PRESERVING / HARD-WALLS model (nothing reflows, drags clamp against neighbouring keys and the scene edges; overhanging keys stay legal but never extend). Pose contents are opaque here; sampling semantics live with each track's own sampler, and every mutation returns a NEW object carrying any extra fields through (`presentLoop` etc). Extracted verbatim from sceneCameraEdit.ts, which re-exports the camera specialisation. */

import { DEFAULT_EASE } from "./ease";

export interface KeyedTrackKey<P> {
  id: string;
  /** Scene-local time, ms. */
  tMs: number;
  pose: P;
}

export interface KeyedTrackSegment {
  from: string;
  to: string;
  ease: string;
}

export interface KeyedTrack<P> {
  keys: KeyedTrackKey<P>[];
  segments: KeyedTrackSegment[];
}

/** The minimum span between neighbouring keys (and of a segment): one 60fps frame. */
export const MIN_KEY_GAP_MS = 17;

/** Resolved display/edit layout: keys sorted, segments with resolved times (bad ones dropped). */
export interface TrackLayout<P> {
  keys: KeyedTrackKey<P>[];
  segments: {
    /** Index into the DOC's segments array (stable across sorting for commits). */
    docIndex: number;
    fromId: string;
    toId: string;
    fromTMs: number;
    toTMs: number;
    ease: string;
  }[];
}

export function trackLayout<P>(track: KeyedTrack<P>): TrackLayout<P> {
  const keys = [...track.keys].sort((a, b) => a.tMs - b.tMs);
  const byId = new Map(track.keys.map((k) => [k.id, k]));
  const segments = track.segments
    .map((seg, docIndex) => {
      const from = byId.get(seg.from);
      const to = byId.get(seg.to);
      if (!from || !to || from.tMs >= to.tMs) return null;
      return {
        docIndex,
        fromId: seg.from,
        toId: seg.to,
        fromTMs: from.tMs,
        toTMs: to.tMs,
        ease: seg.ease,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => a.fromTMs - b.fromTMs);
  return { keys, segments };
}

/** Next free "k<n>" key id (scaffolds and Claude both seed k1, k2, …). */
export function nextKeyId<P>(track: KeyedTrack<P>): string {
  let max = 0;
  for (const key of track.keys) {
    const m = /^k(\d+)$/.exec(key.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const taken = new Set(track.keys.map((k) => k.id));
  let n = max + 1;
  while (taken.has(`k${n}`)) n++;
  return `k${n}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Hard walls for one key: its neighbours (over ALL keys) ± the minimum gap, and the scene edges, except an already-overhanging key may keep (but not extend) its overhang. */
function keyWalls<P>(
  track: KeyedTrack<P>,
  keyId: string,
  durationMs: number,
): { lo: number; hi: number } {
  const me = track.keys.find((k) => k.id === keyId);
  let lo = 0;
  let hi = Math.max(durationMs, me ? me.tMs : 0);
  for (const key of track.keys) {
    if (key.id === keyId || !me) continue;
    if (key.tMs <= me.tMs) lo = Math.max(lo, key.tMs + MIN_KEY_GAP_MS);
    else hi = Math.min(hi, key.tMs - MIN_KEY_GAP_MS);
  }
  return { lo, hi };
}

/** Move one key to `tMs`, clamped to its walls. Null when the key is unknown. */
export function moveKey<P, T extends KeyedTrack<P>>(
  track: T,
  keyId: string,
  tMs: number,
  durationMs: number,
): T | null {
  const me = track.keys.find((k) => k.id === keyId);
  if (!me) return null;
  const { lo, hi } = keyWalls(track, keyId, durationMs);
  if (lo > hi) return track; // fully walled in, no free space, no move
  const next = Math.round(clamp(tMs, lo, hi));
  if (next === me.tMs) return track;
  return {
    ...track,
    keys: track.keys.map((k) => (k.id === keyId ? { ...k, tMs: next } : k)),
  };
}

/** Move a segment rigidly by `deltaMs`: both keys shift together, clamped so NEITHER key crosses a wall (outside keys, 0, scene end). A boundary key shared with an adjacent segment moves too (shared keys are the data model); its wall is the neighbour's OTHER key. */
export function moveSegment<P, T extends KeyedTrack<P>>(
  track: T,
  fromId: string,
  toId: string,
  deltaMs: number,
  durationMs: number,
): T | null {
  const from = track.keys.find((k) => k.id === fromId);
  const to = track.keys.find((k) => k.id === toId);
  if (!from || !to || fromId === toId) return null;
  let lo = 0 - from.tMs;
  let hi = Math.max(durationMs, to.tMs) - to.tMs;
  for (const key of track.keys) {
    if (key.id === fromId || key.id === toId) continue;
    // Keys inside the span can't exist (segments don't overlap and walls hold); outside keys bound the rigid move from each side.
    if (key.tMs <= from.tMs) lo = Math.max(lo, key.tMs + MIN_KEY_GAP_MS - from.tMs);
    if (key.tMs >= to.tMs) hi = Math.min(hi, key.tMs - MIN_KEY_GAP_MS - to.tMs);
  }
  if (lo > hi) return track;
  const delta = Math.round(clamp(deltaMs, lo, hi));
  if (delta === 0) return track;
  return {
    ...track,
    keys: track.keys.map((k) =>
      k.id === fromId || k.id === toId ? { ...k, tMs: k.tMs + delta } : k,
    ),
  };
}

/** Insert an animation at the playhead: a segment from `tMs` to `tMs + spanMs`, truncated by the next key/segment and the scene end. Both poses are supplied by the caller (each sampled at its own time from the CURRENT track, so adding must never visibly move the pose). Reuses an existing key sitting exactly at `tMs` (within half the minimum gap) as the shared `from`; refuses (null) when the playhead is inside an existing segment or there's no room for a minimum-length segment. */
export function addSegmentAt<P, T extends KeyedTrack<P>>(
  track: T,
  tMs: number,
  poseFrom: P,
  poseTo: P,
  durationMs: number,
  spanMs = 1000,
): T | null {
  const layout = trackLayout(track);
  const start = Math.round(clamp(tMs, 0, Math.max(0, durationMs - MIN_KEY_GAP_MS)));
  for (const seg of layout.segments) {
    if (start > seg.fromTMs - MIN_KEY_GAP_MS && start < seg.toTMs + MIN_KEY_GAP_MS) {
      // Inside (or touching) an existing animation, except exactly at its end key, which chains a new animation off the shared boundary.
      const endKey = track.keys.find((k) => k.id === seg.toId);
      if (!endKey || Math.abs(start - endKey.tMs) > MIN_KEY_GAP_MS / 2) return null;
    }
  }
  const shared = track.keys.find((k) => Math.abs(k.tMs - start) <= MIN_KEY_GAP_MS / 2);
  const from = shared ?? { id: nextKeyId(track), tMs: start, pose: poseFrom };
  // Truncate against whatever comes next (any key wall) and the scene end.
  let end = Math.min(start + spanMs, durationMs);
  for (const key of track.keys) {
    if (key.id !== from.id && key.tMs > start) {
      end = Math.min(end, key.tMs - MIN_KEY_GAP_MS);
    }
  }
  if (end - from.tMs < MIN_KEY_GAP_MS) return null;
  const withFrom = shared ? track.keys : [...track.keys, from];
  const to = {
    id: nextKeyId({ ...track, keys: withFrom }),
    tMs: Math.round(end),
    pose: poseTo,
  };
  return {
    ...track,
    keys: [...withFrom, to],
    segments: [...track.segments, { from: from.id, to: to.id, ease: DEFAULT_EASE }],
  };
}

/** Remove a segment (by doc index); its keys go too unless another segment references them. */
export function removeSegment<P, T extends KeyedTrack<P>>(track: T, docIndex: number): T | null {
  const seg = track.segments[docIndex];
  if (!seg) return null;
  const segments = track.segments.filter((_, i) => i !== docIndex);
  const referenced = new Set(segments.flatMap((s) => [s.from, s.to]));
  return {
    ...track,
    keys: track.keys.filter((k) => (k.id !== seg.from && k.id !== seg.to) || referenced.has(k.id)),
    segments,
  };
}

/** Remove a key and every segment referencing it. */
export function removeKey<P, T extends KeyedTrack<P>>(track: T, keyId: string): T | null {
  if (!track.keys.some((k) => k.id === keyId)) return null;
  return {
    ...track,
    keys: track.keys.filter((k) => k.id !== keyId),
    segments: track.segments.filter((s) => s.from !== keyId && s.to !== keyId),
  };
}

export function setSegmentEase<P, T extends KeyedTrack<P>>(
  track: T,
  docIndex: number,
  ease: string,
): T | null {
  if (!track.segments[docIndex]) return null;
  return {
    ...track,
    segments: track.segments.map((s, i) => (i === docIndex ? { ...s, ease } : s)),
  };
}

export function setKeyPose<P, T extends KeyedTrack<P>>(track: T, keyId: string, pose: P): T | null {
  if (!track.keys.some((k) => k.id === keyId)) return null;
  return {
    ...track,
    keys: track.keys.map((k) => (k.id === keyId ? { ...k, pose } : k)),
  };
}

/** Snap a segment's start onto the previous animation's end key; the two merge into one shared key (the chained-motion model) carrying the previous end pose. Null when there's no previous segment, they already chain, or a stray key sits in the swallowed gap. */
export function syncSegmentStartToPrevious<P, T extends KeyedTrack<P>>(
  track: T,
  docIndex: number,
): T | null {
  if (!track.segments[docIndex]) return null;
  const layout = trackLayout(track);
  const me = layout.segments.find((s) => s.docIndex === docIndex);
  if (!me) return null;
  let prev: TrackLayout<P>["segments"][number] | null = null;
  for (const seg of layout.segments) {
    if (seg.docIndex === docIndex || seg.toTMs > me.fromTMs) continue;
    if (!prev || seg.toTMs > prev.toTMs) prev = seg;
  }
  if (!prev || prev.toId === me.fromId) return null;
  const stray = track.keys.some(
    (k) => k.id !== me.fromId && k.id !== prev.toId && k.tMs > prev.toTMs && k.tMs < me.fromTMs,
  );
  if (stray) return null;
  const oldFromId = me.fromId;
  const segments = track.segments.map((s, i) => (i === docIndex ? { ...s, from: prev.toId } : s));
  const referenced = new Set(segments.flatMap((s) => [s.from, s.to]));
  return {
    ...track,
    keys: track.keys.filter((k) => k.id !== oldFromId || referenced.has(k.id)),
    segments,
  };
}

/** The 25%-from-the-nearer-end correction for `tMs` inside the middle half of its containing segment, else null; edits read best near an end, never exactly on it. */
export function playheadDriftTarget<P>(track: KeyedTrack<P>, tMs: number): number | null {
  for (const seg of trackLayout(track).segments) {
    if (tMs <= seg.fromTMs || tMs >= seg.toTMs) continue;
    const quarter = (seg.toTMs - seg.fromTMs) * 0.25;
    const lo = seg.fromTMs + quarter;
    const hi = seg.toTMs - quarter;
    if (tMs < lo || tMs > hi) return null;
    return Math.round(tMs - lo < hi - tMs ? lo : hi);
  }
  return null;
}

/** The key nearest to `tMs` (the move tools' default target), or null on an empty track. */
export function nearestKey<P>(track: KeyedTrack<P>, tMs: number): KeyedTrackKey<P> | null {
  let best: KeyedTrackKey<P> | null = null;
  for (const key of track.keys) {
    if (!best || Math.abs(key.tMs - tMs) < Math.abs(best.tMs - tMs)) best = key;
  }
  return best;
}
