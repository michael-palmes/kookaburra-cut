/** Present-hold camera looping: once a scene's authored camera keys finish, loop the keyed span. Smooth appends a return leg easing back to the first key over blendMs, then replays; jump restarts from the first key each cycle. Present-window sampling only, never used by preview or export. */

import { DEFAULT_EASE, ease } from "../engine/ease";
import { mixPose, type SceneCameraTrack, sampleSceneCamera } from "../engine/sceneCamera";
import type { SceneDocCameraPose, SceneDocCameraPresentLoop } from "../engine/sceneDocSchema";
import { mixRigPose, type RigPose, type SceneRigTrack, sampleSceneRig } from "../engine/sceneRig";

export const DEFAULT_LOOP_BLEND_MS = 2000;

/** Samples a track with hold-looping applied past the last key; inside the authored span it matches sampleSceneCamera exactly (the play-once contract). */
export function sampleLoopedSceneCamera(
  track: SceneCameraTrack,
  localMs: number,
  loop: SceneDocCameraPresentLoop,
): SceneDocCameraPose {
  const first = track.keys[0];
  const last = track.keys[track.keys.length - 1];
  const cycleMs = last.tMs - first.tMs;
  if (cycleMs <= 0 || localMs < last.tMs) return sampleSceneCamera(track, localMs);
  const pastMs = localMs - last.tMs;
  if (loop.mode === "jump") {
    return sampleSceneCamera(track, first.tMs + (pastMs % cycleMs));
  }
  const blendMs = Math.max(1, loop.blendMs ?? DEFAULT_LOOP_BLEND_MS);
  const phase = pastMs % (cycleMs + blendMs);
  if (phase < blendMs) {
    return mixPose(last.pose, first.pose, ease(DEFAULT_EASE, phase / blendMs));
  }
  return sampleSceneCamera(track, first.tMs + (phase - blendMs));
}

/** The rig's hold-loop, identical in shape to the orbit one. The return leg is a SYNTHETIC segment from the last key to the first: no smoothing (there are no neighbour keys at a wrap point to curve toward), no channel eases, and the default ease, blended through the shared canonical path. Inside the authored span it matches `sampleSceneRig` exactly, which is the play-once contract. */
export function sampleLoopedSceneRig(
  track: SceneRigTrack,
  localMs: number,
  loop: SceneDocCameraPresentLoop,
): RigPose {
  const first = track.keys[0];
  const last = track.keys[track.keys.length - 1];
  const cycleMs = last.tMs - first.tMs;
  if (cycleMs <= 0 || localMs < last.tMs) return sampleSceneRig(track, localMs);
  const pastMs = localMs - last.tMs;
  if (loop.mode === "jump") {
    return sampleSceneRig(track, first.tMs + (pastMs % cycleMs));
  }
  const blendMs = Math.max(1, loop.blendMs ?? DEFAULT_LOOP_BLEND_MS);
  const phase = pastMs % (cycleMs + blendMs);
  if (phase < blendMs) {
    return mixRigPose(
      sampleSceneRig(track, last.tMs),
      sampleSceneRig(track, first.tMs),
      ease(DEFAULT_EASE, phase / blendMs),
    );
  }
  return sampleSceneRig(track, first.tMs + (phase - blendMs));
}
