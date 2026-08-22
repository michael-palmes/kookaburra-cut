import type { SceneDoc, SceneDocImageSpec, SceneImageHost } from "./sceneDocSchema";
import { DEFAULT_SCENE_IMAGE_OVERLAY, DEFAULT_SCENE_IMAGE_STAGE } from "./sceneMedia";

/** The image motion sampler now lives beside the media one (`sceneMedia.ts` owns the kind-aware seam); re-exported so the image family's callers keep one import. */
export { type SceneImageMotionSample, sampleSceneImageMotion } from "./sceneMedia";

export function createSceneImage(id: string, src: string, host: SceneImageHost): SceneDocImageSpec {
  return {
    id,
    src,
    host,
    stage: {
      position: [...DEFAULT_SCENE_IMAGE_STAGE.position],
      size: DEFAULT_SCENE_IMAGE_STAGE.size,
      rotationDeg: [...DEFAULT_SCENE_IMAGE_STAGE.rotationDeg],
    },
    overlay: {
      position: [...DEFAULT_SCENE_IMAGE_OVERLAY.position],
      size: DEFAULT_SCENE_IMAGE_OVERLAY.size,
      rotationDeg: DEFAULT_SCENE_IMAGE_OVERLAY.rotationDeg,
      shape: DEFAULT_SCENE_IMAGE_OVERLAY.shape,
      layer: DEFAULT_SCENE_IMAGE_OVERLAY.layer,
    },
  };
}

export function sceneImagesForHost(
  doc: SceneDoc | undefined,
  host: SceneImageHost,
): readonly SceneDocImageSpec[] {
  return (doc?.images ?? []).filter((image) => image.host === host);
}

export function switchSceneImageHost(
  image: SceneDocImageSpec,
  host: SceneImageHost,
): SceneDocImageSpec {
  return image.host === host ? image : { ...image, host };
}
