import { useSyncExternalStore } from "react";
import { type Camera, Matrix4, Vector3 } from "three";
import { type StageRect, stageCamera } from "../../engine/gizmoRegistry";
import { projectGizmoTargets } from "../../engine/gizmoTargetFrames";
import { subscribeGizmoTargets } from "../../engine/gizmoTargetRegistry";
import { stageOrNull } from "../../engine/stageHandle";
import type { Gizmo2DTargetFrame } from "../../engine/stageProtocol";
import { frameFromQuad, type Gizmo2DFrame, ndcToStagePx, type Pt } from "./gizmo2dMath";
import { panelToStagePx, projectWorldPoint } from "./gizmo2dProject";

/** The 2D gizmo hosts' view of the stage: the targets the worker projected after its last frame (world points, NDC through the live camera, the drawn and panel flags), read through one store so a host re-renders once per posted frame. */

const NO_TARGETS: Gizmo2DTargetFrame[] = [];

/** Without a stage (a realm with its own canvas), the registry's nodes project here through the live camera, recomputed per animation frame like the layer's own loop. */
function subscribeLocal(listener: () => void): () => void {
  let raf = 0;
  const off = subscribeGizmoTargets(listener);
  const tick = () => {
    listener();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    off();
    cancelAnimationFrame(raf);
  };
}

let localCache: { json: string; targets: Gizmo2DTargetFrame[] } | null = null;
function localTargets(): Gizmo2DTargetFrame[] {
  const camera = stageCamera();
  if (!camera) return NO_TARGETS;
  const targets = projectGizmoTargets(camera);
  const json = JSON.stringify(targets);
  if (localCache?.json === json) return localCache.targets;
  localCache = { json, targets };
  return targets;
}

export function useStageTargets(): Gizmo2DTargetFrame[] {
  const stage = stageOrNull();
  return useSyncExternalStore(stage ? stage.subscribeFrame : subscribeLocal, () =>
    stage ? stage.frame().targets : localTargets(),
  );
}

/** The target's box in client pixels: a panel item maps its world x/y linearly against the frame, a world item lands where the live camera put it (`viewport` is the world's rect, the cutout-corrected canvas box). */
export function stageTargetFrame(
  target: Gizmo2DTargetFrame,
  viewport: StageRect,
  frame: { width: number; height: number },
): { frame: Gizmo2DFrame; worldZ: number } | null {
  if (!target.drawn) return null;
  const pivotWorld = target.world[4];
  let quad: Pt[];
  let pivot: Pt;
  if (target.panel) {
    const px = (w: [number, number, number]) => panelToStagePx([w[0], w[1]], frame, viewport);
    quad = target.world.slice(0, 4).map(px);
    pivot = px(pivotWorld);
  } else {
    if (!target.ndc) return null;
    quad = target.ndc.slice(0, 4).map((n) => ndcToStagePx(n, viewport));
    pivot = ndcToStagePx(target.ndc[4], viewport);
  }
  return {
    frame: frameFromQuad(quad as [Pt, Pt, Pt, Pt], pivot),
    worldZ: target.panel ? 0 : pivotWorld[2],
  };
}

const _v = new Vector3();
const _m = new Matrix4();

/** A screenshot stack's box from its depth-aware world points, rotated with the node's own x axis on screen. */
export function stageStackFrame(
  target: Gizmo2DTargetFrame,
  camera: Camera,
  viewport: StageRect,
): Gizmo2DFrame | null {
  const points = target.worldPoints;
  if (!points || points.length === 0 || !target.drawn) return null;
  _m.fromArray(target.matrixWorld);
  const project = (point: Vector3) => projectWorldPoint(camera, viewport, point);
  const pivot = project(_v.set(0, 0, 0).applyMatrix4(_m).clone());
  const axis = project(_v.set(1, 0, 0).applyMatrix4(_m).clone());
  const angle = Math.atan2(axis[1] - pivot[1], axis[0] - pivot[0]);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const projected = points.map((point) => {
    const [x, y] = project(_v.set(point[0], point[1], point[2]).clone());
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

/** The inverse of the node's parent world matrix (identity for a root), for a drag delta in the parent's space. */
export function stageParentInverse(target: Gizmo2DTargetFrame): Matrix4 {
  const m = new Matrix4();
  if (target.parentWorld) m.fromArray(target.parentWorld).invert();
  return m;
}
