import type { KeyedTrack, TrackLayout } from "./keyedTrack";
import type { LayeredScreenshotPose } from "./sceneDocSchema";

/** Pure edit maths for the layered-screenshot animation track (`doc.layeredScreenshot.animation`): thin specialisations of the generic `keyedTrack.ts`, the sceneCameraEdit pattern. The layout model is GAP-PRESERVING with HARD WALLS; sampling semantics live in `sceneLayeredScreenshot.ts`. */

export type LayeredScreenshotAnimationDoc = KeyedTrack<LayeredScreenshotPose>;

export type LayeredScreenshotAnimationLayout = TrackLayout<LayeredScreenshotPose>;

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
  trackLayout,
} from "./keyedTrack";

/** Zero each pan axis sitting within `threshold` (stack-local units) of centre, the pan tool's capture; every other pose component is untouched. */
export function panCentreSnap(
  pose: LayeredScreenshotPose,
  threshold: number,
): { pose: LayeredScreenshotPose; snappedX: boolean; snappedY: boolean } {
  const snappedX = Math.abs(pose.pan[0]) <= threshold;
  const snappedY = Math.abs(pose.pan[1]) <= threshold;
  if (!snappedX && !snappedY) return { pose, snappedX, snappedY };
  return {
    pose: { ...pose, pan: [snappedX ? 0 : pose.pan[0], snappedY ? 0 : pose.pan[1]] },
    snappedX,
    snappedY,
  };
}
