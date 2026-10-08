/** Stills export contract: the per-scene `stills` sidecar block, key marks (`still: true` on camera keys) and the doc-only plan the UI and the stills exporter share. Pure: no three, no React, no runtime registries. */

import { exportFrameTimeMs } from "./exportFrames";
import type { SceneDoc, SceneDocStills } from "./sceneDocSchema";
import { resolveAt, type SceneSlot, timelineTotalMs } from "./sceneTimeline";

export type { SceneDocStills };

export type StillsFormat = "pdf" | "png-zip";
export type StillsSize = "4k" | "1080p" | "720p";

export const STILLS_FORMATS: readonly StillsFormat[] = ["pdf", "png-zip"];
export const STILLS_SIZES: readonly StillsSize[] = ["4k", "1080p", "720p"];
export const DEFAULT_STILLS_FORMAT: StillsFormat = "pdf";
export const DEFAULT_STILLS_SIZE: StillsSize = "1080p";

/** The export frame rate (format.ts `FPS`, pinned by a test); format.ts pulls React and three, so it is mirrored rather than imported. */
export const STILLS_FPS = 60;

const SHORT_EDGE: Record<StillsSize, number> = { "4k": 2160, "1080p": 1080, "720p": 720 };

/** Float slack for frame-grid maths (frame times are `f * 1000 / fps`, never exact in ms). */
const FRAME_EPS = 1e-6;

export type CameraBlock = "camera" | "cameraRig";

export type StillSource =
  | { kind: "auto" }
  | { kind: "key"; block: CameraBlock; keyId: string; tMs: number; clamped: boolean }
  | { kind: "time"; tMs: number; clamped: boolean };

export interface SceneStillsPlan {
  included: boolean;
  /** `[{ kind: "auto" }]`, or marked stills only (key and time), ascending by tMs. Empty when excluded. */
  stills: StillSource[];
  /** `still` keys on the camera block that is not driving the scene (kept on disk, ignored). */
  dormantKeyMarks: number;
}

/** Scene-local window where only this scene is on screen: `[startMs, endMs)`, or `[startMs, endMs]` for the last scene. */
export interface SoloWindow {
  startMs: number;
  endMs: number;
  endInclusive: boolean;
}

export interface StillsSummary {
  scenes: number;
  pages: number;
  auto: number;
  marked: number;
  excluded: number;
  dormantKeyMarks: number;
  clampedMarks: number;
}

/** A still time on the export frame grid. */
export interface StillFrame {
  /** Global frame index; its time is `exportFrameTimeMs(frame, fps)`. */
  frame: number;
  /** Scene-local ms of that frame. */
  localMs: number;
  /** False when the scene has no solo frame: the capture then renders the scene alone at this time. */
  solo: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const finite3 = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

// Key validity mirrors normalizeSceneCamera / normalizeSceneRig (without their warnings), so a mark counts only on a key the track keeps.
function validOrbitPose(pose: unknown): boolean {
  return (
    isObject(pose) &&
    finite3(pose.target) &&
    Number.isFinite(pose.azimuthDeg) &&
    Number.isFinite(pose.elevationDeg) &&
    Number.isFinite(pose.distance)
  );
}

function validRigPose(pose: unknown): boolean {
  if (!isObject(pose) || !finite3(pose.position)) return false;
  const aim = pose.aim;
  if (!isObject(aim) || !finite3(aim.at)) return false;
  const aimOk =
    aim.mode === "point" ||
    aim.mode === "tangent" ||
    (aim.mode === "object" && typeof aim.id === "string" && aim.id.length > 0);
  return (
    aimOk &&
    (pose.fov === undefined || Number.isFinite(pose.fov)) &&
    (pose.rollDeg === undefined || Number.isFinite(pose.rollDeg))
  );
}

interface MarkableKey {
  id: string;
  tMs: number;
  still?: true;
}

/** The keys a normaliser keeps (valid, first id wins), in doc order. */
function keptKeys(keys: unknown, validPose: (pose: unknown) => boolean): MarkableKey[] {
  if (!Array.isArray(keys)) return [];
  const out: MarkableKey[] = [];
  const seen = new Set<string>();
  for (const key of keys as unknown[]) {
    if (!isObject(key) || typeof key.id !== "string" || !Number.isFinite(key.tMs)) continue;
    if (!validPose(key.pose) || seen.has(key.id)) continue;
    seen.add(key.id);
    out.push(key as unknown as MarkableKey);
  }
  return out;
}

function stillKeyCount(keys: unknown): number {
  if (!Array.isArray(keys)) return 0;
  return (keys as unknown[]).filter((key) => isObject(key) && key.still === true).length;
}

/** The camera block whose keys drive the scene (mirrors `buildSceneCameraTracks`), or null when no camera block drives it. */
export function activeCameraBlock(doc: SceneDoc | undefined): CameraBlock | null {
  if (!doc || doc.animatedTrack === "layeredScreenshot") return null;
  if (doc.cameraMode === "rig" && keptKeys(doc.cameraRig?.keys, validRigPose).length > 0) {
    return "cameraRig";
  }
  if (keptKeys(doc.camera?.keys, validOrbitPose).length > 0) return "camera";
  return null;
}

export function soloWindow(slots: readonly SceneSlot[], index: number): SoloWindow {
  const slot = slots[index];
  if (!slot) return { startMs: 0, endMs: 0, endInclusive: false };
  const prev = slots[index - 1];
  const next = slots[index + 1];
  return {
    startMs: prev ? Math.max(0, prev.endMs - slot.startMs) : 0,
    endMs: next ? Math.min(slot.durationMs, next.startMs - slot.startMs) : slot.durationMs,
    endInclusive: !next,
  };
}

export function soloWindowIsEmpty(window: SoloWindow): boolean {
  return window.endInclusive ? window.startMs > window.endMs : window.startMs >= window.endMs;
}

/** The first and last global frames that `resolveAt` renders as this scene alone, or null when there are none. */
export function soloFrameRange(
  slots: readonly SceneSlot[],
  index: number,
  fps: number = STILLS_FPS,
): { first: number; last: number } | null {
  const slot = slots[index];
  const window = soloWindow(slots, index);
  if (!slot || soloWindowIsEmpty(window)) return null;
  const total = timelineTotalMs(slots as SceneSlot[]);
  const solo = (f: number) => {
    const t = exportFrameTimeMs(f, fps);
    if (t < 0 || t > total + FRAME_EPS) return false;
    const r = resolveAt(slots as SceneSlot[], t);
    return r.active.length === 1 && r.active[0].index === index;
  };
  const perMs = fps / 1000;
  let first = Math.max(0, Math.ceil((slot.startMs + window.startMs) * perMs - FRAME_EPS));
  let last = window.endInclusive
    ? Math.floor((slot.startMs + window.endMs) * perMs + FRAME_EPS)
    : Math.ceil((slot.startMs + window.endMs) * perMs - FRAME_EPS) - 1;
  // resolveAt is the oracle at the float edges.
  for (let k = 0; k < 2 && first > 0 && solo(first - 1); k++) first--;
  for (let k = 0; k < 2 && first <= last && !solo(first); k++) first++;
  for (let k = 0; k < 2 && solo(last + 1); k++) last++;
  for (let k = 0; k < 2 && last >= first && !solo(last); k++) last--;
  if (first > last || !solo(first) || !solo(last)) return null;
  return { first, last };
}

/** Snaps a scene-local time onto the frame grid inside the scene's solo window (auto stills `ceil`, marks `round`); a scene with no solo frame snaps within its own span instead. */
export function snapStillFrame(
  slots: readonly SceneSlot[],
  index: number,
  localMs: number,
  fps: number = STILLS_FPS,
  mode: "ceil" | "round" = "round",
): StillFrame {
  const slot = slots[index];
  if (!slot) throw new RangeError(`stills: no scene at index ${index}`);
  const perMs = fps / 1000;
  const toFrame = (ms: number) =>
    mode === "ceil"
      ? Math.ceil((slot.startMs + ms) * perMs - FRAME_EPS)
      : Math.round((slot.startMs + ms) * perMs);
  const localOf = (frame: number) =>
    clamp(exportFrameTimeMs(frame, fps) - slot.startMs, 0, slot.durationMs);
  const range = soloFrameRange(slots, index, fps);
  if (range) {
    const window = soloWindow(slots, index);
    const frame = clamp(
      toFrame(clamp(localMs, window.startMs, window.endMs)),
      range.first,
      range.last,
    );
    return { frame, localMs: localOf(frame), solo: true };
  }
  let frame = toFrame(clamp(localMs, 0, slot.durationMs));
  const lo = Math.max(0, Math.ceil(slot.startMs * perMs - FRAME_EPS));
  const hi = Math.floor(slot.endMs * perMs + FRAME_EPS);
  frame = lo <= hi ? clamp(frame, lo, hi) : Math.round(slot.startMs * perMs);
  return { frame, localMs: localOf(frame), solo: false };
}

function outsideWindow(window: SoloWindow, localMs: number): boolean {
  if (localMs < window.startMs) return true;
  return window.endInclusive ? localMs > window.endMs : localMs >= window.endMs;
}

export function sceneStillsPlan(
  doc: SceneDoc | undefined,
  slots: readonly SceneSlot[],
  index: number,
  fps: number = STILLS_FPS,
): SceneStillsPlan {
  if (doc?.stills?.exclude === true) return { included: false, stills: [], dormantKeyMarks: 0 };
  const active = activeCameraBlock(doc);
  const dormantKeyMarks =
    (active === "camera" ? 0 : stillKeyCount(doc?.camera?.keys)) +
    (active === "cameraRig" ? 0 : stillKeyCount(doc?.cameraRig?.keys));
  const window = soloWindow(slots, index);
  const candidates: {
    source: Exclude<StillSource, { kind: "auto" }>;
    frame: number;
    order: number;
  }[] = [];
  const place = (rawMs: number) => {
    const snapped = snapStillFrame(slots, index, Math.max(0, rawMs), fps, "round");
    return { snapped, clamped: outsideWindow(window, Math.max(0, rawMs)) };
  };
  if (active && doc) {
    const keys = keptKeys(
      active === "camera" ? doc.camera?.keys : doc.cameraRig?.keys,
      active === "camera" ? validOrbitPose : validRigPose,
    );
    for (const key of keys) {
      if (key.still !== true) continue;
      const { snapped, clamped } = place(key.tMs);
      candidates.push({
        source: { kind: "key", block: active, keyId: key.id, tMs: snapped.localMs, clamped },
        frame: snapped.frame,
        order: 0,
      });
    }
  }
  for (const ms of doc?.stills?.marksMs ?? []) {
    if (!Number.isFinite(ms)) continue;
    const { snapped, clamped } = place(ms);
    candidates.push({
      source: { kind: "time", tMs: snapped.localMs, clamped },
      frame: snapped.frame,
      order: 1,
    });
  }
  if (candidates.length === 0)
    return { included: true, stills: [{ kind: "auto" }], dormantKeyMarks };
  // Stable sort: by frame, a key mark before a time mark on the same frame, then doc order.
  candidates.sort((a, b) => a.frame - b.frame || a.order - b.order);
  const stills: StillSource[] = [];
  let lastFrame: number | null = null;
  for (const candidate of candidates) {
    if (candidate.frame === lastFrame) continue;
    lastFrame = candidate.frame;
    stills.push(candidate.source);
  }
  return { included: true, stills, dormantKeyMarks };
}

export function stillsSummary(
  docs: readonly (SceneDoc | undefined)[],
  slots: readonly SceneSlot[],
  fps: number = STILLS_FPS,
): StillsSummary {
  const summary: StillsSummary = {
    scenes: slots.length,
    pages: 0,
    auto: 0,
    marked: 0,
    excluded: 0,
    dormantKeyMarks: 0,
    clampedMarks: 0,
  };
  for (let i = 0; i < slots.length; i++) {
    const plan = sceneStillsPlan(docs[i], slots, i, fps);
    if (!plan.included) {
      summary.excluded += 1;
      continue;
    }
    summary.pages += plan.stills.length;
    summary.dormantKeyMarks += plan.dormantKeyMarks;
    for (const still of plan.stills) {
      if (still.kind === "auto") summary.auto += 1;
      else {
        summary.marked += 1;
        if (still.clamped) summary.clampedMarks += 1;
      }
    }
  }
  return summary;
}

/** Output pixels for a size chip: short edge 2160 / 1080 / 720, never upscaled past the native format. */
export function stillsPixelSize(
  format: { width: number; height: number },
  size: StillsSize,
): { width: number; height: number } {
  const short = Math.min(format.width, format.height);
  const target = SHORT_EDGE[size];
  if (short <= target) return { width: format.width, height: format.height };
  if (format.width <= format.height) {
    return { width: target, height: Math.round((format.height * target) / format.width) };
  }
  return { width: Math.round((format.width * target) / format.height), height: target };
}

// Edit helpers follow the `SceneDocPatch` convention (sceneDocPatchQueue.ts): mutate the draft in place, return false to abort the write.

/** Writes the block back, or drops it when nothing is left (absent is the default). */
function writeStills(draft: SceneDoc, stills: SceneDocStills): void {
  if (stills.exclude === true || (stills.marksMs?.length ?? 0) > 0) draft.stills = stills;
  else delete draft.stills;
}

export function setStillsExcluded(draft: SceneDoc, exclude: boolean): false | undefined {
  if ((draft.stills?.exclude === true) === exclude) return false;
  const { exclude: _was, ...rest } = draft.stills ?? {};
  writeStills(draft, exclude ? { ...rest, exclude: true } : rest);
  return undefined;
}

/** Adds a fixed still at scene-local `ms`; false when one already sits within half a frame. */
export function addStillMark(
  draft: SceneDoc,
  ms: number,
  fps: number = STILLS_FPS,
): false | undefined {
  if (!Number.isFinite(ms)) return false;
  const mark = Math.max(0, Math.round(ms));
  const marks = draft.stills?.marksMs ?? [];
  const half = 500 / fps;
  if (marks.some((m) => Math.abs(m - mark) < half)) return false;
  writeStills(draft, { ...draft.stills, marksMs: [...marks, mark].sort((a, b) => a - b) });
  return undefined;
}

export function removeStillMark(draft: SceneDoc, ms: number): false | undefined {
  const marks = draft.stills?.marksMs;
  if (!marks || !Number.isFinite(ms)) return false;
  const target = Math.round(ms);
  const next = marks.filter((m) => m !== target);
  if (next.length === marks.length) return false;
  const { marksMs: _was, ...rest } = draft.stills ?? {};
  writeStills(draft, next.length > 0 ? { ...rest, marksMs: next } : rest);
  return undefined;
}

/** Flags (or unflags) a key of a keyed track as a still; deletes the field rather than writing false. Returns null for an unknown key. */
export function setKeyStill<T extends { keys: { id: string; still?: true }[] }>(
  track: T,
  keyId: string,
  on: boolean,
): T | null {
  const key = track.keys.find((k) => k.id === keyId);
  if (!key) return null;
  if ((key.still === true) === on) return track;
  return {
    ...track,
    keys: track.keys.map((k) => {
      if (k.id !== keyId) return k;
      if (on) return { ...k, still: true };
      const { still: _was, ...rest } = k;
      return rest;
    }),
  };
}

export function clampStillMarks(
  stills: SceneDocStills | undefined,
  durationMs: number,
): SceneDocStills | undefined {
  const marks = stills?.marksMs;
  if (!stills || !marks?.length) return stills;
  const end = Math.max(0, Math.round(durationMs));
  if (marks.every((m) => m <= end)) return stills;
  return {
    ...stills,
    marksMs: [...new Set(marks.map((m) => Math.min(m, end)))].sort((a, b) => a - b),
  };
}
