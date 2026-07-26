/** World point -> stage pixel, as a pure RECOMPUTE of the applied pose rather than a read of the live camera. That is the whole point: the ghost path overlay stays DOM above the canvas with no r3f bridge, and nothing it draws can ever reach the export. Mirrors what `applyCameraPose` writes onto the camera (lookAt with a world up, then the optional roll `rotateZ`), so a projected key lands where that key renders. */
import type { CameraPose } from "./cameraTrack";

type V3 = readonly [number, number, number];

const DEG2RAD = Math.PI / 180;
/** Points closer than this to the camera plane have no stable screen position. */
const NEAR = 1e-4;
const WORLD_UP: V3 = [0, 1, 0];
/** Fallback up when the view direction is parallel to world up (looking straight down a pole). */
const FALLBACK_UP: V3 = [0, 0, 1];

const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v: V3): [number, number, number] | null => {
  const l = Math.sqrt(dot(v, v));
  return l < NEAR ? null : [v[0] / l, v[1] / l, v[2] / l];
};

/** The camera's orthonormal basis: `z` points BACK along the view (three's convention, the camera looks down its own -Z), `x` right, `y` up, with roll already folded in. */
export interface ViewBasis {
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
}

export function viewBasis(pose: CameraPose): ViewBasis {
  const back = norm(sub(pose.position, pose.lookAt)) ?? [0, 0, 1];
  const up = Math.abs(dot(back, WORLD_UP)) > 1 - 1e-6 ? FALLBACK_UP : WORLD_UP;
  const right = norm(cross(up, back)) ?? [1, 0, 0];
  const trueUp = cross(back, right);
  if (!pose.rollDeg) return { x: right, y: trueUp, z: back };
  // `camera.rotateZ(a)` turns the camera about its own view axis; the basis turns with it.
  const a = pose.rollDeg * DEG2RAD;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return {
    x: [right[0] * c + trueUp[0] * s, right[1] * c + trueUp[1] * s, right[2] * c + trueUp[2] * s],
    y: [trueUp[0] * c - right[0] * s, trueUp[1] * c - right[1] * s, trueUp[2] * c - right[2] * s],
    z: back,
  };
}

export interface StageRect {
  width: number;
  height: number;
}

export interface ProjectedPoint {
  /** Stage pixels from the rect's top-left. */
  x: number;
  y: number;
  /** True when the point sits at or behind the camera plane: `x`/`y` are then a clamped edge direction, never a real position, and the overlay draws an edge marker instead of a dot. */
  clipped: boolean;
  /** Distance along the view axis; negative behind the camera. */
  depth: number;
}

/** How far off-stage a clipped point is pushed, in multiples of the rect, so an edge marker clamps somewhere sane. */
const CLIP_PUSH = 4;

/** Project a world point into stage pixels under `pose`. `aspect` is the RENDERED frame's aspect, which is also the stage rect's (the preview letterboxes to it). */
export function projectToStage(
  world: V3,
  pose: CameraPose,
  stage: StageRect,
  aspect = stage.height > 0 ? stage.width / stage.height : 1,
): ProjectedPoint {
  const basis = viewBasis(pose);
  const v = sub(world, pose.position);
  const depth = -dot(v, basis.z);
  const tanHalf = Math.tan(pose.fov * DEG2RAD * 0.5);
  const px = dot(v, basis.x);
  const py = dot(v, basis.y);
  if (depth <= NEAR) {
    // Behind the camera: keep the lateral SIGN so the marker still points the right way off-stage.
    const dir = Math.sign(px) || 1;
    return {
      x: stage.width * (0.5 + dir * CLIP_PUSH),
      y: stage.height * 0.5,
      clipped: true,
      depth,
    };
  }
  const ndcX = px / (depth * tanHalf * aspect);
  const ndcY = py / (depth * tanHalf);
  return {
    x: (ndcX * 0.5 + 0.5) * stage.width,
    y: (0.5 - ndcY * 0.5) * stage.height,
    clipped: false,
    depth,
  };
}

/** World units per stage pixel at `depth` under `pose`: the scale every view-plane drag (the Move tool, the path overlay's key dots) converts its pixel delta through. */
export function worldPerPixel(pose: CameraPose, stageHeight: number, depth: number): number {
  if (stageHeight <= 0) return 0;
  return (2 * Math.tan(pose.fov * DEG2RAD * 0.5) * Math.max(NEAR, depth)) / stageHeight;
}

/** Clamp a projected point onto the stage edge, for the marker a behind-camera or far off-stage key draws instead of a dot. */
export function clampToStage(point: ProjectedPoint, stage: StageRect, inset = 10): ProjectedPoint {
  return {
    ...point,
    x: Math.min(stage.width - inset, Math.max(inset, point.x)),
    y: Math.min(stage.height - inset, Math.max(inset, point.y)),
  };
}
