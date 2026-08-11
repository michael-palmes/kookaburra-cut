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

export type ImageEditPreview = ImageEditCommit;

export function imageEditCommitMatches(a: ImageEditCommit, b: ImageEditCommit): boolean {
  if (a.sceneIndex !== b.sceneIndex || a.imageId !== b.imageId || a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "stage" && b.kind === "stage") {
    return (
      a.placement.size === b.placement.size &&
      a.placement.position.every((value, index) => value === b.placement.position[index]) &&
      a.placement.rotationDeg.every((value, index) => value === b.placement.rotationDeg[index])
    );
  }
  if (a.kind !== "overlay" || b.kind !== "overlay") return false;
  return (
    a.placement.size === b.placement.size &&
    a.placement.rotationDeg === b.placement.rotationDeg &&
    a.placement.shape === b.placement.shape &&
    a.placement.layer === b.placement.layer &&
    a.placement.stackOrder === b.placement.stackOrder &&
    a.placement.position.every((value, index) => value === b.placement.position[index])
  );
}

export interface ImageEditState {
  selected: { sceneIndex: number; imageId: string } | null;
  gizmoMode: GizmoMode;
  /** The in-memory placement shown while a gizmo drag is active or its sidecar write is landing. */
  previewPlacement: ImageEditPreview | null;
  pendingCommit: ImageEditCommit | null;
  select: (selected: ImageEditState["selected"]) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  preview: (preview: ImageEditPreview) => void;
  clearPreview: () => void;
  requestCommit: (commit: ImageEditCommit) => void;
  clearCommit: () => void;
  reset: () => void;
}

function sameSelection(a: ImageEditState["selected"], b: ImageEditState["selected"]): boolean {
  return a?.sceneIndex === b?.sceneIndex && a?.imageId === b?.imageId;
}

export const useImageEditStore = create<ImageEditState>((set) => ({
  selected: null,
  gizmoMode: "translate",
  previewPlacement: null,
  pendingCommit: null,
  select: (selected) =>
    set((state) =>
      sameSelection(state.selected, selected) ? state : { selected, previewPlacement: null },
    ),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  preview: (previewPlacement) => set({ previewPlacement }),
  clearPreview: () => set({ previewPlacement: null }),
  requestCommit: (pendingCommit) => set({ pendingCommit }),
  clearCommit: () => set({ pendingCommit: null }),
  reset: () =>
    set({
      selected: null,
      gizmoMode: "translate",
      previewPlacement: null,
      pendingCommit: null,
    }),
}));

export function useImageStagePreview(
  sceneIndex: number,
  imageId: string,
  editable: boolean,
): SceneImageStagePlacement | null {
  return useImageEditStore((state) => {
    if (!editable) return null;
    const selected = state.selected;
    const preview = state.previewPlacement;
    return selected?.sceneIndex === sceneIndex &&
      selected.imageId === imageId &&
      preview?.sceneIndex === sceneIndex &&
      preview.imageId === imageId &&
      preview.kind === "stage"
      ? preview.placement
      : null;
  });
}

export function useImageOverlayPreview(
  sceneIndex: number,
  imageId: string,
  editable: boolean,
): SceneImageOverlayPlacement | null {
  return useImageEditStore((state) => {
    if (!editable) return null;
    const selected = state.selected;
    const preview = state.previewPlacement;
    return selected?.sceneIndex === sceneIndex &&
      selected.imageId === imageId &&
      preview?.sceneIndex === sceneIndex &&
      preview.imageId === imageId &&
      preview.kind === "overlay"
      ? preview.placement
      : null;
  });
}
