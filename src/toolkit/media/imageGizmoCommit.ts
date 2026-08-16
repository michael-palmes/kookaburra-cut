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

export function stageImageGizmoCommit(
  sceneIndex: number,
  imageId: string,
  pose: StageImageGizmoPose,
): ImageEditCommit {
  const placement: SceneImageStagePlacement = {
    position: [
      round(clamp(pose.position[0], -4, 4), 2),
      round(clamp(pose.position[1], -3, 3), 2),
      round(clamp(pose.position[2], -4, 4), 2),
    ],
    size: round(clamp(pose.size, 0.05, 5), 2),
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
      size: round(clamp(placement.size, 0.03, 0.6), 2),
      rotationDeg: round(normaliseDeg(placement.rotationDeg), 1),
    },
  };
}
