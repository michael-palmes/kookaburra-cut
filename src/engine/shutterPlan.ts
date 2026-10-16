import type { Theme } from "../theme/tokens";
import { type CameraKeyframe, type CameraPose, sampleCameraTrack } from "./cameraTrack";
import type { ShutterSample } from "./clock";
import {
  type MotionBlurSettings,
  resolveSceneMotionBlur,
  type SceneMotionBlur,
  sceneHasMotionBlurOptIn,
} from "./motionBlur";
import { type FrameCameraPlan, resolveFrameCameras, type SceneCameraTracks } from "./sceneCamera";
import type { SceneDoc } from "./sceneDocSchema";
import type { Resolved, SceneSlot } from "./sceneTimeline";
import {
  adaptiveSampleCount,
  cameraBreaks,
  cameraTravel,
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
  /** The frame aspect the camera's on-screen travel is measured in. */
  aspect: number;
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
  sceneThemes?: readonly (Theme | undefined)[];
  motionBlur: MotionBlurSettings | undefined;
  aspect: number;
}): ShutterPlan | null {
  let any = false;
  const scenes = opts.slots.map((slot, i) => {
    const doc = opts.sceneDocs?.[i];
    const optIn = sceneHasMotionBlurOptIn(doc, opts.sceneThemes?.[i]?.textAnimation);
    const blur = resolveSceneMotionBlur(opts.motionBlur, doc?.motionBlur, optIn);
    if (!blur) return null;
    any = true;
    return { blur, durationMs: slot.durationMs };
  });
  if (!any) return null;
  const samples = opts.motionBlur?.samples ?? SHUTTER_SAMPLES_DEFAULT;
  return { fps: opts.fps, aspect: opts.aspect, units: shutterUnitOffsets(samples), scenes };
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

/** The camera plan at each of `units` (window fractions), clamped to each scene and its camera breaks; null when no scene on screen blurs the camera. */
function cameraSamplePlans(
  plan: ShutterPlan,
  resolved: Resolved,
  tMs: number,
  sceneTracks: readonly (SceneCameraTracks | null)[] | null | undefined,
  projectTrack: CameraKeyframe[] | undefined,
  centre: FrameCameraPlan | null,
  units: readonly number[],
): FrameShutter | null {
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
  return { plans, globalMs };
}

/** The camera pose each side renders with: the plan's solo/a/b, or the project track on the legacy path. */
function sidePoses(
  plan: FrameCameraPlan | null,
  projectTrack: CameraKeyframe[] | undefined,
  globalMs: number,
): CameraPose[] {
  if (!plan) return [sampleCameraTrack(projectTrack ?? [], globalMs)];
  return [plan.solo, plan.a, plan.b].filter((p): p is CameraPose => !!p);
}

/** The frame's sample count: the project's, raised while the camera sweeps far enough across the shutter that its copies would separate (pure in t; object samples use the same count). */
export function frameSampleCount(
  plan: ShutterPlan,
  resolved: Resolved,
  tMs: number,
  sceneTracks: readonly (SceneCameraTracks | null)[] | null | undefined,
  projectTrack: CameraKeyframe[] | undefined,
  centre: FrameCameraPlan | null,
): number {
  const floor = plan.units.length;
  const edges = cameraSamplePlans(
    plan,
    resolved,
    tMs,
    sceneTracks,
    projectTrack,
    centre,
    [-0.5, 0.5],
  );
  if (!edges) return floor;
  const from = sidePoses(edges.plans[0], projectTrack, edges.globalMs[0]);
  const to = sidePoses(edges.plans[1], projectTrack, edges.globalMs[1]);
  const mid = sidePoses(centre, projectTrack, tMs);
  let travel = 0;
  for (let i = 0; i < Math.min(from.length, to.length, mid.length); i++) {
    travel = Math.max(travel, cameraTravel(from[i], to[i], mid[i], plan.aspect));
  }
  return adaptiveSampleCount(travel, floor);
}

/** The frame's camera samples, or null when the camera holds still across the shutter (or nothing on screen blurs it), so the frame renders once on the plain path. `samples` is the frame's count (`frameSampleCount`, or the preview's playback count); absent takes the project's. */
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
  const shutter = cameraSamplePlans(plan, resolved, tMs, sceneTracks, projectTrack, centre, units);
  if (!shutter) return null;
  const { plans, globalMs } = shutter;
  const first = plans[0];
  const last = plans[n - 1];
  const still =
    first || last
      ? samePlan(first, last)
      : samePose(
          sampleCameraTrack(projectTrack ?? [], globalMs[0]),
          sampleCameraTrack(projectTrack ?? [], globalMs[n - 1]),
        );
  return still ? null : shutter;
}

/** The frame's object samples: per sample, each blurring scene's time offset and inherited amount. Null when no scene on screen blurs, so no sample ever touches the clock. Offsets clamp to the scene, never to camera breaks (an object's own jump is its motion). */
export function frameObjectShutter(
  plan: ShutterPlan,
  resolved: Resolved,
  sceneTracks: readonly (SceneCameraTracks | null)[] | null | undefined,
  count?: number,
): ShutterSample[] | null {
  const units = count === undefined ? plan.units : shutterUnitOffsets(count);
  const samples: Record<number, { dtMs: number; objects: number }>[] = units.map(() => ({}));
  let any = false;
  for (const scene of resolved.active) {
    const st = plan.scenes[scene.index];
    if (!st?.blur.objectsActive) continue;
    const tracks = sceneTracks?.[scene.index] ?? null;
    const windowMs = shutterWindowMs(
      sampleShutterDeg(tracks, scene.localMs, st.blur.shutterDeg),
      plan.fps,
    );
    if (windowMs <= 0) continue;
    any = true;
    units.forEach((u, k) => {
      const t = Math.min(Math.max(scene.localMs + u * windowMs, 0), st.durationMs);
      samples[k][scene.index] = { dtMs: t - scene.localMs, objects: st.blur.objects ? 1 : 0 };
    });
  }
  return any ? samples : null;
}
