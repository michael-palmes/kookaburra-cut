import { ease } from "./ease";
import {
  DEFAULT_SCENE_IMAGE_OVERLAY,
  DEFAULT_SCENE_IMAGE_STAGE,
  type SceneDoc,
  type SceneDocImageSpec,
  type SceneImageHost,
  type SceneImageMotionSpec,
} from "./sceneDocSchema";

const TWO_PI = Math.PI * 2;

export interface SceneImageMotionSample {
  /** Relative to the active host's authored position, in world units on Stage and frame units on Overlay. */
  position: [number, number, number];
  /** Relative Euler rotation in degrees. */
  rotationDeg: [number, number, number];
  scale: number;
  opacity: number;
}

const identityMotion = (): SceneImageMotionSample => ({
  position: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  scale: 1,
  opacity: 1,
});

const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Pure host-aware preset sampling over scene-local time. */
export function sampleSceneImageMotion(
  motion: SceneImageMotionSpec | undefined,
  host: SceneImageHost,
  localMs: number,
): SceneImageMotionSample {
  const sample = identityMotion();
  if (!motion || motion.preset === "none") return sample;

  const safeMs = Number.isFinite(localMs) ? Math.max(0, localMs) : 0;
  const seconds = safeMs / 1000;
  switch (motion.preset) {
    case "turntable": {
      const rotation = finiteOr(motion.degPerSec, 18) * seconds;
      if (host === "stage") sample.rotationDeg[1] = rotation;
      else sample.rotationDeg[2] = rotation * 0.35;
      break;
    }
    case "float": {
      const amplitude = Math.max(0, finiteOr(motion.amplitude, 0.12));
      const hz = Math.max(0, finiteOr(motion.hz, 0.4));
      const offset = amplitude * Math.sin(TWO_PI * hz * seconds);
      sample.position[1] = host === "stage" ? offset : offset * 0.25;
      break;
    }
    case "tilt-reveal": {
      const durationMs = Math.max(1, finiteOr(motion.durationMs, 1000));
      const progress = ease("outCubic", safeMs / durationMs);
      const remaining = 1 - progress;
      if (host === "stage") {
        if (remaining > 0) {
          sample.rotationDeg[0] = -14 * remaining;
          sample.rotationDeg[1] = -40 * remaining;
        }
      } else {
        sample.position[0] = 0.08 * remaining;
        if (remaining > 0) sample.rotationDeg[2] = -10 * remaining;
        sample.scale = 0.96 + 0.04 * progress;
      }
      break;
    }
    case "push-in": {
      const durationMs = Math.max(1, finiteOr(motion.durationMs, 1200));
      const progress = ease("outCubic", safeMs / durationMs);
      if (host === "stage") {
        sample.scale = 0.86 + 0.14 * progress;
        if (progress < 1) sample.rotationDeg[1] = -8 * (1 - progress);
      } else {
        sample.scale = 0.9 + 0.1 * progress;
      }
      break;
    }
  }
  return sample;
}

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
