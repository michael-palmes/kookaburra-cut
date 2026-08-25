import { create } from "zustand";
import type { DevicePlacement } from "../toolkit/device/Device";
import type { GizmoMode } from "./gizmoMode";
import type { SceneDocDeviceLayoutDelta, SceneDocDevicePose } from "./sceneDocSchema";

export type DeviceEditCommitPayload =
  | {
      sceneIndex: number;
      deviceId: string;
      kind: "placement";
      placement: DevicePlacement;
      clearGround?: true;
    }
  | {
      sceneIndex: number;
      deviceId: string;
      kind: "delta";
      delta: SceneDocDeviceLayoutDelta;
      clearGround?: true;
    }
  | {
      sceneIndex: number;
      deviceId: string;
      /** A keyframed scene: the drag shapes the key nearest the playhead, not the resting placement. */
      kind: "key";
      keyId: string;
      pose: SceneDocDevicePose;
      clearGround?: true;
    };

export type DeviceEditCommit = DeviceEditCommitPayload & { commitId: number };

export interface DeviceEditAcknowledgement {
  sceneIndex: number;
  deviceId: string;
  succeeded: boolean;
}

export function deviceAcknowledgementMatches(
  acknowledgement: DeviceEditAcknowledgement,
  sceneIndex: number | undefined,
  deviceId: string | undefined,
): boolean {
  return acknowledgement.sceneIndex === sceneIndex && acknowledgement.deviceId === deviceId;
}

/** Device-edit UI state (the objectEditStore pattern): which device the inspector's device rows act on, so a preview gizmo can attach to it, plus the gizmo's pending sidecar commit. UI-only: the export path never reads it, and `exportPreamble` clears the selection so a gizmo can never leak into an export. The gizmo posts `pendingCommit` rather than writing the doc itself because `patchDoc` lives in the inspector's DOM tree, not the canvas; SceneTab subscribes and lands one history entry per drag. */
interface DeviceEditState {
  /** Scene-scoped selection (`id`s are only unique within one scene); also drives the inspector's device pills. */
  selected: { sceneIndex: number; deviceId: string } | null;
  /** Which manipulation the attached gizmo performs (the position drill's Move/Rotate/Scale pills). */
  gizmoMode: GizmoMode;
  /** A finished gizmo drag awaiting the inspector's `patchDoc` write; the variants mirror the Position drill's write branches, so a laid-out scene keeps editing its `deviceLayout` delta and a block-less one keeps editing raw placement, while a keyframed scene edits the nearest key instead. */
  pendingCommit: DeviceEditCommit | null;
  acknowledgements: Record<number, DeviceEditAcknowledgement>;
  select: (selected: DeviceEditState["selected"]) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  requestCommit: (commit: DeviceEditCommitPayload) => number;
  clearCommit: () => void;
  acknowledgeCommit: (commit: DeviceEditCommit, succeeded: boolean) => void;
  clearAcknowledgement: (commitId: number) => void;
}

let nextDeviceCommitId = 1;

export const useDeviceEditStore = create<DeviceEditState>((set) => ({
  selected: null,
  gizmoMode: "translate",
  pendingCommit: null,
  acknowledgements: {},
  select: (selected) => set({ selected }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  requestCommit: (commit) => {
    const commitId = nextDeviceCommitId++;
    set({ pendingCommit: { ...commit, commitId } });
    return commitId;
  },
  clearCommit: () => set({ pendingCommit: null }),
  acknowledgeCommit: (commit, succeeded) =>
    set((state) => ({
      acknowledgements: {
        ...state.acknowledgements,
        [commit.commitId]: {
          sceneIndex: commit.sceneIndex,
          deviceId: commit.deviceId,
          succeeded,
        },
      },
    })),
  clearAcknowledgement: (commitId) =>
    set((state) => {
      if (!(commitId in state.acknowledgements)) return state;
      const acknowledgements = { ...state.acknowledgements };
      delete acknowledgements[commitId];
      return { acknowledgements };
    }),
}));
