import type { EditClip, EditMask, EditMaskKey, EditSource } from "./edit";
import { clipIndexAt, clipTimelineMs, nextPrefixedId, timelineDurationMs } from "./editMath";

/** Pure maths for the editor's privacy masks. A mask lives in SOURCE time: its span and keys index into the source file, and the render applies it before the source is cut into clips (edit_masks.rs), so the timeline only ever shows where that source span lands. Constants marked "mirrored" must match edit_masks.rs exactly. */

export type MaskRect = [number, number, number, number];

/** A new box covers the next 3 s of timeline at the clip's speed. */
export const MASK_DEFAULT_SPAN_MS = 3000;
export const MIN_MASK_SPAN_MS = 100;
/** Smallest box edge, as a fraction of the source frame. */
export const MIN_MASK_SIZE = 0.01;
export const DEFAULT_MASK_COLOR = "#000000";
export const DEFAULT_MASK_STRENGTH = 0.5;
/** Blur sigma as a fraction of min(source w, h): the floor keeps UI text unreadable (mirrored). */
export const MASK_BLUR_MIN = 0.008;
export const MASK_BLUR_MAX = 0.04;
/** Pixelate block edge as a fraction of min(source w, h) (mirrored). */
export const MASK_BLOCK_MIN = 0.025;
export const MASK_BLOCK_MAX = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function effectiveSpeed(speed: number): number {
  return speed > 0 ? speed : 1;
}

function strengthOf(mask: Pick<EditMask, "strength">): number {
  const s = mask.strength;
  return s === undefined || !Number.isFinite(s) ? DEFAULT_MASK_STRENGTH : clamp(s, 0, 1);
}

/** Blur sigma in source pixels (mirrored: edit_masks.rs `blur_sigma_px`). */
export function maskBlurSigmaPx(
  mask: Pick<EditMask, "strength">,
  source: Pick<EditSource, "width" | "height">,
): number {
  const frac = MASK_BLUR_MIN + strengthOf(mask) * (MASK_BLUR_MAX - MASK_BLUR_MIN);
  return Math.round(frac * Math.min(source.width, source.height) * 100) / 100;
}

/** Pixelate block edge in source pixels, even and at least 2 (mirrored: edit_masks.rs `block_px`). */
export function maskBlockPx(
  mask: Pick<EditMask, "strength">,
  source: Pick<EditSource, "width" | "height">,
): number {
  const frac = MASK_BLOCK_MIN + strengthOf(mask) * (MASK_BLOCK_MAX - MASK_BLOCK_MIN);
  return Math.max(2, 2 * Math.round((frac * Math.min(source.width, source.height)) / 2));
}

/** Keeps a box inside the frame and above the minimum size. */
export function clampRect(rect: MaskRect): MaskRect {
  const w = clamp(rect[2], MIN_MASK_SIZE, 1);
  const h = clamp(rect[3], MIN_MASK_SIZE, 1);
  return [clamp(rect[0], 0, 1 - w), clamp(rect[1], 0, 1 - h), w, h];
}

/** The box between two drag corners (normalised source coords). */
export function rectFromCorners(a: [number, number], b: [number, number]): MaskRect {
  const x0 = clamp(Math.min(a[0], b[0]), 0, 1);
  const y0 = clamp(Math.min(a[1], b[1]), 0, 1);
  const x1 = clamp(Math.max(a[0], b[0]), 0, 1);
  const y1 = clamp(Math.max(a[1], b[1]), 0, 1);
  return clampRect([x0, y0, x1 - x0, y1 - y0]);
}

/** A click-placed box centred on `pos`: sized in source pixels off the short edge so it reads the same in portrait and landscape. */
export function defaultMaskRect(
  pos: [number, number],
  source: Pick<EditSource, "width" | "height">,
): MaskRect {
  const short = Math.min(source.width, source.height);
  const w = source.width > 0 ? (0.35 * short) / source.width : 0.35;
  const h = source.height > 0 ? (0.12 * short) / source.height : 0.12;
  return clampRect([pos[0] - w / 2, pos[1] - h / 2, w, h]);
}

/** The box at a source moment: linear between keys, held before the first and after the last. */
export function sampleMaskRect(keys: readonly EditMaskKey[], sourceMs: number): MaskRect | null {
  if (keys.length === 0) return null;
  if (sourceMs <= keys[0].sourceMs) return keys[0].rect;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (sourceMs < b.sourceMs) {
      const a = keys[i - 1];
      const t = (sourceMs - a.sourceMs) / (b.sourceMs - a.sourceMs);
      return [0, 1, 2, 3].map((j) => a.rect[j] + (b.rect[j] - a.rect[j]) * t) as MaskRect;
    }
  }
  return keys[keys.length - 1].rect;
}

/** The source frame on screen at timeline time t: clamped like the preview so the very end still reads the last clip; a freeze or still reads its pinned frame. */
export interface SourceMoment {
  clip: EditClip;
  index: number;
  sourceId: string;
  sourceMs: number;
  hold: boolean;
}

export function sourceMomentAt(clips: EditClip[], tMs: number): SourceMoment | null {
  const total = timelineDurationMs(clips);
  if (total <= 0) return null;
  const t = clamp(tMs, 0, Math.max(0, total - 1));
  const index = clipIndexAt(clips, t);
  if (index < 0) return null;
  const clip = clips[index];
  const hold = clip.holdMs !== undefined;
  const sourceMs = hold
    ? clip.inMs
    : Math.round(Math.min(clip.outMs, clip.inMs + (t - clip.startMs) * effectiveSpeed(clip.speed)));
  return { clip, index, sourceId: clip.sourceId, sourceMs, hold };
}

/** Whether a mask covers a source moment (a still's mask always does). */
export function maskActiveAt(mask: EditMask, sourceMs: number, image: boolean): boolean {
  return image || (sourceMs >= mask.startMs && sourceMs < mask.endMs);
}

/** Where a mask shows on the timeline inside one clip. `startEdge`/`endEdge` mark the mask's own ends (not a clip cut); `hold` is a freeze or still bar. */
export interface MaskWindow {
  maskId: string;
  clipId: string;
  startMs: number;
  endMs: number;
  startEdge: boolean;
  endEdge: boolean;
  hold: boolean;
}

/** One window per clip that shows part of the mask's span: a duplicated segment shows it in each copy, a freeze shows it for its whole hold when its pinned frame is covered, and every clip of a masked still is covered. */
export function maskWindows(clips: EditClip[], mask: EditMask, image: boolean): MaskWindow[] {
  const windows: MaskWindow[] = [];
  for (const clip of clips) {
    if (clip.sourceId !== mask.sourceId) continue;
    const span = clipTimelineMs(clip);
    if (image || clip.holdMs !== undefined) {
      if (!maskActiveAt(mask, clip.inMs, image)) continue;
      windows.push({
        maskId: mask.id,
        clipId: clip.id,
        startMs: clip.startMs,
        endMs: clip.startMs + span,
        startEdge: false,
        endEdge: false,
        hold: true,
      });
      continue;
    }
    const a = Math.max(clip.inMs, mask.startMs);
    const b = Math.min(clip.outMs, mask.endMs);
    if (b <= a) continue;
    const speed = effectiveSpeed(clip.speed);
    windows.push({
      maskId: mask.id,
      clipId: clip.id,
      startMs: clip.startMs + (a - clip.inMs) / speed,
      endMs: clip.startMs + (b - clip.inMs) / speed,
      startEdge: mask.startMs >= clip.inMs,
      endEdge: mask.endMs <= clip.outMs,
      hold: false,
    });
  }
  return windows;
}

/** Lane rows: every bar of one mask shares a row, and a mask takes the lowest row none of its bars overlap. */
export function packMaskRows(windowsByMask: Map<string, MaskWindow[]>): Map<string, number> {
  const order = [...windowsByMask.entries()]
    .filter(([, w]) => w.length > 0)
    .sort((a, b) => a[1][0].startMs - b[1][0].startMs);
  const rows: MaskWindow[][] = [];
  const out = new Map<string, number>();
  for (const [id, windows] of order) {
    let row = rows.findIndex((taken) =>
      windows.every((w) => taken.every((o) => w.endMs <= o.startMs || w.startMs >= o.endMs)),
    );
    if (row < 0) {
      row = rows.length;
      rows.push([]);
    }
    rows[row].push(...windows);
    out.set(id, row);
  }
  return out;
}

/** Drops masks no clip shows any more (Michael's ruling: an orphan goes with the edit that orphaned it; undo brings it back). */
export function pruneOrphanMasks(
  clips: EditClip[],
  masks: EditMask[],
  sources: EditSource[],
): EditMask[] {
  const kept = masks.filter((mask) => {
    const source = sources.find((s) => s.id === mask.sourceId);
    if (!source) return false;
    return maskWindows(clips, mask, source.kind === "image").length > 0;
  });
  return kept.length === masks.length ? masks : kept;
}

/** The source span a new mask covers: the next 3 s of timeline at the clip's speed, clamped inside the source. */
export function defaultMaskRange(
  moment: SourceMoment,
  source: Pick<EditSource, "durationMs">,
): { startMs: number; endMs: number } {
  const speed = moment.hold ? 1 : effectiveSpeed(moment.clip.speed);
  const limit =
    source.durationMs > 0 ? source.durationMs : moment.clip.outMs + MASK_DEFAULT_SPAN_MS;
  const endMs = Math.min(limit, Math.round(moment.sourceMs + MASK_DEFAULT_SPAN_MS * speed));
  const startMs = Math.max(0, Math.min(moment.sourceMs, endMs - MIN_MASK_SPAN_MS));
  return { startMs, endMs: Math.max(endMs, startMs + MIN_MASK_SPAN_MS) };
}

/** Half an output frame in source ms: a drag within it edits the key already there. Output fps, not the source's (a VFR recording's average rate is not a cadence). */
export function keyToleranceMs(outputFps: number, speed: number): number {
  return (500 / (outputFps > 0 ? outputFps : 60)) * effectiveSpeed(speed);
}

export function keyIndexAt(keys: readonly EditMaskKey[], sourceMs: number, tolMs: number): number {
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  keys.forEach((k, i) => {
    const d = Math.abs(k.sourceMs - sourceMs);
    if (d <= tolMs && d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

/** Auto-key: record the box at this moment, replacing a key within tolerance or inserting one in order. A still keeps exactly one key. */
export function upsertMaskKey(
  mask: EditMask,
  sourceMs: number,
  rect: MaskRect,
  tolMs: number,
  image: boolean,
): EditMask {
  const clamped = clampRect(rect);
  if (image) return { ...mask, keys: [{ sourceMs: 0, rect: clamped }] };
  const ms = Math.max(0, Math.round(sourceMs));
  const hit = keyIndexAt(mask.keys, ms, tolMs);
  if (hit >= 0) {
    return { ...mask, keys: mask.keys.map((k, i) => (i === hit ? { ...k, rect: clamped } : k)) };
  }
  const keys = [...mask.keys, { sourceMs: ms, rect: clamped }].sort(
    (a, b) => a.sourceMs - b.sourceMs,
  );
  return { ...mask, keys };
}

/** "+ Key": pin the current glide at this moment so later drags only move what comes after. No-op when a key is already there. */
export function addHoldKey(mask: EditMask, sourceMs: number, tolMs: number): EditMask {
  if (keyIndexAt(mask.keys, sourceMs, tolMs) >= 0) return mask;
  const rect = sampleMaskRect(mask.keys, sourceMs);
  if (!rect) return mask;
  return upsertMaskKey(mask, sourceMs, rect, tolMs, false);
}

/** Removes the key at this moment; a mask always keeps its last key. */
export function removeMaskKey(mask: EditMask, sourceMs: number, tolMs: number): EditMask {
  if (mask.keys.length <= 1) return mask;
  const hit = keyIndexAt(mask.keys, sourceMs, tolMs);
  if (hit < 0) return mask;
  return { ...mask, keys: mask.keys.filter((_, i) => i !== hit) };
}

/** ⌥-drag: shift every key by one shared delta, limited so no key leaves the frame. */
export function offsetMaskKeys(mask: EditMask, dx: number, dy: number): EditMask {
  if (mask.keys.length === 0) return mask;
  const minDx = Math.max(...mask.keys.map((k) => -k.rect[0]));
  const maxDx = Math.min(...mask.keys.map((k) => 1 - k.rect[0] - k.rect[2]));
  const minDy = Math.max(...mask.keys.map((k) => -k.rect[1]));
  const maxDy = Math.min(...mask.keys.map((k) => 1 - k.rect[1] - k.rect[3]));
  const ox = clamp(dx, Math.min(0, minDx), Math.max(0, maxDx));
  const oy = clamp(dy, Math.min(0, minDy), Math.max(0, maxDy));
  return {
    ...mask,
    keys: mask.keys.map((k) => ({
      ...k,
      rect: [k.rect[0] + ox, k.rect[1] + oy, k.rect[2], k.rect[3]] as MaskRect,
    })),
  };
}

/** Source time at timeline time t, NOT clamped to the clip, so a bar end dragged past a contiguous split keeps extending the mask into the next clip. */
export function timelineToSourceUnclamped(clip: EditClip, tMs: number): number {
  if (clip.holdMs !== undefined) return clip.inMs;
  return clip.inMs + (tMs - clip.startMs) * effectiveSpeed(clip.speed);
}

/** Moves one end of a mask's span, keeping the minimum span and staying inside the source. Keys are untouched: ones outside the span still shape the glide inside it. */
export function retimeMaskEdge(
  mask: EditMask,
  edge: "start" | "end",
  sourceMs: number,
  sourceDurationMs: number,
): EditMask {
  const ms = Math.round(sourceMs);
  if (edge === "start") {
    return { ...mask, startMs: clamp(ms, 0, mask.endMs - MIN_MASK_SPAN_MS) };
  }
  const limit = sourceDurationMs > 0 ? sourceDurationMs : Number.POSITIVE_INFINITY;
  return { ...mask, endMs: clamp(ms, mask.startMs + MIN_MASK_SPAN_MS, limit) };
}

/** Next free "m<n>" mask id. */
export function nextMaskId(masks: EditMask[]): string {
  return nextPrefixedId(
    "m",
    masks.map((m) => m.id),
  );
}

/** Replace one mask by id. */
export function replaceMask(masks: EditMask[], next: EditMask): EditMask[] {
  return masks.map((m) => (m.id === next.id ? next : m));
}
