import { Matrix4, type Object3D, type PerspectiveCamera, Vector3 } from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { LightSpace, Placement } from "../theme/tokens";
import type { CameraPose } from "./cameraTrack";
import { placementPosition } from "./orbit";

/** Camera/subject-space lights, resolved at the compositor seam (mirrors sceneState.ts). A registry of mounted relative lights (populated by the stage's light components) plus `applyRelativeLights(camera, pose)`, called at EACH of renderComposited's four camera-apply sites immediately after the camera pose lands and before `gl.render`. On a transition frame targets A and B use different cameras, so each target resolves its own transforms; resolving anywhere else (a React effect, a shared "current camera") produces the bug that appears only on transition frames. An empty registry is a hard no-op, the null-for-legacy path.

Space conventions (the question this docstring exists to answer):
- `camera`: placement coordinates live in the camera's frame (x right, y up, -z forward); the light rides the camera rigidly. Azimuth 0 / elevation 0 sits on the camera's +Z axis, BEHIND the lens, so a rim light typically wants elevation/azimuth off-axis or a point placement like [1, 0.5, -2].
- `subject`: origin is the applied pose's look-at point (the scene subject; world origin when no pose is known, matching the base camera). Azimuth 0 points from the subject TOWARD the camera, so azimuth 0 / elevation 0 is a frontal key that follows the camera around the subject; +azimuth swings toward the camera's right. The frame is yaw-only (world +Y up), so subject lights never roll with a tilted camera. */

let rectAreaInitDone = false;

/** LTC uniforms for RectAreaLight: initialised once at renderer creation (App's onCreated), never lazily on a first light, which would race the export preamble. Global, idempotent, safe without any area light mounted. */
export function ensureRectAreaLightUniforms(): void {
  if (rectAreaInitDone) return;
  RectAreaLightUniformsLib.init();
  rectAreaInitDone = true;
}

export interface RelativeLightSpec {
  space: Exclude<LightSpace, "world">;
  placement: Placement;
  /** Aim point in the light's own space. Absent when the author set no `target`, which aims at the SUBJECT instead of at the space's own origin. That distinction only bites `camera` space, and it bites hard: the camera-space origin IS the camera, so a defaulted aim points every rim light backwards at the lens and lights nothing. World space already has its origin at the subject and subject space is defined by it, so this makes all three spaces agree that no target means aim at the thing. */
  target?: [number, number, number];
}

interface RelativeLightEntry {
  /** The mounted light (assumed world-parented; SceneStage mounts lights at the scene root). */
  object: Object3D;
  /** The light's `.target` Object3D for directional/spot, positioned here per render target; null for point lights. Area lights aim via `lookAt` instead (`aimSelf`). */
  targetObject: Object3D | null;
  /** True for area lights: orient the light itself at the aim point (RectAreaLight has no target). */
  aimSelf: boolean;
  /** True for fixtures: the whole group also takes the space's rotation, so a camera-space fixture rides the camera rigidly rather than translating only. */
  orient?: boolean;
  spec: RelativeLightSpec;
}

const entries = new Map<string, RelativeLightEntry>();

/** Register a mounted relative light; returns the unregister cleanup (the stage registry idiom). */
export function registerRelativeLight(key: string, entry: RelativeLightEntry): () => void {
  entries.set(key, entry);
  return () => {
    entries.delete(key);
  };
}

/** Exposed for the no-op fast path and tests. */
export function relativeLightCount(): number {
  return entries.size;
}

const _basis = new Matrix4();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _origin = new Vector3();
const _pos = new Vector3();
const _aim = new Vector3();
const _camPos = new Vector3();

const WORLD_UP = new Vector3(0, 1, 0);

/** Recompute every registered relative light's transform from the camera applied for THIS render target. `pose` is the applied CameraPose when the frame has a camera plan (its lookAt is the subject); null on the legacy path, where the subject falls back to the world origin. Transforms are plain writes recomputed per target per frame; nothing accumulates and nothing persists (a pure function of camera + spec). */
export function applyRelativeLights(camera: PerspectiveCamera, pose: CameraPose | null): void {
  if (entries.size === 0) return;
  camera.updateMatrixWorld();
  _camPos.setFromMatrixPosition(camera.matrixWorld);
  // The subject, in world space: the applied pose's look-at, or the origin on the legacy path.
  // Both the subject basis and every defaulted aim resolve from it.
  _origin.set(...(pose ? pose.lookAt : ([0, 0, 0] as [number, number, number])));

  for (const { object, targetObject, aimSelf, orient, spec } of entries.values()) {
    if (spec.space === "camera") {
      // The camera's own frame, rigid: local placement coordinates map through matrixWorld.
      _basis.copy(camera.matrixWorld);
    } else {
      // Subject frame: origin at the pose's look-at, z toward the camera, yaw-only (world up).
      _z.copy(_camPos).sub(_origin);
      if (_z.lengthSq() < 1e-10) _z.set(0, 0, 1);
      _z.normalize();
      // Degenerate straight-down/up view: fall back to world z so the frame stays defined.
      if (Math.abs(_z.dot(WORLD_UP)) > 0.9999) {
        _x.set(1, 0, 0);
        _y.crossVectors(_z, _x).normalize();
        _x.crossVectors(_y, _z).normalize();
      } else {
        _x.crossVectors(WORLD_UP, _z).normalize();
        _y.crossVectors(_z, _x).normalize();
      }
      _basis.makeBasis(_x, _y, _z).setPosition(_origin);
    }

    _pos.set(...placementPosition(spec.placement, spec.target)).applyMatrix4(_basis);
    // An explicit target reads in the light's own space; a defaulted one is the subject in WORLD
    // space, so a camera-space rim aims at the product rather than back at the lens.
    if (spec.target) _aim.set(...spec.target).applyMatrix4(_basis);
    else _aim.copy(_origin);
    object.position.copy(_pos);
    if (orient) object.quaternion.setFromRotationMatrix(_basis);
    if (targetObject) {
      targetObject.position.copy(_aim);
      targetObject.updateMatrixWorld();
    } else if (aimSelf) {
      object.updateMatrixWorld();
      object.lookAt(_aim);
    }
    object.updateMatrixWorld();
  }
}
