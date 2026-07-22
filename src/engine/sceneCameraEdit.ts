import type { KeyedTrack, TrackLayout } from "./keyedTrack";
import type { SceneDocCameraPose, SceneDocCameraPresentLoop } from "./sceneDocSchema";

/** Pure edit math for a sidecar camera track: the mini-timeline's mutations, now thin specialisations of the generic `keyedTrack.ts` (extracted for the layered-screenshot animation track; the exported names, signatures and behaviour are unchanged and the existing tests pin them). The layout model is GAP-PRESERVING with HARD WALLS; sampling semantics live in `sceneCamera.ts`. */

export interface CameraDoc extends KeyedTrack<SceneDocCameraPose> {
  presentLoop?: SceneDocCameraPresentLoop;
}

export type CameraLayout = TrackLayout<SceneDocCameraPose>;

export {
  addSegmentAt,
  MIN_KEY_GAP_MS,
  moveKey,
  moveSegment,
  nearestKey,
  nextKeyId,
  playheadDriftTarget,
  removeKey,
  removeSegment,
  setKeyPose,
  setSegmentEase,
  syncSegmentStartToPrevious,
  trackLayout as cameraLayout,
} from "./keyedTrack";

/** Zero the target's offset from `centre` along the camera right/up axes when within `thresholdWorld`; depth is untouched so a snap can never dolly. */
export function panCentreSnap(
  pose: SceneDocCameraPose,
  centre: readonly [number, number, number],
  thresholdWorld: number,
): { pose: SceneDocCameraPose; snappedX: boolean; snappedY: boolean } {
  const az = (pose.azimuthDeg * Math.PI) / 180;
  const el = (pose.elevationDeg * Math.PI) / 180;
  const right = [Math.cos(az), 0, -Math.sin(az)] as const;
  const up = [-Math.sin(az) * Math.sin(el), Math.cos(el), -Math.cos(az) * Math.sin(el)] as const;
  const off = [
    pose.target[0] - centre[0],
    pose.target[1] - centre[1],
    pose.target[2] - centre[2],
  ] as const;
  const x = off[0] * right[0] + off[1] * right[1] + off[2] * right[2];
  const y = off[0] * up[0] + off[1] * up[1] + off[2] * up[2];
  const snappedX = Math.abs(x) <= thresholdWorld;
  const snappedY = Math.abs(y) <= thresholdWorld;
  if (!snappedX && !snappedY) return { pose, snappedX, snappedY };
  const dx = snappedX ? x : 0;
  const dy = snappedY ? y : 0;
  return {
    pose: {
      ...pose,
      target: [
        pose.target[0] - right[0] * dx - up[0] * dy,
        pose.target[1] - right[1] * dx - up[1] * dy,
        pose.target[2] - right[2] * dx - up[2] * dy,
      ],
    },
    snappedX,
    snappedY,
  };
}
