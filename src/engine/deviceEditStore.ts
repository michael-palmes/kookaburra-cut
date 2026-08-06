import { create } from "zustand";
import type { DevicePlacement } from "../toolkit/device/Device";
import type { GizmoMode } from "./gizmoMode";
import type { SceneDocDeviceLayoutDelta } from "./sceneDocSchema";

/** Device-edit UI state (the objectEditStore pattern): which device the inspector's device rows act on, so a preview gizmo can attach to it, plus the gizmo's pending sidecar commit. UI-only: the export path never reads it, and `exportPreamble` clears the selection so a gizmo can never leak into an export. The gizmo posts `pendingCommit` rather than writing the doc itself because `patchDoc` lives in the inspector's DOM tree, not the canvas; SceneTab subscribes and lands one history entry per drag. */
interface DeviceEditState {
  /** Scene-scoped selection (`id`s are only unique within one scene); also drives the inspector's device pills. */
  selected: { sceneIndex: number; deviceId: string } | null;
  /** Which manipulation the attached gizmo performs (the position drill's Move/Rotate/Scale pills). */
  gizmoMode: GizmoMode;
  /** A finished gizmo drag awaiting the inspector's `patchDoc` write; the two variants mirror the Position drill's two write branches, so a laid-out scene keeps editing its `deviceLayout` delta and a block-less one keeps editing raw placement. */
  pendingCommit:
    | { sceneIndex: number; deviceId: string; kind: "placement"; placement: DevicePlacement }
    | { sceneIndex: number; deviceId: string; kind: "delta"; delta: SceneDocDeviceLayoutDelta }
    | null;
  select: (selected: DeviceEditState["selected"]) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  requestCommit: (commit: NonNullable<DeviceEditState["pendingCommit"]>) => void;
  clearCommit: () => void;
}

export type DeviceEditCommit = NonNullable<DeviceEditState["pendingCommit"]>;

export const useDeviceEditStore = create<DeviceEditState>((set) => ({
  selected: null,
  gizmoMode: "translate",
  pendingCommit: null,
  select: (selected) => set({ selected }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  requestCommit: (pendingCommit) => set({ pendingCommit }),
  clearCommit: () => set({ pendingCommit: null }),
}));
