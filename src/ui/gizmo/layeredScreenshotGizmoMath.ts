import { type Camera, type Object3D, Vector3 } from "three";
import type { StageRect } from "../../engine/gizmoRegistry";
import type { LayeredScreenshotPlacement } from "../../engine/sceneDocSchema";
import { resolveLayeredScreenshotPlacement } from "../../engine/sceneLayeredScreenshot";
import type { Gizmo2DFrame } from "./gizmo2dMath";
import { projectWorldPoint } from "./gizmo2dProject";

export function screenshotStackPlacementWrite(
  placement: LayeredScreenshotPlacement,
): LayeredScreenshotPlacement {
  return resolveLayeredScreenshotPlacement({
    position: placement.position.map((value) => Number(value.toFixed(2))),
    size: Number(placement.size.toFixed(2)),
    rotationDeg: Number((((((placement.rotationDeg + 180) % 360) + 360) % 360) - 180).toFixed(1)),
  });
}

export function screenshotStackFrame(
  node: Object3D,
  points: ReadonlyArray<readonly [number, number, number]>,
  camera: Camera,
  rect: StageRect,
): Gizmo2DFrame | null {
  if (points.length === 0) return null;
  node.updateWorldMatrix(true, false);
  const project = (point: Vector3) =>
    projectWorldPoint(camera, rect, point.applyMatrix4(node.matrixWorld));
  const pivot = project(new Vector3());
  const axis = project(new Vector3(1, 0, 0));
  const angle = Math.atan2(axis[1] - pivot[1], axis[0] - pivot[0]);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const projected = points.map((point) => {
    const [x, y] = project(new Vector3(...point));
    return [
      cos * (x - pivot[0]) + sin * (y - pivot[1]),
      -sin * (x - pivot[0]) + cos * (y - pivot[1]),
    ];
  });
  const xs = projected.map(([x]) => x);
  const ys = projected.map(([, y]) => y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  const frame = {
    cx: pivot[0] + cos * x - sin * y,
    cy: pivot[1] + sin * x + cos * y,
    w: right - left,
    h: bottom - top,
    deg: (angle * 180) / Math.PI,
    pivot,
  };
  return [frame.cx, frame.cy, frame.w, frame.h, frame.deg].every(Number.isFinite) ? frame : null;
}
