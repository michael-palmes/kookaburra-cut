import type { ImageEditCommit } from "../../engine/imageEditStore";
import {
  normaliseDeg,
  type SceneImageOverlayPlacement,
  type SceneImageStagePlacement,
} from "../../engine/sceneDocSchema";

const round = (value: number, dp: number) => {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export interface StageImageGizmoPose {
  position: readonly [number, number, number];
  rotationDeg: readonly [number, number, number];
  size: number;
}

/** Size ranges a drag writes within: the image family's inspector ranges, widened for windowed media so a window's own default (a whole-frame fraction on Overlay, `DEFAULT_SCENE_MEDIA_VIDEO_STAGE_SIZE` on Stage) is not silently shrunk by the first drag. The inspector's Size rails are soft at the top (a typed value may exceed the max); a gizmo drag still clamps back into range. */
export const STAGE_MEDIA_SIZE_RANGE = { image: [0.05, 5], window: [0.05, 12] } as const;
export const OVERLAY_MEDIA_SIZE_RANGE = { image: [0.03, 0.6], window: [0.03, 1] } as const;

export function stageImageGizmoCommit(
  sceneIndex: number,
  imageId: string,
  pose: StageImageGizmoPose,
  sizeRange: readonly [number, number] = STAGE_MEDIA_SIZE_RANGE.image,
): ImageEditCommit {
  const placement: SceneImageStagePlacement = {
    position: [
      round(clamp(pose.position[0], -4, 4), 2),
      round(clamp(pose.position[1], -3, 3), 2),
      round(clamp(pose.position[2], -4, 4), 2),
    ],
    size: round(clamp(pose.size, sizeRange[0], sizeRange[1]), 2),
    rotationDeg: [
      round(normaliseDeg(pose.rotationDeg[0]), 1),
      round(normaliseDeg(pose.rotationDeg[1]), 1),
      round(normaliseDeg(pose.rotationDeg[2]), 1),
    ],
  };
  return { sceneIndex, imageId, kind: "stage", placement };
}

export function overlayImageGizmoCommit(
  sceneIndex: number,
  imageId: string,
  placement: SceneImageOverlayPlacement,
  sizeRange: readonly [number, number] = OVERLAY_MEDIA_SIZE_RANGE.image,
): ImageEditCommit {
  return {
    sceneIndex,
    imageId,
    kind: "overlay",
    placement: {
      ...placement,
      position: [
        round(clamp(placement.position[0], -1, 1), 2),
        round(clamp(placement.position[1], -1, 1), 2),
      ],
      size: round(clamp(placement.size, sizeRange[0], sizeRange[1]), 2),
      rotationDeg: round(normaliseDeg(placement.rotationDeg), 1),
    },
  };
}
