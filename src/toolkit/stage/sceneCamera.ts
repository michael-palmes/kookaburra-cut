import { useContext } from "react";
import { sampleCameraTrack } from "../../engine/cameraTrack";
import { useFormat } from "../../engine/format";
import { frameOnPlane, type PlaneFrame } from "../../engine/frustum";
import { hasSceneCameraTracks, sceneTrackPose } from "../../engine/sceneCamera";
import { SceneCameraTracksContext } from "../../engine/sceneCameraContext";
import { useSceneContext } from "../../engine/sceneContext";
import { useTimeline } from "../../engine/timeline";
import type { V3 } from "../types";

/** The scene camera's pose this frame, as the render applies it. */
export interface SceneCamera {
  position: V3;
  lookAt: V3;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Bank about the view axis, degrees; absent when level. */
  rollDeg?: number;
}

/** The scene camera's current pose: the scene's free-flight rig or orbit track at this scene time, else the project camera track, else the base camera. */
export function useSceneCamera(): SceneCamera {
  const ctx = useContext(SceneCameraTracksContext);
  const scene = useSceneContext();
  const { localMs, globalMs } = useTimeline();
  const fallback = sampleCameraTrack(ctx?.projectTrack ?? [], globalMs);
  const tracks = ctx?.tracks();
  const pose =
    scene && tracks && hasSceneCameraTracks(tracks)
      ? sceneTrackPose(tracks[scene.index], localMs, fallback)
      : fallback;
  return {
    position: pose.position,
    lookAt: pose.lookAt,
    fov: pose.fov,
    ...(pose.rollDeg ? { rollDeg: pose.rollDeg } : {}),
  };
}

/** The world rectangle the scene camera sees on the plane at depth `z` this frame (its bounding box when the camera is tilted or rolled); zero-sized when the camera looks past the plane. */
export function useCameraFrame(z = 0): PlaneFrame {
  const pose = useSceneCamera();
  const format = useFormat();
  return frameOnPlane(pose, format.aspect, z) ?? { width: 0, height: 0, center: [0, 0, z] };
}
