/** Generic keyed-track edit maths shared by the per-scene camera track and the layered-screenshot animation track: keys `{id, tMs, pose}` joined by eased segments, mutated under the GAP-PRESERVING / HARD-WALLS model (nothing reflows, drags clamp against neighbouring keys and the scene edges; overhanging keys stay legal but never extend). Pose contents are opaque here; sampling semantics live with each track's own sampler, and every mutation returns a NEW object carrying any extra fields through (`presentLoop` etc). Extracted verbatim from sceneCameraEdit.ts, which re-exports the camera specialisation. The connected ops (addAnimationAuto, duplicateKey(Before), deleteKeyMerged, resizeSegment, mergeGap) build on that model: every edit they make joins keys into shared junctions, gaps survive only in legacy data, and the visual minimum length always arrives from the caller as `minLenMs` (the engine hard-codes nothing but `MIN_KEY_GAP_MS`). */

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

/** One resolved segment: doc index kept so a sorted view still commits to the right slot. */
export interface TrackLayoutSegment {
  /** Index into the DOC's segments array (stable across sorting for commits). */
  docIndex: number;
  fromId: string;
  toId: string;
  fromTMs: number;
  toTMs: number;
  ease: string;
}

/** Resolved display/edit layout: keys sorted, segments with resolved times (bad ones dropped). */
export interface TrackLayout<P> {
  keys: KeyedTrackKey<P>[];
  segments: TrackLayoutSegment[];
}

/** Scene timing the window-aware ops read instead of reaching into the slots: the lane's attribution window, the end of the incoming transition and the start of the outgoing one (`windowEndMs` when the scene has no outgoing transition). */
export interface TrackContext {
  durationMs: number;
  windowStartMs: number;
  windowEndMs: number;
  transitionInMs: number;
  transitionOutStartMs: number;
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

/** The caller's visual minimum length in whole ms, never under the data floor. */
const minLen = (minLenMs: number) => Math.max(MIN_KEY_GAP_MS, Math.round(minLenMs));

/** The default length a new animation aims for: a quarter of the animatable window. */
const aimSpanMs = (ctx: TrackContext) => Math.max(0, ctx.windowEndMs - ctx.windowStartMs) * 0.25;

/** The segments a key joins: `prevSeg` ends on it, `nextSeg` starts from it. Both present means a junction, the shape every new edit creates. */
export interface JunctionInfo {
  prevSeg: TrackLayoutSegment | null;
  nextSeg: TrackLayoutSegment | null;
}

export function junctionInfo<P>(track: KeyedTrack<P>, keyId: string): JunctionInfo {
  const { segments } = trackLayout(track);
  return {
    prevSeg: segments.find((s) => s.toId === keyId) ?? null,
    nextSeg: segments.find((s) => s.fromId === keyId) ?? null,
  };
}

/** The keys sharing a segment with any of `ids` (their chain partners), which hold `minLenMs` rather than the plain data floor. */
function chainPartners<P>(track: KeyedTrack<P>, ids: readonly string[]): Set<string> {
  const partners = new Set<string>();
  for (const seg of track.segments) {
    if (ids.includes(seg.from)) partners.add(seg.to);
    if (ids.includes(seg.to)) partners.add(seg.from);
  }
  for (const id of ids) partners.delete(id);
  return partners;
}

/** The nearest key wall after `tMs` (a later key minus the data floor), or +Infinity when nothing follows. */
function wallAfter<P>(track: KeyedTrack<P>, tMs: number): number {
  let wall = Number.POSITIVE_INFINITY;
  for (const key of track.keys) {
    if (key.tMs > tMs) wall = Math.min(wall, key.tMs - MIN_KEY_GAP_MS);
  }
  return wall;
}

/** The nearest key wall before `tMs`, or -Infinity when nothing precedes. */
function wallBefore<P>(track: KeyedTrack<P>, tMs: number): number {
  let wall = Number.NEGATIVE_INFINITY;
  for (const key of track.keys) {
    if (key.tMs < tMs) wall = Math.max(wall, key.tMs + MIN_KEY_GAP_MS);
  }
  return wall;
}

/** Hard walls for one key: its neighbours (over ALL keys) ± the minimum gap, and the scene edges, except an already-overhanging key may keep (but not extend) its overhang. A neighbour CHAINED to the key holds `minLenMs` instead, so a junction drag can never squash its animation under the lane's visible floor; unchained (legacy gap) neighbours keep the plain data floor. */
export function keyWalls<P>(
  track: KeyedTrack<P>,
  keyId: string,
  durationMs: number,
  minLenMs = MIN_KEY_GAP_MS,
): { lo: number; hi: number } {
  const me = track.keys.find((k) => k.id === keyId);
  const min = minLen(minLenMs);
  const chained = chainPartners(track, [keyId]);
  let lo = 0;
  let hi = Math.max(durationMs, me ? me.tMs : 0);
  for (const key of track.keys) {
    if (key.id === keyId || !me) continue;
    const gap = chained.has(key.id) ? min : MIN_KEY_GAP_MS;
    if (key.tMs <= me.tMs) lo = Math.max(lo, key.tMs + gap);
    else hi = Math.min(hi, key.tMs - gap);
  }
  return { lo, hi };
}

/** Move one key to `tMs`, clamped to its walls. Null when the key is unknown. */
export function moveKey<P, T extends KeyedTrack<P>>(
  track: T,
  keyId: string,
  tMs: number,
  durationMs: number,
  minLenMs = MIN_KEY_GAP_MS,
): T | null {
  const me = track.keys.find((k) => k.id === keyId);
  if (!me) return null;
  const { lo, hi } = keyWalls(track, keyId, durationMs, minLenMs);
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
  minLenMs = MIN_KEY_GAP_MS,
): T | null {
  const from = track.keys.find((k) => k.id === fromId);
  const to = track.keys.find((k) => k.id === toId);
  if (!from || !to || fromId === toId) return null;
  const min = minLen(minLenMs);
  const chained = chainPartners(track, [fromId, toId]);
  let lo = 0 - from.tMs;
  let hi = Math.max(durationMs, to.tMs) - to.tMs;
  for (const key of track.keys) {
    if (key.id === fromId || key.id === toId) continue;
    const gap = chained.has(key.id) ? min : MIN_KEY_GAP_MS;
    // Keys inside the span can't exist (segments don't overlap and walls hold); outside keys bound the rigid move from each side.
    if (key.tMs <= from.tMs) lo = Math.max(lo, key.tMs + gap - from.tMs);
    if (key.tMs >= to.tMs) hi = Math.min(hi, key.tMs - gap - to.tMs);
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

/** The key the chain ends on (the latest segment's `to`), null when nothing resolves. */
function chainTail<P>(track: KeyedTrack<P>): KeyedTrackKey<P> | null {
  let last: TrackLayoutSegment | null = null;
  for (const seg of trackLayout(track).segments) {
    if (!last || seg.toTMs > last.toTMs) last = seg;
  }
  return last ? (track.keys.find((k) => k.id === last.toId) ?? null) : null;
}

/** The "＋ Animation" placement: connected by default, so a new animation always chains off the last end key rather than landing loose at the playhead.
 *
 * 1. No segments: start at the end of the transition in, run 25% of the animatable window, end clamped to the start of the transition out. A lone unattached key (the static-reframe form) is ABSORBED: its pose seeds the start and the key goes, so the lane never shows a leftover diamond.
 * 2. The playhead sits at least `minLenMs` past the chain's end: chain to a new key AT the playhead (clamped only to `windowEndMs`, since ending inside the transition out is a deliberate ask).
 * 3. Otherwise append after the chain's end, aiming 25% of the window, at least `minLenMs`, clamped to the start of the transition out.
 *
 * Null whenever `minLenMs` doesn't fit, which is how the button probes whether it can be enabled. Both new endpoints are pose-neutral (`poseAt` at their own times), so adding never visibly moves anything. */
export function addAnimationAuto<P, T extends KeyedTrack<P>>(
  track: T,
  ctx: TrackContext,
  playheadMs: number,
  poseAt: (tMs: number) => P,
  minLenMs = MIN_KEY_GAP_MS,
): T | null {
  const min = minLen(minLenMs);
  const aim = Math.max(min, aimSpanMs(ctx));
  const tail = chainTail(track);
  if (!tail) {
    const absorbed = track.keys.length === 1 && track.segments.length === 0 ? track.keys[0] : null;
    const base: T = absorbed ? { ...track, keys: [] } : track;
    const start = Math.round(clamp(ctx.transitionInMs, ctx.windowStartMs, ctx.windowEndMs));
    const end = Math.round(Math.min(start + aim, ctx.transitionOutStartMs, wallAfter(base, start)));
    if (end - start < min) return null;
    const from = {
      id: nextKeyId(base),
      tMs: start,
      pose: absorbed ? absorbed.pose : poseAt(start),
    };
    const keys = [...base.keys, from];
    const to = { id: nextKeyId({ ...base, keys }), tMs: end, pose: poseAt(end) };
    return {
      ...base,
      keys: [...keys, to],
      segments: [...base.segments, { from: from.id, to: to.id, ease: DEFAULT_EASE }],
    };
  }
  const wall = wallAfter(track, tail.tMs);
  const end =
    playheadMs >= tail.tMs + min
      ? Math.round(Math.min(playheadMs, ctx.windowEndMs, wall))
      : Math.round(Math.min(tail.tMs + aim, ctx.transitionOutStartMs, wall));
  if (end - tail.tMs < min) return null;
  const to = { id: nextKeyId(track), tMs: end, pose: poseAt(end) };
  return {
    ...track,
    keys: [...track.keys, to],
    segments: [...track.segments, { from: tail.id, to: to.id, ease: DEFAULT_EASE }],
  };
}

/** Duplicate a key AFTER itself: an identical-pose key at 50% of the following animation, joined by a hold segment (same pose both ends, so the camera pauses there). The following segment keeps its ease and channel settings, compressed into the back half. With nothing following, the hold is appended under addAnimationAuto's case-3 rules. Null when half the following segment is under `minLenMs`, or when no room is left. */
export function duplicateKey<P, T extends KeyedTrack<P>>(
  track: T,
  ctx: TrackContext,
  keyId: string,
  minLenMs = MIN_KEY_GAP_MS,
): T | null {
  const key = track.keys.find((k) => k.id === keyId);
  if (!key) return null;
  const min = minLen(minLenMs);
  const { nextSeg } = junctionInfo(track, keyId);
  const id = nextKeyId(track);
  if (nextSeg) {
    const span = nextSeg.toTMs - nextSeg.fromTMs;
    if (span / 2 < min) return null;
    return {
      ...track,
      keys: [...track.keys, { id, tMs: Math.round(nextSeg.fromTMs + span / 2), pose: key.pose }],
      segments: [
        ...track.segments.map((s, i) => (i === nextSeg.docIndex ? { ...s, from: id } : s)),
        { from: keyId, to: id, ease: DEFAULT_EASE },
      ],
    };
  }
  const aim = Math.max(min, aimSpanMs(ctx));
  const end = Math.round(
    Math.min(key.tMs + aim, ctx.transitionOutStartMs, wallAfter(track, key.tMs)),
  );
  if (end - key.tMs < min) return null;
  return {
    ...track,
    keys: [...track.keys, { id, tMs: end, pose: key.pose }],
    segments: [...track.segments, { from: keyId, to: id, ease: DEFAULT_EASE }],
  };
}

/** Split an animation at `tMs`: a new key carrying the SAMPLED pose at that instant, both halves keeping the original ease and channel settings, so the camera still passes through exactly that pose. Null when either half would fall under the minimum length. */
export function splitSegmentAt<P, T extends KeyedTrack<P>>(
  track: T,
  docIndex: number,
  tMs: number,
  pose: P,
  minLenMs = MIN_KEY_GAP_MS,
): T | null {
  const seg = trackLayout(track).segments.find((s) => s.docIndex === docIndex);
  if (!seg) return null;
  const min = minLen(minLenMs);
  const t = Math.round(tMs);
  if (t - seg.fromTMs < min || seg.toTMs - t < min) return null;
  const id = nextKeyId(track);
  return {
    ...track,
    keys: [...track.keys, { id, tMs: t, pose }],
    segments: track.segments.flatMap((s, i) =>
      i === docIndex
        ? [
            { ...s, to: id },
            { ...s, from: id },
          ]
        : [s],
    ),
  };
}

/** Duplicate a key BEFORE itself, the mirror of duplicateKey: an identical-pose key at 50% of the previous animation (which keeps its ease and channel settings), joined to the original by a hold segment. With nothing before it the hold starts 25% of the window earlier, never before the end of the transition in. */
export function duplicateKeyBefore<P, T extends KeyedTrack<P>>(
  track: T,
  ctx: TrackContext,
  keyId: string,
  minLenMs = MIN_KEY_GAP_MS,
): T | null {
  const key = track.keys.find((k) => k.id === keyId);
  if (!key) return null;
  const min = minLen(minLenMs);
  const { prevSeg } = junctionInfo(track, keyId);
  const id = nextKeyId(track);
  if (prevSeg) {
    const span = prevSeg.toTMs - prevSeg.fromTMs;
    if (span / 2 < min) return null;
    return {
      ...track,
      keys: [...track.keys, { id, tMs: Math.round(prevSeg.fromTMs + span / 2), pose: key.pose }],
      segments: [
        ...track.segments.map((s, i) => (i === prevSeg.docIndex ? { ...s, to: id } : s)),
        { from: id, to: keyId, ease: DEFAULT_EASE },
      ],
    };
  }
  const aim = Math.max(min, aimSpanMs(ctx));
  const start = Math.round(Math.max(key.tMs - aim, ctx.transitionInMs, wallBefore(track, key.tMs)));
  if (key.tMs - start < min) return null;
  return {
    ...track,
    keys: [...track.keys, { id, tMs: start, pose: key.pose }],
    segments: [...track.segments, { from: id, to: keyId, ease: DEFAULT_EASE }],
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

/** Shrink-fit a track to a new scene duration, walking overhanging segments from the end: an end key past the new end clamps its `tMs` to it (pose untouched); a segment whose clamped span would fall under the minimum gap (including one starting past the end) is removed whole under removeSegment's orphan-key convention, continuing to the previous segment as far as needed. Growth and clean tracks return the track unchanged. */
export function clampTrackToDuration<P, T extends KeyedTrack<P>>(track: T, durationMs: number): T {
  let next: T = track;
  for (;;) {
    const layout = trackLayout(next);
    const overhanging = [...layout.segments].reverse().find((s) => s.toTMs > durationMs);
    if (!overhanging) break;
    if (overhanging.fromTMs > durationMs - MIN_KEY_GAP_MS) {
      const removed = removeSegment(next, overhanging.docIndex);
      if (!removed) break;
      next = removed;
      continue;
    }
    next = {
      ...next,
      keys: next.keys.map((k) =>
        k.id === overhanging.toId ? { ...k, tMs: Math.round(durationMs) } : k,
      ),
    };
  }
  return next;
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

/** deleteKeyMerged's result: the new track, plus the pose to freeze when the last animation went (the caller writes the static single-key doc `{ keys: [{ id, tMs: 0, pose: frozenPose }], segments: [] }`). */
export interface MergedDelete<P, T extends KeyedTrack<P>> {
  track: T;
  frozenPose?: P;
}

/** Delete a key the connected way: a junction MERGES its two animations into one (keeping the FIRST segment's ease, per-channel eases and smoothing), an end key takes its animation with it, and losing the last animation collapses the track so the lane never shows a lone diamond, handing back the pose to freeze. An unattached legacy key just goes. Null when the key is unknown. */
export function deleteKeyMerged<P, T extends KeyedTrack<P>>(
  track: T,
  keyId: string,
): MergedDelete<P, T> | null {
  const key = track.keys.find((k) => k.id === keyId);
  if (!key) return null;
  const prev = track.segments.find((s) => s.to === keyId);
  const next = track.segments.find((s) => s.from === keyId);
  const keys = track.keys.filter((k) => k.id !== keyId);
  if (prev && next) {
    const merged = { ...prev, to: next.to };
    return {
      track: {
        ...track,
        keys,
        segments: track.segments
          .filter((s) => s === prev || (s.from !== keyId && s.to !== keyId))
          .map((s) => (s === prev ? merged : s)),
      },
    };
  }
  const seg = prev ?? next;
  if (!seg) return { track: { ...track, keys } };
  const segments = track.segments.filter((s) => s.from !== keyId && s.to !== keyId);
  const partnerId = prev ? seg.from : seg.to;
  if (segments.length === 0) {
    const partner = track.keys.find((k) => k.id === partnerId);
    const collapsed: MergedDelete<P, T> = { track: { ...track, keys: [], segments: [] } };
    if (partner) collapsed.frozenPose = partner.pose;
    return collapsed;
  }
  const referenced = new Set(segments.flatMap((s) => [s.from, s.to]));
  return {
    track: {
      ...track,
      keys: keys.filter((k) => k.id !== partnerId || referenced.has(k.id)),
      segments,
    },
  };
}

/** What a segment resize may ask for: the current span plus the ripple's room, so the modal shows and enforces the same numbers the op applies. */
export interface ResizeBounds {
  spanMs: number;
  minMs: number;
  maxMs: number;
}

export function resizeBounds<P>(
  track: KeyedTrack<P>,
  ctx: TrackContext,
  segIndex: number,
  minLenMs = MIN_KEY_GAP_MS,
): ResizeBounds | null {
  const seg = trackLayout(track).segments.find((s) => s.docIndex === segIndex);
  if (!seg) return null;
  const spanMs = seg.toTMs - seg.fromTMs;
  const lastTMs = track.keys.reduce((m, k) => Math.max(m, k.tMs), 0);
  // An overhanging tail is grandfathered: it may keep its span, never extend it.
  const room = Math.max(0, ctx.windowEndMs - lastTMs);
  const minMs = minLen(minLenMs);
  return { spanMs, minMs, maxMs: Math.max(minMs, Math.round(spanMs + room)) };
}

/** Resize an animation by RIPPLE (decision 6): `from` stays, `to` moves by the delta and every later key shifts with it, so legacy gaps downstream survive intact. Clamped to `resizeBounds`. */
export function resizeSegment<P, T extends KeyedTrack<P>>(
  track: T,
  ctx: TrackContext,
  segIndex: number,
  newSpanMs: number,
  minLenMs = MIN_KEY_GAP_MS,
): T | null {
  const seg = trackLayout(track).segments.find((s) => s.docIndex === segIndex);
  const bounds = resizeBounds(track, ctx, segIndex, minLenMs);
  if (!seg || !bounds) return null;
  const delta = Math.round(clamp(newSpanMs, bounds.minMs, bounds.maxMs)) - bounds.spanMs;
  if (delta === 0) return track;
  return {
    ...track,
    keys: track.keys.map((k) =>
      k.id === seg.toId || k.tMs > seg.toTMs ? { ...k, tMs: k.tMs + delta } : k,
    ),
  };
}

/** Connect-on-drag for legacy gaps: collapse a dragged key onto the neighbour it was dropped on, at the STATIONARY key's time and pose, with every segment re-pointed to it. Null when either key is unknown, they are the same key, or they are the two ends of one segment (which would leave a zero-length animation). */
export function mergeGap<P, T extends KeyedTrack<P>>(
  track: T,
  keyId: string,
  targetKeyId: string,
): T | null {
  if (keyId === targetKeyId) return null;
  const dragged = track.keys.find((k) => k.id === keyId);
  const target = track.keys.find((k) => k.id === targetKeyId);
  if (!dragged || !target) return null;
  const shared = track.segments.some(
    (s) => (s.from === keyId && s.to === targetKeyId) || (s.from === targetKeyId && s.to === keyId),
  );
  if (shared) return null;
  return {
    ...track,
    keys: track.keys.filter((k) => k.id !== keyId),
    segments: track.segments.map((s) => ({
      ...s,
      from: s.from === keyId ? targetKeyId : s.from,
      to: s.to === keyId ? targetKeyId : s.to,
    })),
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

/** The rig's optional per-channel ease overrides. Kept off `setSegmentEase`'s shared signature deliberately: the layered-screenshot lane uses that one too and has no channels. */
export type SegmentEaseChannel = "easePosition" | "easeRotation" | "easeLens";

/** Set or clear one channel's ease override. `undefined` DELETES the field rather than writing a copy of the segment's own ease, so "same as segment" leaves no churn in the sidecar. */
export function setSegmentChannelEase<P, T extends KeyedTrack<P>>(
  track: T,
  docIndex: number,
  channel: SegmentEaseChannel,
  ease: string | undefined,
): T | null {
  if (!track.segments[docIndex]) return null;
  return {
    ...track,
    segments: track.segments.map((s, i) => {
      if (i !== docIndex) return s;
      const next = { ...s } as KeyedTrackSegment & Partial<Record<SegmentEaseChannel, string>>;
      if (ease === undefined) delete next[channel];
      else next[channel] = ease;
      return next;
    }),
  };
}

/** Toggle a rig segment's spline smoothing. ABSENT means smooth, so turning it back on deletes the field rather than writing `true`. */
export function setSegmentSmooth<P, T extends KeyedTrack<P>>(
  track: T,
  docIndex: number,
  smooth: boolean,
): T | null {
  if (!track.segments[docIndex]) return null;
  return {
    ...track,
    segments: track.segments.map((s, i) => {
      if (i !== docIndex) return s;
      const next = { ...s } as KeyedTrackSegment & { smooth?: boolean };
      if (smooth) delete next.smooth;
      else next.smooth = false;
      return next;
    }),
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
