/** Pure edit maths for a FREE camera pose: the four stage drag tools, extracted from the overlay so they unit-test without a pointer. Orbit's equivalents live in `sceneCameraEdit.ts` and are untouched; sampling semantics live in `sceneRig.ts`. */
import type { SceneDocRigPose } from "./sceneDocSchema";

type V3 = [number, number, number];
type RV3 = readonly [number, number, number];

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Pitch stops here, matching orbit's elevation clamp, so a Look drag can never flip the horizon. */
export const LOOK_PITCH_LIMIT = 85;
/** The aim can't be dragged closer than this, so Forward never passes through what it's aiming at. */
export const MIN_AIM_DISTANCE = 0.2;
export const MAX_AIM_DISTANCE = 50;
/** Roll wraps no further than a half turn each way. */
export const MAX_ROLL_DEG = 180;
/** A Tilt drag across the full stage width banks this far. */
export const TILT_DEG_PER_STAGE = 90;
/** Forward's exponent across the full stage height (orbit's dolly constant). */
const FORWARD_EXP = 2;

const sub = (a: RV3, b: RV3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: RV3, b: RV3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: RV3): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
const unit = (v: RV3): V3 | null => {
  const l = len(v);
  return l < 1e-9 ? null : [v[0] / l, v[1] / l, v[2] / l];
};

/** The pose's own axes: forward toward its aim, then right and up against world up (the same convention `applyCameraPose` produces, roll excluded, so a drag reads the way the frame looks). */
export function rigBasis(pose: SceneDocRigPose): {
  forward: V3;
  right: V3;
  up: V3;
  distance: number;
} {
  const delta = sub(pose.aim.at, pose.position);
  const distance = len(delta);
  const forward = unit(delta) ?? [0, 0, -1];
  const worldUp: V3 = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const right = unit(cross(forward, worldUp)) ?? [1, 0, 0];
  return { forward, right, up: cross(right, forward), distance: distance || 1 };
}

/** World units per stage pixel at the pose's aim distance: the scale a view-plane drag converts through. */
export function rigWorldPerPixel(pose: SceneDocRigPose, fovDeg: number, stageH: number): number {
  if (stageH <= 0) return 0;
  const { distance } = rigBasis(pose);
  return (2 * Math.tan(fovDeg * DEG2RAD * 0.5) * distance) / stageH;
}

/** Translate the camera in its own view plane, grab-style (content follows the pointer, so the camera goes the other way). A point or object aim HOLDS, so moving reframes what's already in shot; a tangent aim has no fixed target, so it travels with the camera. */
export function moveRigPose(
  pose: SceneDocRigPose,
  dxPx: number,
  dyPx: number,
  fovDeg: number,
  stageH: number,
): SceneDocRigPose {
  const { right, up } = rigBasis(pose);
  const perPx = rigWorldPerPixel(pose, fovDeg, stageH);
  const wx = -dxPx * perPx;
  const wy = dyPx * perPx;
  const shift: V3 = [
    right[0] * wx + up[0] * wy,
    right[1] * wx + up[1] * wy,
    right[2] * wx + up[2] * wy,
  ];
  const position: V3 = [
    pose.position[0] + shift[0],
    pose.position[1] + shift[1],
    pose.position[2] + shift[2],
  ];
  if (pose.aim.mode !== "tangent") return { ...pose, position, aim: { ...pose.aim } };
  return {
    ...pose,
    position,
    aim: {
      ...pose.aim,
      at: [pose.aim.at[0] + shift[0], pose.aim.at[1] + shift[1], pose.aim.at[2] + shift[2]],
    },
  };
}

/** Dolly along the view axis. The travel is exponential like orbit's zoom, so a drag feels the same close in and far out, and it stops at an aim-distance floor rather than sliding through the subject. */
export function forwardRigPose(
  pose: SceneDocRigPose,
  dyPx: number,
  stageH: number,
): SceneDocRigPose {
  if (stageH <= 0) return pose;
  const { forward, distance } = rigBasis(pose);
  const next = Math.min(
    MAX_AIM_DISTANCE,
    Math.max(MIN_AIM_DISTANCE, distance * Math.exp((dyPx / stageH) * FORWARD_EXP)),
  );
  const travel = distance - next;
  const position: V3 = [
    pose.position[0] + forward[0] * travel,
    pose.position[1] + forward[1] * travel,
    pose.position[2] + forward[2] * travel,
  ];
  if (pose.aim.mode !== "tangent") return { ...pose, position, aim: { ...pose.aim } };
  return {
    ...pose,
    position,
    aim: {
      ...pose.aim,
      at: [
        pose.aim.at[0] + forward[0] * travel,
        pose.aim.at[1] + forward[1] * travel,
        pose.aim.at[2] + forward[2] * travel,
      ],
    },
  };
}

/** Swing the aim about the camera (the camera itself doesn't move). Pitch clamps at LOOK_PITCH_LIMIT. The visible consequence is deliberate: looking somewhere new makes the aim a POINT, so the inspector's aim row flips off tangent or a binding. */
export function lookRigPose(
  pose: SceneDocRigPose,
  dxPx: number,
  dyPx: number,
  stageW: number,
  stageH: number,
): SceneDocRigPose {
  if (stageW <= 0 || stageH <= 0) return pose;
  const { forward, distance } = rigBasis(pose);
  const azimuth = Math.atan2(forward[0], forward[2]) * RAD2DEG - (dxPx / stageW) * 200;
  const pitch = Math.min(
    LOOK_PITCH_LIMIT,
    Math.max(
      -LOOK_PITCH_LIMIT,
      Math.asin(Math.min(1, Math.max(-1, forward[1]))) * RAD2DEG - (dyPx / stageH) * 120,
    ),
  );
  const az = azimuth * DEG2RAD;
  const el = pitch * DEG2RAD;
  const cosEl = Math.cos(el);
  return {
    ...pose,
    aim: {
      mode: "point",
      at: [
        pose.position[0] + distance * cosEl * Math.sin(az),
        pose.position[1] + distance * Math.sin(el),
        pose.position[2] + distance * cosEl * Math.cos(az),
      ],
    },
  };
}

/** Bank the frame. A full stage width is TILT_DEG_PER_STAGE, clamped to a half turn each way; a roll that lands exactly on zero drops the field, so the pose stays legacy-shaped. */
export function tiltRigPose(pose: SceneDocRigPose, dxPx: number, stageW: number): SceneDocRigPose {
  if (stageW <= 0) return pose;
  const roll = Math.min(
    MAX_ROLL_DEG,
    Math.max(MAX_ROLL_DEG * -1, (pose.rollDeg ?? 0) + (dxPx / stageW) * TILT_DEG_PER_STAGE),
  );
  const next: SceneDocRigPose = { ...pose, aim: { ...pose.aim }, rollDeg: roll };
  if (roll === 0) delete next.rollDeg;
  return next;
}
