import type { Object3D } from "three";

/** Live handles onto each mounted 2D-editable item's node and local rect, published from effects by the text and chart primitives (the `sceneHostRegistry` idiom: a module Map, plain functions, no store). The DOM gizmo layer projects these per frame; the export path never imports it. `sceneTextRegistry` deliberately stays as it is: it is a re-rendering store keyed by an anonymous mount id, with no text key and no node. */

export type Gizmo2DDomain = "text" | "chart";

export interface Gizmo2DTarget {
  domain: Gizmo2DDomain;
  sceneIndex: number;
  /** Scene-scoped: a text key, or "chart". */
  itemId: string;
  /** Present only inside a comparison's side-B subtree, which has no edit target. */
  side?: "b";
  /** The node whose `matrixWorld` places the item. */
  node: () => Object3D | null;
  /** Local-space rect in that node's units, or null until measured: `[minX, minY, maxX, maxY]`. */
  localRect: () => [number, number, number, number] | null;
}

// Keyed by a per-instance id (React useId), the sceneHostRegistry rule: a project swap's mount churn can't clobber entries by index.
const targets = new Map<string, Gizmo2DTarget>();
const listeners = new Set<() => void>();
// A stable array between mutations, so a `useSyncExternalStore` reader can't loop.
let snapshot: Gizmo2DTarget[] = [];

function publish(): void {
  snapshot = [...targets.values()];
  for (const listener of listeners) listener();
}

export function registerGizmoTarget(key: string, target: Gizmo2DTarget): void {
  targets.set(key, target);
  publish();
}

export function unregisterGizmoTarget(key: string): void {
  if (targets.delete(key)) publish();
}

export function gizmoTargets(): Gizmo2DTarget[] {
  return snapshot;
}

export function subscribeGizmoTargets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
