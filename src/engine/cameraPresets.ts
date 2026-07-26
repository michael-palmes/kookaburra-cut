/** Canned camera moves: pure functions from a scene's duration and its CURRENT applied pose to a track, so applying one reframes rather than teleports. Data on top of the samplers, no engine work: every preset must survive `normalizeSceneCamera`/`normalizeSceneRig` unchanged, which the tests pin. The set deliberately spans both modes, because two of these moves are exactly what orbit is for. */
import { CAMERA } from "./format";
import { MIN_KEY_GAP_MS } from "./keyedTrack";
import { orbitToView } from "./orbit";
import type { CameraDoc, RigDoc } from "./sceneCameraEdit";
import type { SceneDocCameraPose, SceneDocRigPose } from "./sceneDocSchema";
import { RIG_FOV_MAX, RIG_FOV_MIN } from "./sceneRig";

export interface PresetContext {
  durationMs: number;
  /** What the scene shows now, in both shapes; presets seed from these so framing carries over. */
  orbit: SceneDocCameraPose;
  free: SceneDocRigPose;
  /** The fov the scene currently renders at (the project track's, unless a rig key set one). */
  fov: number;
}

export interface CameraPresetResult {
  mode: "orbit" | "rig";
  camera?: CameraDoc;
  rig?: RigDoc;
}

export interface CameraPreset {
  id: string;
  label: string;
  description: string;
  mode: "orbit" | "rig";
  build: (ctx: PresetContext) => CameraPresetResult;
}

/** `count` key times spanning the scene, never closer than the engine's minimum gap: a very short scene compresses rather than producing a track the normaliser would drop. */
export function spreadTimes(durationMs: number, count: number): number[] {
  const span = Math.max(MIN_KEY_GAP_MS * (count - 1), Math.max(0, durationMs));
  return Array.from({ length: count }, (_, i) => Math.round((span * i) / (count - 1)));
}

const clampFov = (fov: number) => Math.min(RIG_FOV_MAX, Math.max(RIG_FOV_MIN, fov));

const orbitTrack = (
  times: number[],
  poses: SceneDocCameraPose[],
  ease: string,
): CameraPresetResult => ({
  mode: "orbit",
  camera: {
    keys: times.map((tMs, i) => ({ id: `k${i + 1}`, tMs, pose: poses[i] })),
    segments: times.slice(0, -1).map((_, i) => ({ from: `k${i + 1}`, to: `k${i + 2}`, ease })),
  },
});

const rigTrack = (
  times: number[],
  poses: SceneDocRigPose[],
  ease: string,
  segment: { smooth?: boolean; easeLens?: string } = {},
): CameraPresetResult => ({
  mode: "rig",
  rig: {
    keys: times.map((tMs, i) => ({ id: `k${i + 1}`, tMs, pose: poses[i] })),
    segments: times.slice(0, -1).map((_, i) => ({
      from: `k${i + 1}`,
      to: `k${i + 2}`,
      ease,
      ...segment,
    })),
  },
});

/** A free pose looking at `at` from `position`, carrying an optional lens and bank. */
const freePose = (
  position: [number, number, number],
  at: [number, number, number],
  extra: Partial<SceneDocRigPose> = {},
): SceneDocRigPose => ({ position, aim: { mode: "point", at }, ...extra });

export const CAMERA_PRESETS: CameraPreset[] = [
  {
    id: "push-in",
    label: "Push in",
    description: "Ease closer to the subject without changing the angle.",
    mode: "orbit",
    build: ({ durationMs, orbit }) => {
      const times = spreadTimes(durationMs, 2);
      return orbitTrack(
        times,
        [
          { ...orbit, target: [...orbit.target], distance: orbit.distance * 1.18 },
          { ...orbit, target: [...orbit.target], distance: orbit.distance * 0.84 },
        ],
        "inOutCubic",
      );
    },
  },
  {
    id: "orbit-round",
    label: "Orbit round",
    description: "A full turn around the subject, back to where it started.",
    mode: "orbit",
    build: ({ durationMs, orbit }) => {
      const times = spreadTimes(durationMs, 2);
      // Azimuth interpolates as a plain number with no shortest-arc wrapping, which is exactly
      // what lets +360 read as a full revolution rather than standing still.
      return orbitTrack(
        times,
        [
          { ...orbit, target: [...orbit.target] },
          { ...orbit, target: [...orbit.target], azimuthDeg: orbit.azimuthDeg + 360 },
        ],
        "linear",
      );
    },
  },
  {
    id: "crane-down",
    label: "Crane down",
    description: "Drop the camera's height while it holds the subject.",
    mode: "rig",
    build: ({ durationMs, free }) => {
      const times = spreadTimes(durationMs, 2);
      const at: [number, number, number] = [...free.aim.at];
      const [x, y, z] = free.position;
      return rigTrack(
        times,
        [freePose([x, y + 1.6, z], at), freePose([x, y, z], at)],
        "inOutQuad",
        { smooth: false },
      );
    },
  },
  {
    id: "fly-through",
    label: "Fly through",
    description: "A curved flight into the scene, looking along the path. Reads best in bands.",
    mode: "rig",
    build: ({ durationMs, free }) => {
      const times = spreadTimes(durationMs, 4);
      const [x, y, z] = free.position;
      const path: [number, number, number][] = [
        [x - 1.2, y + 0.5, z + 1.6],
        [x - 0.5, y + 0.2, z - 0.4],
        [x + 0.4, y, z - 2.2],
        [x + 1.0, y + 0.1, z - 3.6],
      ];
      // Each key bakes the NEXT point, so a degenerate tangent still aims down the path.
      return rigTrack(
        times,
        path.map((position, i) => ({
          position,
          aim: { mode: "tangent", at: path[Math.min(i + 1, path.length - 1)] },
        })),
        "linear",
      );
    },
  },
  {
    id: "parallax-slide",
    label: "Parallax slide",
    description: "Truck sideways with the aim held, so depth layers separate.",
    mode: "rig",
    build: ({ durationMs, free }) => {
      const times = spreadTimes(durationMs, 2);
      const at: [number, number, number] = [...free.aim.at];
      const [x, y, z] = free.position;
      return rigTrack(
        times,
        [freePose([x - 1.8, y, z], at), freePose([x + 1.8, y, z], at)],
        "inOutSine",
        { smooth: false },
      );
    },
  },
  {
    id: "dolly-zoom",
    label: "Dolly zoom",
    description: "Pull back while the lens narrows, so the subject holds and the set warps.",
    mode: "rig",
    build: ({ durationMs, free, fov }) => {
      const times = spreadTimes(durationMs, 2);
      const at: [number, number, number] = [...free.aim.at];
      const [x, y, z] = free.position;
      const start = clampFov(Math.max(fov, CAMERA.fov) * 1.35);
      const end = clampFov(start * 0.45);
      const dz = z - at[2];
      // Distance and lens trade against each other; the lens LAGS via its own ease, which is the
      // whole trick, so the warp arrives after the move has started.
      return rigTrack(
        times,
        [
          freePose([x, y, at[2] + dz * 0.62], at, { fov: start }),
          freePose([x, y, at[2] + dz * 1.55], at, { fov: end }),
        ],
        "linear",
        { smooth: false, easeLens: "inCubic" },
      );
    },
  },
];

/** The applied pose a preset should seed from, in both shapes. */
export function presetContext(
  durationMs: number,
  orbit: SceneDocCameraPose,
  fov: number,
): PresetContext {
  const view = orbitToView(orbit);
  return {
    durationMs,
    orbit,
    free: { position: view.position, aim: { mode: "point", at: view.lookAt } },
    fov,
  };
}
