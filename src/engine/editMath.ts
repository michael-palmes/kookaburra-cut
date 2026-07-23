import type { EditClip, EditTap } from "./edit";

/** Pure timeline math for the video editor. The timeline is magnetic/gapless (locked): clips always butt together end-to-end, so a clip's `startMs` is derived state, array order is timeline order, and every mutation returns a relaid-out array. "Timeline" times are output-video ms (source spans retimed by `speed`); "source" times index into the source file. Persisted fields stay integers (u64 on the Rust side). Functions that read `startMs` expect a relaid array (every mutator returns one; the editor also relays on load). */

/** Source-span floor so a trim or split can never produce an invisible sliver. */
export const MIN_CLIP_SOURCE_MS = 100;

function effectiveSpeed(speed: number): number {
  return speed > 0 ? speed : 1;
}

/** A clip's duration on the timeline: its source span retimed by speed; a freeze holds one source frame for `holdMs`. */
export function clipTimelineMs(clip: EditClip): number {
  if (clip.holdMs !== undefined) return Math.max(0, clip.holdMs);
  return Math.max(0, clip.outMs - clip.inMs) / effectiveSpeed(clip.speed);
}

/** Magnetic layout: each clip starts where the previous one ends, the first at 0. */
export function relayout(clips: EditClip[]): EditClip[] {
  let t = 0;
  return clips.map((clip) => {
    const laid = { ...clip, startMs: Math.round(t) };
    t += clipTimelineMs(clip);
    return laid;
  });
}

export function timelineDurationMs(clips: EditClip[]): number {
  return clips.reduce((sum, clip) => sum + clipTimelineMs(clip), 0);
}

/** Index of the clip under timeline time t (start inclusive, end exclusive), or -1. */
export function clipIndexAt(clips: EditClip[], tMs: number): number {
  let start = 0;
  for (let i = 0; i < clips.length; i++) {
    const end = start + clipTimelineMs(clips[i]);
    if (tMs >= start && tMs < end) return i;
    start = end;
  }
  return -1;
}

/** Source time at timeline time t inside `clip` (clamped to the clip's source span); a freeze always reads its pinned frame. */
export function timelineToSource(clip: EditClip, tMs: number): number {
  if (clip.holdMs !== undefined) return clip.inMs;
  const offset = (tMs - clip.startMs) * effectiveSpeed(clip.speed);
  return Math.min(clip.outMs, Math.max(clip.inMs, clip.inMs + offset));
}

/** Splits the clip under t into two at that point (the right half gets `newId`); returns null when t misses every clip or either half would fall under the source-span floor. */
export function splitAt(clips: EditClip[], tMs: number, newId: string): EditClip[] | null {
  const i = clipIndexAt(clips, tMs);
  if (i < 0) return null;
  const clip = clips[i];
  if (clip.holdMs !== undefined) return null; // a freeze has one frame, nothing to split
  const srcSplit = Math.round(clip.inMs + (tMs - clip.startMs) * effectiveSpeed(clip.speed));
  if (srcSplit - clip.inMs < MIN_CLIP_SOURCE_MS || clip.outMs - srcSplit < MIN_CLIP_SOURCE_MS) {
    return null;
  }
  const left = { ...clip, outMs: srcSplit };
  const right = { ...clip, id: newId, inMs: srcSplit };
  return relayout([...clips.slice(0, i), left, right, ...clips.slice(i + 1)]);
}

export function removeClip(clips: EditClip[], id: string): EditClip[] {
  return relayout(clips.filter((clip) => clip.id !== id));
}

/** Reorder: lift the clip at `from` and re-insert it at `to` (indices in array order). */
export function moveClip(clips: EditClip[], from: number, to: number): EditClip[] {
  if (from === to || from < 0 || from >= clips.length) return clips;
  const next = [...clips];
  const [lifted] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, lifted);
  return relayout(next);
}

export function setClipSpeed(clips: EditClip[], id: string, speed: number): EditClip[] {
  return relayout(
    clips.map((clip) =>
      clip.id === id && clip.holdMs === undefined
        ? { ...clip, speed: effectiveSpeed(speed) }
        : clip,
    ),
  );
}

/** Move a clip's in-point (left trim), clamped to [0, outMs - floor]; freezes have no span to trim. */
export function trimClipIn(clips: EditClip[], id: string, inMs: number): EditClip[] {
  return relayout(
    clips.map((clip) =>
      clip.id === id && clip.holdMs === undefined
        ? {
            ...clip,
            inMs: Math.max(0, Math.min(Math.round(inMs), clip.outMs - MIN_CLIP_SOURCE_MS)),
          }
        : clip,
    ),
  );
}

/** Move a clip's out-point (right trim), clamped to [inMs + floor, source duration]; freezes have no span to trim. */
export function trimClipOut(
  clips: EditClip[],
  id: string,
  outMs: number,
  sourceDurationMs: number,
): EditClip[] {
  return relayout(
    clips.map((clip) =>
      clip.id === id && clip.holdMs === undefined
        ? {
            ...clip,
            outMs: Math.min(
              sourceDurationMs,
              Math.max(Math.round(outMs), clip.inMs + MIN_CLIP_SOURCE_MS),
            ),
          }
        : clip,
    ),
  );
}

/** Minimum freeze length: one comfortable beat, and safely clear of zero. */
export const MIN_HOLD_MS = 100;

/** Insert a freeze of the frame under t: splits the containing clip there (or slips in at its edge when a half would fall under the source floor) and holds that frame for `holdMs`. Null when t misses every clip or lands on an existing freeze. */
export function freezeAt(clips: EditClip[], tMs: number, holdMs: number): EditClip[] | null {
  const i = clipIndexAt(clips, tMs);
  if (i < 0) return null;
  const clip = clips[i];
  if (clip.holdMs !== undefined) return null;
  const src = Math.round(timelineToSource(clip, tMs));
  const freeze: EditClip = {
    id: nextClipId(clips),
    sourceId: clip.sourceId,
    inMs: src,
    outMs: src,
    speed: 1,
    holdMs: Math.max(MIN_HOLD_MS, Math.round(holdMs)),
    startMs: 0,
  };
  if (src - clip.inMs < MIN_CLIP_SOURCE_MS) {
    return relayout([...clips.slice(0, i), freeze, ...clips.slice(i)]);
  }
  if (clip.outMs - src < MIN_CLIP_SOURCE_MS) {
    return relayout([...clips.slice(0, i + 1), freeze, ...clips.slice(i + 1)]);
  }
  const left = { ...clip, outMs: src };
  const right = { ...clip, id: nextClipId([...clips, freeze]), inMs: src };
  return relayout([...clips.slice(0, i), left, freeze, right, ...clips.slice(i + 1)]);
}

/** Retime a freeze clip; non-freezes are untouched. */
export function setClipHold(clips: EditClip[], id: string, holdMs: number): EditClip[] {
  return relayout(
    clips.map((clip) =>
      clip.id === id && clip.holdMs !== undefined
        ? { ...clip, holdMs: Math.max(MIN_HOLD_MS, Math.round(holdMs)) }
        : clip,
    ),
  );
}

/** Every clip boundary (0 and each clip end); the playhead's snap targets. */
export function edgeTargetsMs(clips: EditClip[]): number[] {
  const targets = [0];
  let t = 0;
  for (const clip of clips) {
    t += clipTimelineMs(clip);
    targets.push(t);
  }
  return targets;
}

/** Snap t to the nearest target within the threshold; t unchanged when none is close. */
export function snapMs(tMs: number, targets: number[], thresholdMs: number): number {
  let best = tMs;
  let bestDistance = thresholdMs;
  for (const target of targets) {
    const distance = Math.abs(target - tMs);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = target;
    }
  }
  return best;
}

function nextPrefixedId(prefix: string, ids: string[]): string {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of ids) {
    const m = pattern.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const taken = new Set(ids);
  let n = max + 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Next free "c<n>" id (Rust seeds docs with "c1"); collision-checked against all ids. */
export function nextClipId(clips: EditClip[]): string {
  return nextPrefixedId(
    "c",
    clips.map((clip) => clip.id),
  );
}

/** Next free "s<n>" source id (Rust seeds docs with "s1"). */
export function nextSourceId(sources: { id: string }[]): string {
  return nextPrefixedId(
    "s",
    sources.map((source) => source.id),
  );
}

/** The source point under output time t, or null off-timeline and on freezes (a freeze's zero-length span has no placeable moment). The unrounded twin of `splitAt`'s inline mapping. */
export function outputToSource(
  clips: EditClip[],
  tMs: number,
): { sourceId: string; sourceMs: number } | null {
  const i = clipIndexAt(clips, tMs);
  if (i < 0) return null;
  const clip = clips[i];
  if (clip.holdMs !== undefined) return null;
  return { sourceId: clip.sourceId, sourceMs: Math.round(timelineToSource(clip, tMs)) };
}

export interface TapWindow {
  startMs: number;
  endMs: number;
}

/** Every output window in which `tap` is visible: one per clip containing its source point, so a duplicated segment shows the tap in each copy. Duration is fixed in OUTPUT ms and clamped to the clip's end, so a tap near a cut truncates rather than bleeding into the next clip. Freezes are skipped (zero-length span, containment can never hold). */
export function tapWindows(clips: EditClip[], tap: EditTap, tapDurationMs: number): TapWindow[] {
  const windows: TapWindow[] = [];
  for (const clip of clips) {
    if (clip.holdMs !== undefined) continue;
    if (clip.sourceId !== tap.sourceId) continue;
    if (tap.sourceMs < clip.inMs || tap.sourceMs >= clip.outMs) continue;
    const startMs = clip.startMs + (tap.sourceMs - clip.inMs) / effectiveSpeed(clip.speed);
    const clipEndMs = clip.startMs + clipTimelineMs(clip);
    windows.push({ startMs, endMs: Math.min(startMs + tapDurationMs, clipEndMs) });
  }
  return windows;
}

export function addTap(taps: EditTap[], tap: EditTap): EditTap[] {
  return [...taps, tap];
}

export function moveTap(taps: EditTap[], id: string, pos: [number, number]): EditTap[] {
  return taps.map((tap) => (tap.id === id ? { ...tap, pos } : tap));
}

export function retimeTap(
  taps: EditTap[],
  id: string,
  sourceId: string,
  sourceMs: number,
): EditTap[] {
  return taps.map((tap) => (tap.id === id ? { ...tap, sourceId, sourceMs } : tap));
}

export function removeTap(taps: EditTap[], id: string): EditTap[] {
  return taps.filter((tap) => tap.id !== id);
}

/** Next free "t<n>" tap id; collision-checked against all ids. */
export function nextTapId(taps: EditTap[]): string {
  return nextPrefixedId(
    "t",
    taps.map((tap) => tap.id),
  );
}
