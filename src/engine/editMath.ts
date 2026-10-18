import type { EditClip, EditSource, EditTap } from "./edit";

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

/** Default hold for a new freeze, and the length a still image lands on the timeline at (mirrored by Rust's `DEFAULT_IMAGE_HOLD_MS`). */
export const DEFAULT_HOLD_MS = 2000;

/** A still image as a clip: no source span, one frame held for `holdMs`; the freeze construction, minus the split (an image has nothing to cut). */
export function imageClip(clips: EditClip[], sourceId: string, holdMs: number): EditClip {
  return {
    id: nextClipId(clips),
    sourceId,
    inMs: 0,
    outMs: 0,
    speed: 1,
    holdMs: Math.max(MIN_HOLD_MS, Math.round(holdMs)),
    startMs: 0,
  };
}

/** A freeze of `clip`'s source frame at `src`, framed by the clip's crop. */
function freezeOf(clip: EditClip, id: string, src: number, holdMs: number): EditClip {
  const freeze: EditClip = {
    id,
    sourceId: clip.sourceId,
    inMs: src,
    outMs: src,
    speed: 1,
    holdMs: Math.max(MIN_HOLD_MS, Math.round(holdMs)),
    startMs: 0,
  };
  return clip.crop ? { ...freeze, crop: clip.crop } : freeze;
}

/** Insert a freeze of the frame under t: splits the containing clip there (or slips in at its edge when a half would fall under the source floor) and holds that frame for `holdMs`, keeping the clip's crop. Null when t misses every clip or lands on an existing freeze. */
export function freezeAt(clips: EditClip[], tMs: number, holdMs: number): EditClip[] | null {
  const i = clipIndexAt(clips, tMs);
  if (i < 0) return null;
  const clip = clips[i];
  if (clip.holdMs !== undefined) return null;
  const src = Math.round(timelineToSource(clip, tMs));
  const freeze = freezeOf(clip, nextClipId(clips), src, holdMs);
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

/** Append a hold of the last displayed output-frame sample when the playhead is at the timeline end. */
export function freezeAtEnd(
  clips: EditClip[],
  outputFps: number,
  holdMs: number,
): EditClip[] | null {
  const clip = clips.at(-1);
  if (!clip || clip.holdMs !== undefined) return null;
  const fps = outputFps > 0 ? outputFps : 60;
  const endMs = clip.startMs + clipTimelineMs(clip);
  const sampleMs = Math.max(clip.startMs, endMs - 1000 / fps);
  const src = Math.round(timelineToSource(clip, sampleMs));
  return relayout([...clips, freezeOf(clip, nextClipId(clips), src, holdMs)]);
}

/** Splice a caller-built clip in at output time t, mirroring freezeAt: splits the containing clip there, slips to its nearer edge when a half would fall under the source floor (or when t lands on a freeze), and appends off-timeline (including exactly at the end). The caller owns `newClip`'s id (nextClipId against the pre-splice array is safe: the split's right half collision-checks against it). */
export function insertClipAt(clips: EditClip[], tMs: number, newClip: EditClip): EditClip[] {
  const i = clipIndexAt(clips, tMs);
  if (i < 0) return relayout([...clips, newClip]);
  const clip = clips[i];
  if (clip.holdMs !== undefined) {
    const before = tMs - clip.startMs < clipTimelineMs(clip) / 2;
    const at = before ? i : i + 1;
    return relayout([...clips.slice(0, at), newClip, ...clips.slice(at)]);
  }
  const src = Math.round(timelineToSource(clip, tMs));
  const startShort = src - clip.inMs < MIN_CLIP_SOURCE_MS;
  const endShort = clip.outMs - src < MIN_CLIP_SOURCE_MS;
  // Both halves can be short on a sub-2×floor clip: the genuinely nearer edge wins.
  if (startShort && (!endShort || src - clip.inMs <= clip.outMs - src)) {
    return relayout([...clips.slice(0, i), newClip, ...clips.slice(i)]);
  }
  if (endShort) {
    return relayout([...clips.slice(0, i + 1), newClip, ...clips.slice(i + 1)]);
  }
  const left = { ...clip, outMs: src };
  const right = { ...clip, id: nextClipId([...clips, newClip]), inMs: src };
  return relayout([...clips.slice(0, i), left, newClip, right, ...clips.slice(i + 1)]);
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

export function nextPrefixedId(prefix: string, ids: string[]): string {
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

/** Every output window in which `tap` is visible: one per clip containing its source point, so a duplicated segment shows the tap in each copy. Duration is fixed in OUTPUT ms and clamped to the clip's end, so a tap near a cut truncates rather than bleeding into the next clip. Freezes are skipped (zero-length span, containment can never hold), and so is a clip whose crop cuts the tap's point out. */
export function tapWindows(clips: EditClip[], tap: EditTap, tapDurationMs: number): TapWindow[] {
  const windows: TapWindow[] = [];
  for (const clip of clips) {
    if (clip.holdMs !== undefined) continue;
    if (clip.sourceId !== tap.sourceId) continue;
    if (tap.sourceMs < clip.inMs || tap.sourceMs >= clip.outMs) continue;
    if (clip.crop && !posInCrop(tap.pos, clip.crop)) continue;
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

// ── Static crop ───────────────────────────────────────────────────────────────

export type CropRect = [number, number, number, number];

/** Smallest crop edge, as a fraction of the source frame. */
export const MIN_CROP_SIZE = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A crop in even source pixels `[x, y, w, h]`, inside the frame; yuv420 cuts on even pixels, so the render and the preview cut the same ones (mirrored: edit.rs `crop_px`). */
export function cropPixels(crop: CropRect, source: Pick<EditSource, "width" | "height">): CropRect {
  const axis = (pos: number, len: number, size: number): [number, number] => {
    const max = size - (size % 2);
    const l = clamp(2 * Math.round((len * size) / 2), Math.min(2, max), max);
    return [clamp(2 * Math.round((pos * size) / 2), 0, max - l), l];
  };
  const [x, w] = axis(crop[0], crop[2], source.width);
  const [y, h] = axis(crop[1], crop[3], source.height);
  return [x, y, w, h];
}

/** A crop as stored: inside the frame, no edge under MIN_CROP_SIZE, on even source pixels (normalised back). */
export function snapCropRect(
  rect: CropRect,
  source: Pick<EditSource, "width" | "height">,
): CropRect {
  const w = clamp(rect[2], MIN_CROP_SIZE, 1);
  const h = clamp(rect[3], MIN_CROP_SIZE, 1);
  const [x, y, pw, ph] = cropPixels(
    [clamp(rect[0], 0, 1 - w), clamp(rect[1], 0, 1 - h), w, h],
    source,
  );
  return [x / source.width, y / source.height, pw / source.width, ph / source.height];
}

/** The largest crop at `aspect` (width over height, in pixels) centred on `centre`, slid inside the frame and snapped: "Fit output", and kb's `--aspect`. */
export function aspectCropRect(
  source: Pick<EditSource, "width" | "height">,
  aspect: number,
  centre: [number, number] = [0.5, 0.5],
): CropRect {
  const frame = source.width / source.height;
  const w = aspect >= frame ? 1 : aspect / frame;
  const h = aspect >= frame ? frame / aspect : 1;
  return snapCropRect([centre[0] - w / 2, centre[1] - h / 2, w, h], source);
}

/** Whether a normalised source point is inside a crop (edges included). */
export function posInCrop(pos: [number, number], crop: CropRect): boolean {
  return (
    pos[0] >= crop[0] &&
    pos[0] <= crop[0] + crop[2] &&
    pos[1] >= crop[1] &&
    pos[1] <= crop[1] + crop[3]
  );
}

/** A tap's point on a cropped clip, normalised 0..1 across the crop's even pixels, or null when the crop cuts it out; the render then maps it through the letterbox (mirrored: edit.rs tap overlay). */
export function tapPosInCrop(
  pos: [number, number],
  crop: CropRect,
  source: Pick<EditSource, "width" | "height">,
): [number, number] | null {
  if (!posInCrop(pos, crop)) return null;
  const [x, y, w, h] = cropPixels(crop, source);
  return [
    clamp((pos[0] * source.width - x) / w, 0, 1),
    clamp((pos[1] * source.height - y) / h, 0, 1),
  ];
}

/** Sets a clip's crop (null removes it). */
export function setClipCrop(clips: EditClip[], id: string, crop: CropRect | null): EditClip[] {
  return relayout(
    clips.map((clip) => {
      if (clip.id !== id) return clip;
      if (crop) return { ...clip, crop };
      const { crop: _, ...rest } = clip;
      return rest;
    }),
  );
}
