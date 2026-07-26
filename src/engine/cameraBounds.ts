/** Advisory: does this camera pose still see only staged surface? Pure, and built on the REAL golden-pinned staging constants rather than retyped guesses, so it stays honest when they move. Advisory is the whole contract: it never blocks an edit and never clamps a pose, because flying past the set is a legitimate shot as often as it is a mistake. A scene that stages nothing has nothing to warn about. */

import type { ThemeBackdrop } from "../theme/tokens";
import {
  BACKDROP_HEIGHT,
  BACKDROP_WIDTH,
  BACKDROP_Z,
  CYC_FRONT_Z,
  CYC_WALL_HEIGHT,
  CYC_WALL_Z,
  CYC_WIDTH,
  DEFAULT_FLOOR_Y,
} from "../toolkit/stage/backdrops";
import { viewBasis } from "./cameraProject";
import type { CameraPose } from "./cameraTrack";
import type { SceneDoc } from "./sceneDocSchema";

/** The video window's backing stage is oversized by this factor (`toolkit/media/VideoWindow.tsx`), which is what buys it a limited orbit before the edge shows. */
const VIDEO_WINDOW_OVERSCAN = 2;

export interface BoundsVerdict {
  ok: boolean;
  /** One short sentence naming what would come into frame; absent when ok. */
  reason?: string;
}

const OK: BoundsVerdict = { ok: true };

type V3 = readonly [number, number, number];

const DEG2RAD = Math.PI / 180;

/** Half-extents of the frustum at `depth`, in world units. */
function frustumHalf(pose: CameraPose, aspect: number, depth: number): { w: number; h: number } {
  const h = Math.tan(pose.fov * DEG2RAD * 0.5) * Math.max(0, depth);
  return { w: h * aspect, h };
}

/** Where the view axis crosses a plane at constant z, and how far along the axis that is; null when the camera looks away from it. */
function hitPlaneZ(
  pose: CameraPose,
  z: number,
): { at: [number, number, number]; depth: number } | null {
  const basis = viewBasis(pose);
  // The view direction is -z of the basis.
  const dz = -basis.z[2];
  const dx = -basis.z[0];
  const dy = -basis.z[1];
  if (Math.abs(dz) < 1e-6) return null;
  const t = (z - pose.position[2]) / dz;
  if (t <= 0) return null;
  return { at: [pose.position[0] + dx * t, pose.position[1] + dy * t, z], depth: t };
}

/** Is the camera itself inside the cyclorama volume? Outside it, the shot looks at the set from behind, which no framing check can rescue. */
function insideCyc(position: V3, floorY: number): boolean {
  return (
    Math.abs(position[0]) < CYC_WIDTH / 2 &&
    position[2] > CYC_WALL_Z &&
    position[2] < CYC_FRONT_Z &&
    position[1] > floorY &&
    position[1] < floorY + CYC_WALL_HEIGHT
  );
}

/** Does a ray from the camera land on cyclorama surface? The cyc is a floor swept into a back wall, so a ray must hit ONE of the two: a plane test against either alone would call the base pose out of bounds, because its lower frame edge is meant to land on the floor. The fillet joining them is covered by the wall test, which accepts down to floor level. */
function cycRayHits(origin: V3, dir: V3, floorY: number): boolean {
  if (dir[2] < 0) {
    const t = (CYC_WALL_Z - origin[2]) / dir[2];
    if (t > 0) {
      const x = origin[0] + dir[0] * t;
      const y = origin[1] + dir[1] * t;
      if (Math.abs(x) <= CYC_WIDTH / 2 && y >= floorY && y <= floorY + CYC_WALL_HEIGHT) return true;
    }
  }
  if (dir[1] < 0) {
    const t = (floorY - origin[1]) / dir[1];
    if (t > 0) {
      const x = origin[0] + dir[0] * t;
      const z = origin[2] + dir[2] * t;
      if (Math.abs(x) <= CYC_WIDTH / 2 && z >= CYC_WALL_Z && z <= CYC_FRONT_Z) return true;
    }
  }
  return false;
}

/** The four frame-corner directions in world space. */
function cornerRays(pose: CameraPose, aspect: number): [number, number, number][] {
  const basis = viewBasis(pose);
  const h = Math.tan(pose.fov * DEG2RAD * 0.5);
  const w = h * aspect;
  const rays: [number, number, number][] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      rays.push([
        -basis.z[0] + basis.x[0] * w * sx + basis.y[0] * h * sy,
        -basis.z[1] + basis.x[1] * w * sx + basis.y[1] * h * sy,
        -basis.z[2] + basis.x[2] * w * sx + basis.y[2] * h * sy,
      ]);
    }
  }
  return rays;
}

function checkPlane(
  pose: CameraPose,
  aspect: number,
  z: number,
  halfW: number,
  bottomY: number,
  topY: number,
  surface: string,
): BoundsVerdict {
  const hit = hitPlaneZ(pose, z);
  if (!hit) return { ok: false, reason: `The camera looks away from the ${surface}.` };
  const half = frustumHalf(pose, aspect, hit.depth);
  if (Math.abs(hit.at[0]) + half.w > halfW) {
    return { ok: false, reason: `The ${surface}'s side edge comes into frame.` };
  }
  if (hit.at[1] + half.h > topY) {
    return { ok: false, reason: `The ${surface}'s top edge comes into frame.` };
  }
  if (hit.at[1] - half.h < bottomY) {
    return { ok: false, reason: `The frame drops below the ${surface}.` };
  }
  return OK;
}

/** The scene's staged surface, if any: the scene doc's own backdrop first, then the theme's. */
export function stagedBackdrop(
  doc: SceneDoc | undefined,
  themeBackdrop?: ThemeBackdrop,
): ThemeBackdrop | undefined {
  const backdrop = doc?.backdrop ?? themeBackdrop;
  return backdrop && backdrop.type !== "none" ? backdrop : undefined;
}

/** Check one applied pose against whatever the scene stages. Rules, in order: a scene laid out in depth bands (nothing to check, it sizes itself), a video window's oversized stage plane, a cyclorama floor, then a vertical backdrop plane. Nothing staged is always ok. */
export function checkCameraBounds(
  pose: CameraPose,
  aspect: number,
  doc: SceneDoc | undefined,
  themeBackdrop?: ThemeBackdrop,
  banded = false,
): BoundsVerdict {
  // A DepthStage scene sizes every band from the camera's own travel envelope, so its keys pass
  // by construction; warning about them would be noise.
  if (banded) return OK;
  if (doc?.videoWindow) {
    // The stage plane sits at the content plane, oversized by the overscan factor; the base frame at the base distance is the unit it is oversized against.
    const baseHalf = frustumHalf({ ...pose, fov: 45 }, aspect, 5);
    return checkPlane(
      pose,
      aspect,
      0,
      baseHalf.w * VIDEO_WINDOW_OVERSCAN,
      -baseHalf.h * VIDEO_WINDOW_OVERSCAN,
      baseHalf.h * VIDEO_WINDOW_OVERSCAN,
      "video window's backing stage",
    );
  }
  const backdrop = stagedBackdrop(doc, themeBackdrop);
  if (!backdrop) return OK;
  if (backdrop.type === "floor") {
    const floorY = DEFAULT_FLOOR_Y;
    if (!insideCyc(pose.position, floorY)) {
      return { ok: false, reason: "The camera sits outside the staged cyclorama." };
    }
    const covered = cornerRays(pose, aspect).every((dir) => cycRayHits(pose.position, dir, floorY));
    return covered ? OK : { ok: false, reason: "The cyclorama's edge comes into frame." };
  }
  return checkPlane(
    pose,
    aspect,
    BACKDROP_Z,
    BACKDROP_WIDTH / 2,
    -BACKDROP_HEIGHT / 2,
    BACKDROP_HEIGHT / 2,
    "backdrop",
  );
}
