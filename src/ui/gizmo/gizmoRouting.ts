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

/** Shift is deliberately excluded: it is the 2D gizmo's rotate snap. */
export function cameraOverrideHeld(m: ModifierState): boolean {
  return m.metaKey || m.ctrlKey || m.altKey;
}

/** Client pixels to normalised device coordinates against the canvas box; null outside the box or for a degenerate rect (never NaN). */
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

/** The 2D layer contract: the container never claims the pointer, only its `.gizmo-hit` children do, and a held override stands them all down so the drag falls through to the tool surface below. */
export function gizmoLayerClass(overrideHeld: boolean, extra?: string): string {
  return `gizmo-layer${overrideHeld ? " camera-override" : ""}${extra ? ` ${extra}` : ""}`;
}
