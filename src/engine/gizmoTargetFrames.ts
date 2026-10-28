import { type Camera, type Object3D, type PerspectiveCamera, Vector3 } from "three";
import { CAMERA } from "./format";
import { getFramePanels } from "./framePanelRegistry";
import { gizmoTargets } from "./gizmoTargetRegistry";
import { nodeDrawn } from "./gizmoVisibility";
import type { CameraFrame, Gizmo2DTargetFrame } from "./stageProtocol";

/** The 2D gizmo targets as plain data for a window's chrome: every registered target's local rect through its world matrix (world space and, for a world item, NDC through `camera`), whether it is drawn, whether it sits inside an overlay panel. Computed where the nodes live (the stage worker after each frame, or a realm with its own canvas) and read by the gizmo hosts, which never touch a node. */

const _v = new Vector3();

export function projectGizmoTargets(camera: Camera): Gizmo2DTargetFrame[] {
  const panels = getFramePanels();
  const targets: Gizmo2DTargetFrame[] = [];
  for (const t of gizmoTargets()) {
    const node = t.node();
    // A stack publishes depth points instead of a rect; its box comes from those.
    const local = t.localRect() ?? (t.localPoints ? ([0, 0, 0, 0] as const) : null);
    if (!node || !local) continue;
    let panel: Object3D | null = null;
    for (let o: Object3D | null = node; o; o = o.parent) {
      if (panels.some((p) => p.group === o)) {
        panel = o;
        break;
      }
    }
    node.updateWorldMatrix(true, false);
    const m = node.matrixWorld;
    const [minX, minY, maxX, maxY] = local;
    const pts: [number, number][] = [
      [minX, maxY],
      [maxX, maxY],
      [maxX, minY],
      [minX, minY],
      [0, 0],
    ];
    const world = pts.map(([x, y]) => {
      _v.set(x, y, 0).applyMatrix4(m);
      return [_v.x, _v.y, _v.z] as [number, number, number];
    });
    const ndc = panel
      ? undefined
      : world.map(([x, y, z]) => {
          _v.set(x, y, z).project(camera);
          return [_v.x, _v.y] as [number, number];
        });
    const worldPoints = t.localPoints?.()?.map(([x, y, z]) => {
      _v.set(x, y, z).applyMatrix4(m);
      return [_v.x, _v.y, _v.z] as [number, number, number];
    });
    targets.push({
      key: `${t.domain}:${t.sceneIndex}:${t.itemId}:${t.side ?? "a"}:${targets.length}`,
      domain: t.domain,
      sceneIndex: t.sceneIndex,
      itemId: t.itemId,
      ...(t.side ? { side: t.side } : {}),
      // The compositor leaves a panel group hidden between its passes, so its own subtree is judged below it.
      drawn: nodeDrawn(node, panel),
      panel: panel !== null,
      world,
      ...(ndc ? { ndc } : {}),
      ...(worldPoints ? { worldPoints } : {}),
      matrixWorld: m.toArray(),
      ...(node.parent ? { parentWorld: node.parent.matrixWorld.toArray() } : {}),
    });
  }
  return targets;
}

export function cameraFrameOf(camera: Camera): CameraFrame {
  const cam = camera as PerspectiveCamera;
  return {
    matrixWorld: camera.matrixWorld.toArray(),
    projectionMatrix: camera.projectionMatrix.toArray(),
    projectionMatrixInverse: camera.projectionMatrixInverse.toArray(),
    fov: cam.isPerspectiveCamera ? cam.fov : CAMERA.fov,
    aspect: cam.isPerspectiveCamera ? cam.aspect : 1,
  };
}
