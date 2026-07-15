import { DEFAULT_EASE } from "./ease";
import type { SceneDocCameraKey, SceneDocCameraPose } from "./sceneDocSchema";

/** Pure edit math for a sidecar camera track: the mini-timeline's mutations. Operates on the raw doc shape (`{ keys, segments }`, ids referencing keys) and returns a NEW object per mutation; the UI keeps a draft during a drag and writes the committed value through `writeSceneDoc` on pointer-up. The layout model is GAP-PRESERVING with HARD WALLS, the opposite of the video editor's magnetic timeline: nothing reflows, a drag simply clamps against its neighbouring keys and the scene edges (existing overhang keys stay legal, but drags never create new positions past the end or before 0). Sampling semantics live in `sceneCamera.ts`; this module never interprets eases. */

export interface CameraDoc {
  keys: SceneDocCameraKey[];
  segments: { from: string; to: string; ease: string }[];
}

/** The minimum span between neighbouring keys (and of a segment): one 60fps frame. */
export const MIN_KEY_GAP_MS = 17;

/** Resolved display/edit layout: keys sorted, segments with resolved times (bad ones dropped). */
export interface CameraLayout {
  keys: { id: string; tMs: number; pose: SceneDocCameraPose }[];
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

export function cameraLayout(camera: CameraDoc): CameraLayout {
  const keys = [...camera.keys].sort((a, b) => a.tMs - b.tMs);
  const byId = new Map(camera.keys.map((k) => [k.id, k]));
  const segments = camera.segments
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
export function nextKeyId(camera: CameraDoc): string {
  let max = 0;
  for (const key of camera.keys) {
    const m = /^k(\d+)$/.exec(key.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const taken = new Set(camera.keys.map((k) => k.id));
  let n = max + 1;
  while (taken.has(`k${n}`)) n++;
  return `k${n}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Hard walls for one key: its neighbours (over ALL keys) ± the minimum gap, and the scene edges, except an already-overhanging key may keep (but not extend) its overhang. */
function keyWalls(
  camera: CameraDoc,
  keyId: string,
  durationMs: number,
): { lo: number; hi: number } {
  const me = camera.keys.find((k) => k.id === keyId);
  let lo = 0;
  let hi = Math.max(durationMs, me ? me.tMs : 0);
  for (const key of camera.keys) {
    if (key.id === keyId || !me) continue;
    if (key.tMs <= me.tMs) lo = Math.max(lo, key.tMs + MIN_KEY_GAP_MS);
    else hi = Math.min(hi, key.tMs - MIN_KEY_GAP_MS);
  }
  return { lo, hi };
}

/** Move one key to `tMs`, clamped to its walls. Null when the key is unknown. */
export function moveKey(
  camera: CameraDoc,
  keyId: string,
  tMs: number,
  durationMs: number,
): CameraDoc | null {
  const me = camera.keys.find((k) => k.id === keyId);
  if (!me) return null;
  const { lo, hi } = keyWalls(camera, keyId, durationMs);
  if (lo > hi) return camera; // fully walled in, no free space, no move
  const next = Math.round(clamp(tMs, lo, hi));
  if (next === me.tMs) return camera;
  return {
    ...camera,
    keys: camera.keys.map((k) => (k.id === keyId ? { ...k, tMs: next } : k)),
  };
}

/** Move a segment rigidly by `deltaMs`: both keys shift together, clamped so NEITHER key crosses a wall (outside keys, 0, scene end). A boundary key shared with an adjacent segment moves too (shared keys are the data model); its wall is the neighbour's OTHER key. */
export function moveSegment(
  camera: CameraDoc,
  fromId: string,
  toId: string,
  deltaMs: number,
  durationMs: number,
): CameraDoc | null {
  const from = camera.keys.find((k) => k.id === fromId);
  const to = camera.keys.find((k) => k.id === toId);
  if (!from || !to || fromId === toId) return null;
  let lo = 0 - from.tMs;
  let hi = Math.max(durationMs, to.tMs) - to.tMs;
  for (const key of camera.keys) {
    if (key.id === fromId || key.id === toId) continue;
    // Keys inside the span can't exist (segments don't overlap and walls hold); outside keys bound the rigid move from each side.
    if (key.tMs <= from.tMs) lo = Math.max(lo, key.tMs + MIN_KEY_GAP_MS - from.tMs);
    if (key.tMs >= to.tMs) hi = Math.min(hi, key.tMs - MIN_KEY_GAP_MS - to.tMs);
  }
  if (lo > hi) return camera;
  const delta = Math.round(clamp(deltaMs, lo, hi));
  if (delta === 0) return camera;
  return {
    ...camera,
    keys: camera.keys.map((k) =>
      k.id === fromId || k.id === toId ? { ...k, tMs: k.tMs + delta } : k,
    ),
  };
}

/** Insert an animation at the playhead: a segment from `tMs` to `tMs + spanMs`, truncated by the next key/segment and the scene end. Both poses are supplied by the caller (each sampled at its own time from the CURRENT track, so adding must never visibly move the camera). Reuses an existing key sitting exactly at `tMs` (within half the minimum gap) as the shared `from`; refuses (null) when the playhead is inside an existing segment or there's no room for a minimum-length segment. */
export function addSegmentAt(
  camera: CameraDoc,
  tMs: number,
  poseFrom: SceneDocCameraPose,
  poseTo: SceneDocCameraPose,
  durationMs: number,
  spanMs = 1000,
): CameraDoc | null {
  const layout = cameraLayout(camera);
  const start = Math.round(clamp(tMs, 0, Math.max(0, durationMs - MIN_KEY_GAP_MS)));
  for (const seg of layout.segments) {
    if (start > seg.fromTMs - MIN_KEY_GAP_MS && start < seg.toTMs + MIN_KEY_GAP_MS) {
      // Inside (or touching) an existing animation, except exactly at its end key, which chains a new animation off the shared boundary.
      const endKey = camera.keys.find((k) => k.id === seg.toId);
      if (!endKey || Math.abs(start - endKey.tMs) > MIN_KEY_GAP_MS / 2) return null;
    }
  }
  const shared = camera.keys.find((k) => Math.abs(k.tMs - start) <= MIN_KEY_GAP_MS / 2);
  const from = shared ?? { id: nextKeyId(camera), tMs: start, pose: poseFrom };
  // Truncate against whatever comes next (any key wall) and the scene end.
  let end = Math.min(start + spanMs, durationMs);
  for (const key of camera.keys) {
    if (key.id !== from.id && key.tMs > start) {
      end = Math.min(end, key.tMs - MIN_KEY_GAP_MS);
    }
  }
  if (end - from.tMs < MIN_KEY_GAP_MS) return null;
  const withFrom = shared ? camera.keys : [...camera.keys, from];
  const to = { id: nextKeyId({ ...camera, keys: withFrom }), tMs: Math.round(end), pose: poseTo };
  return {
    keys: [...withFrom, to],
    segments: [...camera.segments, { from: from.id, to: to.id, ease: DEFAULT_EASE }],
  };
}

/** Remove a segment (by doc index); its keys go too unless another segment references them. */
export function removeSegment(camera: CameraDoc, docIndex: number): CameraDoc | null {
  const seg = camera.segments[docIndex];
  if (!seg) return null;
  const segments = camera.segments.filter((_, i) => i !== docIndex);
  const referenced = new Set(segments.flatMap((s) => [s.from, s.to]));
  return {
    keys: camera.keys.filter((k) => (k.id !== seg.from && k.id !== seg.to) || referenced.has(k.id)),
    segments,
  };
}

/** Remove a key and every segment referencing it. */
export function removeKey(camera: CameraDoc, keyId: string): CameraDoc | null {
  if (!camera.keys.some((k) => k.id === keyId)) return null;
  return {
    keys: camera.keys.filter((k) => k.id !== keyId),
    segments: camera.segments.filter((s) => s.from !== keyId && s.to !== keyId),
  };
}

export function setSegmentEase(
  camera: CameraDoc,
  docIndex: number,
  ease: string,
): CameraDoc | null {
  if (!camera.segments[docIndex]) return null;
  return {
    ...camera,
    segments: camera.segments.map((s, i) => (i === docIndex ? { ...s, ease } : s)),
  };
}

export function setKeyPose(
  camera: CameraDoc,
  keyId: string,
  pose: SceneDocCameraPose,
): CameraDoc | null {
  if (!camera.keys.some((k) => k.id === keyId)) return null;
  return {
    ...camera,
    keys: camera.keys.map((k) => (k.id === keyId ? { ...k, pose } : k)),
  };
}

/** The key nearest to `tMs` (the move tools' default target), or null on an empty track. */
export function nearestKey(camera: CameraDoc, tMs: number): SceneDocCameraKey | null {
  let best: SceneDocCameraKey | null = null;
  for (const key of camera.keys) {
    if (!best || Math.abs(key.tMs - tMs) < Math.abs(best.tMs - tMs)) best = key;
  }
  return best;
}
