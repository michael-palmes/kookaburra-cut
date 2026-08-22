import { type Camera, type Object3D, Raycaster, Vector2 } from "three";
import { canvasHandle } from "./exportBridge";
import type { GizmoMode } from "./gizmoMode";

/** Live handles onto each mounted gizmo's pickable geometry, published by `<SceneGizmo>` (the sceneHostRegistry idiom: a module Map, plain register/read functions, no store). DOM overlays read it to decide whether a pointer belongs to a gizmo handle or to them; the export path never imports it. */

/** Which inspector section owns a gizmo. */
export type GizmoDomain = "objects" | "chart" | "devices" | "images" | "text" | "decorations";

/** The canvas box in client pixels, as a plain object so the routing maths stays node-testable. */
export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GizmoPickerHandle {
  domain: GizmoDomain;
  /** Scene-scoped item id ("o1", "d2", or "chart" for the one-per-scene chart). */
  itemId: string;
  sceneIndex: number;
  /** Raycast targets for the ACTIVE mode only: three's Raycaster ignores `visible`, so the idle modes' pickers would hit too. */
  pickers: () => Object3D[];
  /** The control itself, so a preview capture can drop the handles for its one frame; they draw on layer 0, which no camera filter reaches. */
  root?: () => Object3D | null;
  /** Called once when the router hands a pointer-down to this gizmo. */
  claim?: () => void;
}

// Keyed by a per-instance id (React useId), the sceneHostRegistry rule: a project swap's mount churn can't clobber entries by index.
const handles = new Map<string, GizmoPickerHandle>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function registerGizmoPicker(key: string, handle: GizmoPickerHandle): void {
  handles.set(key, handle);
  notify();
}

export function unregisterGizmoPicker(key: string): void {
  if (handles.delete(key)) notify();
}

export function gizmoPickerHandles(): GizmoPickerHandle[] {
  return [...handles.values()];
}

/** Fires whenever the pickable set changes. Readers cache their hover truth off pointer moves, and a gizmo mounts or unmounts with the pointer parked, so they must re-test on this. */
export function subscribeGizmoPickers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hides every mounted gizmo and returns the restore, so a preview capture (scene thumbs, welcome snapshots) renders its frame without editor chrome. The control manages its own `visible`, so the previous value goes back rather than a blanket true. */
export function hideGizmoHandles(): () => void {
  const roots: Object3D[] = [];
  for (const handle of handles.values()) {
    const root = handle.root?.();
    if (root) roots.push(root);
  }
  const was = roots.map((o) => o.visible);
  for (const root of roots) root.visible = false;
  return () => {
    roots.forEach((root, i) => {
      root.visible = was[i];
    });
  };
}

/** The live preview camera, i.e. the pose the last rendered frame applied (rig, keyframes and beat sync included). */
export function stageCamera(): Camera | null {
  return canvasHandle.current?.camera ?? null;
}

/** The canvas box, not an overlay's, so the NDC computed from it is the input r3f's own event raycaster would use. */
export function stageCanvasRect(): StageRect | null {
  const el = canvasHandle.current?.gl.domElement;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

const raycaster = new Raycaster();
const pointer = new Vector2();

/** The registered handle whose picker geometry sits under these NDC coordinates, else null. */
export function gizmoHandleAt(ndcX: number, ndcY: number): GizmoPickerHandle | null {
  if (handles.size === 0) return null;
  const camera = stageCamera();
  if (!camera) return null;
  raycaster.setFromCamera(pointer.set(ndcX, ndcY), camera);
  for (const handle of handles.values()) {
    const targets = handle.pickers();
    if (targets.length === 0) continue;
    if (raycaster.intersectObjects(targets, true).length > 0) return handle;
  }
  return null;
}

/** three-stdlib keeps `gizmo` off its d.ts but `picker` is public on it; the active mode's group is the only valid raycast target. */
interface TransformControlsInternals {
  gizmo?: { picker?: Record<string, Object3D | undefined> };
}

export function transformControlsPicker(
  controls: object | null | undefined,
  mode: GizmoMode,
): Object3D[] {
  const picker = (controls as TransformControlsInternals | null | undefined)?.gizmo?.picker?.[mode];
  return picker ? [picker] : [];
}
