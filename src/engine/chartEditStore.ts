import { create } from "zustand";
import type { DevicePlacement } from "../toolkit/device/Device";
import type { ObjectGizmoMode } from "./objectEditStore";

/** Chart-edit UI state (the objectEditStore pattern; one chart per scene, so the selection is just the scene): whether the staged chart's preview gizmo is attached, which manipulation it performs, and the drag it has finished. UI-only: the export path never reads it, and `exportPreamble` clears the selection so a gizmo can never leak into an export. The gizmo posts `pendingCommit` rather than writing the doc itself because `patchDoc` lives in the inspector's DOM tree, not the canvas; SceneTab subscribes and lands one history entry per drag. */
interface ChartEditState {
  selected: { sceneIndex: number } | null;
  /** Which manipulation the attached gizmo performs (the position drill's Move/Rotate/Scale pills). */
  gizmoMode: ObjectGizmoMode;
  /** A finished gizmo drag awaiting the inspector's `patchDoc` write. */
  pendingCommit: { sceneIndex: number; placement: DevicePlacement } | null;
  select: (selected: ChartEditState["selected"]) => void;
  setGizmoMode: (mode: ObjectGizmoMode) => void;
  requestCommit: (commit: NonNullable<ChartEditState["pendingCommit"]>) => void;
  clearCommit: () => void;
}

export const useChartEditStore = create<ChartEditState>((set) => ({
  selected: null,
  gizmoMode: "translate",
  pendingCommit: null,
  select: (selected) => set({ selected }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  requestCommit: (pendingCommit) => set({ pendingCommit }),
  clearCommit: () => set({ pendingCommit: null }),
}));
