/** Present-hold camera looping: once a scene's authored camera keys finish, loop the keyed span. Smooth appends a return leg easing back to the first key over blendMs, then replays; jump restarts from the first key each cycle. Present-window sampling only, never used by preview or export. */

import { DEFAULT_EASE, ease } from "../engine/ease";
import { lerp, lerp3 } from "../engine/keyframes";
import { type SceneCameraTrack, sampleSceneCamera } from "../engine/sceneCamera";
import type { SceneDocCameraPose, SceneDocCameraPresentLoop } from "../engine/sceneDocSchema";

export const DEFAULT_LOOP_BLEND_MS = 2000;

function mixPose(a: SceneDocCameraPose, b: SceneDocCameraPose, t: number): SceneDocCameraPose {
  return {
    target: lerp3(a.target, b.target, t),
    azimuthDeg: lerp(a.azimuthDeg, b.azimuthDeg, t),
    elevationDeg: lerp(a.elevationDeg, b.elevationDeg, t),
    distance: lerp(a.distance, b.distance, t),
  };
}

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
