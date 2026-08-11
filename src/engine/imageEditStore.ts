import { create } from "zustand";
import type { GizmoMode } from "./gizmoMode";
import type { SceneImageOverlayPlacement, SceneImageStagePlacement } from "./sceneDocSchema";

export type ImageEditCommit =
  | {
      sceneIndex: number;
      imageId: string;
      kind: "stage";
      placement: SceneImageStagePlacement;
    }
  | {
      sceneIndex: number;
      imageId: string;
      kind: "overlay";
      placement: SceneImageOverlayPlacement;
    };

interface ImageEditState {
  selected: { sceneIndex: number; imageId: string } | null;
  gizmoMode: GizmoMode;
  pendingCommit: ImageEditCommit | null;
  select: (selected: ImageEditState["selected"]) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  requestCommit: (commit: ImageEditCommit) => void;
  clearCommit: () => void;
  reset: () => void;
}

export const useImageEditStore = create<ImageEditState>((set) => ({
  selected: null,
  gizmoMode: "translate",
  pendingCommit: null,
  select: (selected) => set({ selected }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  requestCommit: (pendingCommit) => set({ pendingCommit }),
  clearCommit: () => set({ pendingCommit: null }),
  reset: () => set({ selected: null, gizmoMode: "translate", pendingCommit: null }),
}));
