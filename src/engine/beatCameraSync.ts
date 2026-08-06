/** Beat-driven camera generation: pure track builders behind the beat lane's "Sync scene camera to beats" and "Add camera keyframe here" actions. Everything returns ordinary orbit `CameraDoc` data written through the normal sidecar path, so results are editable, undoable and add no determinism surface. Best effort by design; free-flight (rig) scenes are out of scope. */

import type { BeatKeyMoment } from "./beatAnalysis";
import { type CameraKeyframe, sampleCameraTrack } from "./cameraTrack";
import { DEFAULT_EASE } from "./ease";
import {
  addAnimationAuto,
  type KeyedTrackKey,
  MIN_KEY_GAP_MS,
  moveKey,
  splitSegmentAt,
  type TrackContext,
  trackLayout,
} from "./keyedTrack";
import type { LoadedProject } from "./project";
import {
  defaultOrbitPose,
  normalizeSceneCamera,
  orbitFromView,
  sampleSceneCamera,
} from "./sceneCamera";
import type { CameraDoc } from "./sceneCameraEdit";
import type { SceneDocCameraPose } from "./sceneDocSchema";

/** Cuts closer together than this read as jitter, not rhythm. */
export const SYNC_MIN_SPACING_MS = 1200;
export const SYNC_MAX_KEYS = 6;
/** Gentle alternating move: push in, then settle back past the base. */
export const SYNC_PUSH_IN = 0.92;
export const SYNC_PULL_BACK = 1.05;
export const SYNC_DRIFT_DEG = 2.5;

/** The scene's attribution/transition context, the same maths the animation lane derives. */
export function sceneTrackContext(project: LoadedProject, sceneIndex: number): TrackContext {
  const slot = project.slots[sceneIndex];
  const nextSlot = project.slots[sceneIndex + 1];
  const windowEndMs = slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2;
  return {
    durationMs: slot.durationMs,
    windowStartMs: (slot.transitionIn?.durationMs ?? 0) / 2,
    windowEndMs,
    transitionInMs: slot.transitionIn?.durationMs ?? 0,
    transitionOutStartMs: nextSlot?.transitionIn
      ? slot.durationMs - nextSlot.transitionIn.durationMs
      : windowEndMs,
  };
}

/** The applied orbit pose at scene-local `t` without the lane hook: the doc track, else the project track, else the house default (mirrors `useCameraDoc.appliedPoseAt`). */
export function appliedOrbitPoseAt(
  camera: CameraDoc | undefined,
  projectTrack: CameraKeyframe[] | undefined,
  slotStartMs: number,
  localT: number,
): SceneDocCameraPose {
  const norm = camera?.keys.length ? normalizeSceneCamera(camera, "beat-sync") : null;
  if (norm) return sampleSceneCamera(norm, localT);
  if (projectTrack?.length) {
    const p = sampleCameraTrack(projectTrack, slotStartMs + localT);
    return orbitFromView(p.position, p.lookAt);
  }
  return defaultOrbitPose();
}

/** Pick the beats to cut on inside [spanStartMs, spanEndMs]: strongest first, spaced, capped, returned in time order. The first pick must leave a segment's room after the span start. */
export function pickSyncMoments(
  moments: BeatKeyMoment[],
  spanStartMs: number,
  spanEndMs: number,
  minSpacingMs = SYNC_MIN_SPACING_MS,
  cap = SYNC_MAX_KEYS,
): number[] {
  const inSpan = moments.filter((m) => m.tMs >= spanStartMs + minSpacingMs && m.tMs <= spanEndMs);
  const kept: number[] = [];
  for (const m of [...inSpan].sort((a, b) => b.strength - a.strength)) {
    if (kept.length >= cap) break;
    if (kept.every((t) => Math.abs(t - m.tMs) >= minSpacingMs)) kept.push(m.tMs);
  }
  return kept.sort((a, b) => a - b);
}

/** The generated track: a base key at the span start, then a key landing ON each picked beat, alternating a gentle push-in and pull-back with a small azimuth drift. Replaces the scene's orbit track wholesale (the action's contract; undo restores). */
export function buildSyncTrack(
  basePose: SceneDocCameraPose,
  timesLocal: number[],
  spanStartMs: number,
): CameraDoc {
  const keys: KeyedTrackKey<SceneDocCameraPose>[] = [
    { id: "k1", tMs: Math.round(spanStartMs), pose: basePose },
  ];
  const segments: CameraDoc["segments"] = [];
  timesLocal.forEach((t, i) => {
    const id = `k${i + 2}`;
    const push = i % 2 === 0;
    keys.push({
      id,
      tMs: Math.round(t),
      pose: {
        ...basePose,
        distance: basePose.distance * (push ? SYNC_PUSH_IN : SYNC_PULL_BACK),
        azimuthDeg: basePose.azimuthDeg + (push ? SYNC_DRIFT_DEG : -SYNC_DRIFT_DEG),
      },
    });
    segments.push({ from: keys[keys.length - 2].id, to: id, ease: DEFAULT_EASE });
  });
  return { keys, segments };
}

/** One keyframe landing on the beat: split the segment under it (sampled pose, so the camera still passes through unchanged), grow the chain to end there when the beat is past it, or start a pose-neutral animation ending on the beat in an empty track. Null when nothing fits (a gap between animations, or no room). */
export function addKeyAtBeat(
  track: CameraDoc,
  ctx: TrackContext,
  tLocal: number,
  poseAt: (t: number) => SceneDocCameraPose,
  minLenMs = MIN_KEY_GAP_MS,
): CameraDoc | null {
  const min = Math.max(MIN_KEY_GAP_MS, minLenMs);
  const layout = trackLayout(track);
  const seg = layout.segments.find((s) => tLocal > s.fromTMs && tLocal < s.toTMs);
  if (seg) return splitSegmentAt(track, seg.docIndex, tLocal, poseAt(tLocal), minLenMs);
  if (layout.segments.length === 0) {
    // First animation: the auto placement (which absorbs a lone static key), retimed to end on the beat.
    const added = addAnimationAuto(track, ctx, tLocal, poseAt, minLenMs);
    if (!added) return null;
    const addedLayout = trackLayout(added);
    const endId = addedLayout.segments[addedLayout.segments.length - 1].toId;
    return moveKey(added, endId, Math.round(tLocal), ctx.durationMs, minLenMs);
  }
  const tail = layout.segments[layout.segments.length - 1];
  if (tLocal >= tail.toTMs + min) return addAnimationAuto(track, ctx, tLocal, poseAt, minLenMs);
  return null;
}
