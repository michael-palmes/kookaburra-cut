import {
  DEFAULT_SCENE_IMAGE_OVERLAY,
  DEFAULT_SCENE_IMAGE_STAGE,
  type SceneDoc,
  type SceneDocImageSpec,
  type SceneImageHost,
} from "./sceneDocSchema";

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
