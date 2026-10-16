import { type CameraKeyframe, type CameraPose, sampleCameraTrack } from "./cameraTrack";
import {
  type MotionBlurSettings,
  resolveSceneMotionBlur,
  type SceneMotionBlur,
} from "./motionBlur";
import { type FrameCameraPlan, resolveFrameCameras, type SceneCameraTracks } from "./sceneCamera";
import type { SceneDoc } from "./sceneDocSchema";
import type { Resolved, SceneSlot } from "./sceneTimeline";
import {
  cameraBreaks,
  clampSampleMs,
  SHUTTER_SAMPLES_DEFAULT,
  sampleShutterDeg,
  shutterUnitOffsets,
  shutterWindowMs,
} from "./shutter";

// The motion blur frame plan: resolved once per run, sampled per frame; shutterLane.ts draws it.

interface SceneShutter {
  blur: SceneMotionBlur;
  durationMs: number;
}

export interface ShutterPlan {
  fps: number;
  units: number[];
  scenes: (SceneShutter | null)[];
}

/** One frame's camera samples: the camera plan per sample (null on the legacy project-track path) and the project-track time per sample. */
export interface FrameShutter {
  plans: (FrameCameraPlan | null)[];
  globalMs: number[];
}

/** Built once per run. Null when no scene blurs, so the run takes the byte-identical path. */
export function buildShutterPlan(opts: {
  fps: number;
  slots: SceneSlot[];
  sceneDocs: readonly (SceneDoc | undefined)[] | undefined;
  motionBlur: MotionBlurSettings | undefined;
}): ShutterPlan | null {
  let any = false;
  const scenes = opts.slots.map((slot, i) => {
    const blur = resolveSceneMotionBlur(opts.motionBlur, opts.sceneDocs?.[i]?.motionBlur);
    if (!blur) return null;
    any = true;
    return { blur, durationMs: slot.durationMs };
  });
  if (!any) return null;
  const samples = opts.motionBlur?.samples ?? SHUTTER_SAMPLES_DEFAULT;
  return { fps: opts.fps, units: shutterUnitOffsets(samples), scenes };
}

function samePose(a: CameraPose | undefined, b: CameraPose | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.position.every((v, i) => v === b.position[i]) &&
    a.lookAt.every((v, i) => v === b.lookAt[i]) &&
    a.fov === b.fov &&
    (a.rollDeg ?? 0) === (b.rollDeg ?? 0)
  );
}

function samePlan(a: FrameCameraPlan | null, b: FrameCameraPlan | null): boolean {
  if (!a || !b) return a === b;
  return samePose(a.solo, b.solo) && samePose(a.a, b.a) && samePose(a.b, b.b);
}

/** Focus never smears: every sample keeps the frame instant's depth of field. */
function withCentreDof(plan: FrameCameraPlan | null, centre: FrameCameraPlan | null) {
  if (!plan || !centre) return plan;
  const keep = (pose: CameraPose | undefined, from: CameraPose | undefined) =>
    pose ? { ...pose, dof: from?.dof } : pose;
  return {
    ...plan,
    solo: keep(plan.solo, centre.solo),
    a: keep(plan.a, centre.a),
    b: keep(plan.b, centre.b),
    overlay: keep(plan.overlay, centre.overlay),
  };
}

/** The frame's camera samples, or null when the camera holds still across the shutter (or nothing on screen blurs it), so the frame renders once on the plain path. `samples` overrides the project's count (the preview's playback lane). */
export function frameCameraShutter(
  plan: ShutterPlan,
  resolved: Resolved,
  tMs: number,
  sceneTracks: readonly (SceneCameraTracks | null)[] | null | undefined,
  projectTrack: CameraKeyframe[] | undefined,
  centre: FrameCameraPlan | null,
  samples?: number,
): FrameShutter | null {
  const units = samples === undefined ? plan.units : shutterUnitOffsets(samples);
  const n = units.length;
  const shifted: Resolved[] = Array.from({ length: n }, () => ({ ...resolved, active: [] }));
  const globalMs = new Array<number>(n).fill(tMs);
  let blurs = false;
  for (const scene of resolved.active) {
    const st = plan.scenes[scene.index];
    const tracks = sceneTracks?.[scene.index] ?? null;
    const deg = st?.blur.camera ? sampleShutterDeg(tracks, scene.localMs, st.blur.shutterDeg) : 0;
    const windowMs = st ? shutterWindowMs(deg, plan.fps) : 0;
    const breaks = windowMs > 0 ? cameraBreaks(tracks) : [];
    for (let k = 0; k < n; k++) {
      let localMs = scene.localMs;
      if (st && windowMs > 0) {
        localMs = clampSampleMs(
          scene.localMs,
          scene.localMs + units[k] * windowMs,
          st.durationMs,
          breaks,
        );
        blurs = true;
      }
      shifted[k].active.push({ index: scene.index, localMs });
    }
  }
  if (!blurs) return null;
  // The project-level track follows the dominant scene's shutter.
  const dominant = resolved.active[resolved.active.length - 1];
  for (let k = 0; k < n; k++) {
    const sample = shifted[k].active[shifted[k].active.length - 1];
    globalMs[k] = tMs + (sample.localMs - dominant.localMs);
  }
  const plans = shifted.map((r, k) =>
    withCentreDof(resolveFrameCameras(sceneTracks, projectTrack, r, globalMs[k]), centre),
  );
  const first = plans[0];
  const last = plans[n - 1];
  const still =
    first || last
      ? samePlan(first, last)
      : samePose(
          sampleCameraTrack(projectTrack ?? [], globalMs[0]),
          sampleCameraTrack(projectTrack ?? [], globalMs[n - 1]),
        );
  return still ? null : { plans, globalMs };
}
