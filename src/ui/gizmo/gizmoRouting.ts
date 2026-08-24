import type { StageRect } from "../../engine/gizmoRegistry";
import type { ModifierState } from "./modifierKeys";

/** Who owns a pointer over the stage: the armed camera tool, or a gizmo (which here just means "not the camera overlay": it does not assert a gizmo exists, only that the overlay must decline). Pure and node-testable, so the one rule the whole batch hangs off stays provable. */
export type PointerOwner = "camera" | "gizmo";

export interface RouteInput {
  /** A camera tool is armed and its overlay is mounted. */
  cameraArmed: boolean;
  /** The last hover test found a registered gizmo handle under the pointer. */
  overHandle: boolean;
  /** ⌘, ⌃ or ⌥ held right now. */
  overrideHeld: boolean;
  /** A gizmo drag is in flight (latched at pointer-down). */
  gizmoLatched: boolean;
  /** A camera drag is in flight. */
  cameraLatched: boolean;
}

export function routePointer(input: RouteInput): PointerOwner {
  // A drag in flight never changes owner: a modifier pressed mid-drag must not yank the pointer away.
  if (input.cameraLatched) return "camera";
  if (input.gizmoLatched) return "gizmo";
  if (!input.cameraArmed) return "gizmo";
  // A held modifier claims the drag for the camera even over a handle.
  if (input.overrideHeld) return "camera";
  return input.overHandle ? "gizmo" : "camera";
}

/** Who owns a pointer where a 2D gizmo layer overlaps a live 3D gizmo of the SAME domain (media stages both hosts in one open section): the layer's boxes are DOM above the canvas, so unless they stand down the handles below can never be pressed. */
export type LayerPointerOwner = "layer" | "scene-gizmo";

export interface LayerRouteInput {
  /** A registered 3D handle in the layer's own domain is under the pointer. */
  overSceneHandle: boolean;
  /** A 2D gesture is in flight. */
  layerDragging: boolean;
}

export function routeLayerPointer(input: LayerRouteInput): LayerPointerOwner {
  // As with `routePointer`, a drag in flight never changes owner: a 3D handle sliding under a live 2D drag must not steal it.
  if (input.layerDragging) return "layer";
  return input.overSceneHandle ? "scene-gizmo" : "layer";
}

/** Shift is deliberately excluded: it is the 2D gizmo's rotate snap. */
export function cameraOverrideHeld(m: ModifierState): boolean {
  return m.metaKey || m.ctrlKey || m.altKey;
}

/** Client pixels to normalised device coordinates against the rect the world projects onto (the canvas box, or a framed scene's cutout viewport); null outside the rect or for a degenerate one (never NaN). */
export function pointerNdc(
  clientX: number,
  clientY: number,
  rect: StageRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  if (px < 0 || py < 0 || px > rect.width || py > rect.height) return null;
  return { x: (2 * px) / rect.width - 1, y: 1 - (2 * py) / rect.height };
}

/** The only class that turns pointer events back on inside a gizmo layer. */
export const GIZMO_HIT_CLASS = "gizmo-hit";

/** The 2D layer contract: the container never claims the pointer, only its `.gizmo-hit` children do, and either stand-down drops them all so the press falls through: `camera-override` to the tool surface below, `scene-gizmo-yield` to a 3D handle on the canvas. */
export function gizmoLayerClass(
  overrideHeld: boolean,
  extra?: string,
  sceneGizmoYield?: boolean,
): string {
  return `gizmo-layer${overrideHeld ? " camera-override" : ""}${
    sceneGizmoYield ? " scene-gizmo-yield" : ""
  }${extra ? ` ${extra}` : ""}`;
}
