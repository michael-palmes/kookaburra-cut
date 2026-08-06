import type { Camera, Object3D } from "three";
import { Vector3 } from "three";
import type { StageRect } from "../../engine/gizmoRegistry";
import { ndcToStagePx, type Pt, rayPlaneZ, stagePxToNdc } from "./gizmo2dMath";

/** The two world-to-stage-pixel maps a 2D gizmo host can need. World-space items (scene text, hero charts) project through the LIVE camera, so a box tracks a rig pose, a keyframe and a transition; overlay-panel items are drawn from the base pose against the full frame, which is a fixed linear map. Drags invert through a ray-plane intersection, exact under any pose. */

const _v = new Vector3();
const _origin = new Vector3();

export function projectWorldPoint(camera: Camera, rect: StageRect, world: Vector3): Pt {
  const ndc = _v.copy(world).project(camera);
  return ndcToStagePx([ndc.x, ndc.y], rect);
}

/** The node's local rect `[minX, minY, maxX, maxY]` through its world matrix, as the four projected corners (top-left, top-right, bottom-right, bottom-left in local terms) plus the projected node origin, which is the item's rotate and resize pivot. */
export function worldQuadOf(
  node: Object3D,
  local: readonly [number, number, number, number],
  toPx: (world: Vector3) => Pt,
): { quad: [Pt, Pt, Pt, Pt]; pivot: Pt } {
  node.updateWorldMatrix(true, false);
  const m = node.matrixWorld;
  const [minX, minY, maxX, maxY] = local;
  const at = (x: number, y: number): Pt => toPx(_origin.set(x, y, 0).applyMatrix4(m));
  return {
    quad: [at(minX, maxY), at(maxX, maxY), at(maxX, minY), at(minX, minY)],
    pivot: at(0, 0),
  };
}

/** Client pixels back to the world point on a given z plane; null outside the stage or when the ray misses. */
export function unprojectToZPlane(
  camera: Camera,
  rect: StageRect,
  px: Pt,
  z: number,
): [number, number, number] | null {
  const ndc = stagePxToNdc(px, rect);
  if (!ndc) return null;
  const on = _v.set(ndc[0], ndc[1], 0.5).unproject(camera);
  camera.getWorldPosition(_origin);
  return rayPlaneZ(
    [_origin.x, _origin.y, _origin.z],
    [on.x - _origin.x, on.y - _origin.y, on.z - _origin.z],
    z,
  );
}

/** Overlay-panel world units to client pixels: the panel lays out against the full frame and draws from the base pose, so this is exact. */
export function panelToStagePx(
  world: Pt,
  frame: { width: number; height: number },
  rect: StageRect,
): Pt {
  return [
    rect.left + (0.5 + world[0] / frame.width) * rect.width,
    rect.top + (0.5 - world[1] / frame.height) * rect.height,
  ];
}

/** The inverse of `panelToStagePx`, for a panel-space drag delta. */
export function stagePxToPanelWorld(
  px: Pt,
  frame: { width: number; height: number },
  rect: StageRect,
): Pt | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return [
    ((px[0] - rect.left) / rect.width - 0.5) * frame.width,
    (0.5 - (px[1] - rect.top) / rect.height) * frame.height,
  ];
}
