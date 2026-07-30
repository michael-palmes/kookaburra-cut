import { create } from "zustand";
import type { DevicePlacement } from "../toolkit/device/Device";

/** Object-edit UI state (the lightEditStore pattern): which staged object the inspector has selected, so the preview gizmo attaches to it, plus the gizmo's pending sidecar commit. UI-only: the export path never reads it, and `exportPreamble` clears the selection so a gizmo can never leak into an export. The gizmo posts `pendingCommit` rather than writing the doc itself because `patchDoc` lives in the inspector's DOM tree, not the canvas; SceneTab subscribes and lands one history entry per drag. */
export type ObjectGizmoMode = "translate" | "rotate" | "scale";

interface ObjectEditState {
  /** Scene-scoped selection (`id`s are only unique within one scene). */
  selected: { sceneIndex: number; objectId: string } | null;
  /** Which manipulation the attached gizmo performs (the drill's Move/Rotate/Scale pills). */
  gizmoMode: ObjectGizmoMode;
  /** A finished gizmo drag awaiting the inspector's `patchDoc` write. */
  pendingCommit: { sceneIndex: number; objectId: string; placement: DevicePlacement } | null;
  select: (selected: ObjectEditState["selected"]) => void;
  setGizmoMode: (mode: ObjectGizmoMode) => void;
  requestCommit: (commit: NonNullable<ObjectEditState["pendingCommit"]>) => void;
  clearCommit: () => void;
}

export const useObjectEditStore = create<ObjectEditState>((set) => ({
  selected: null,
  gizmoMode: "translate",
  pendingCommit: null,
  select: (selected) => set({ selected }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  requestCommit: (pendingCommit) => set({ pendingCommit }),
  clearCommit: () => set({ pendingCommit: null }),
}));
