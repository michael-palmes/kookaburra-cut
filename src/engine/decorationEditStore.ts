import { create } from "zustand";

/** Decoration-editing UI state: which panel decoration the preview gizmo has selected, plus a one-shot request from the gizmo's context menu to open the inspector's media picker for a decoration. Shared by the gizmo overlay and the inspector so selection stays in sync both ways. Scene-scoped like deviceEditStore and textEditStore, because decoration ids are only unique within one scene and both readers follow the playhead: the gizmo names the scene it is hosting and a real change drops the selection, so scrubbing can never leave an id matching a neighbouring scene's decorations. UI-only; the export path never reads this store. */
interface DecorationEditState {
  /** The scene `selectedId` belongs to; null until a gizmo names one. */
  sceneIndex: number | null;
  selectedId: string | null;
  setScene: (sceneIndex: number) => void;
  select: (id: string | null) => void;
  /** Set by the gizmo's "Change media" action; the inspector opens its media picker for this decoration, then clears it. */
  mediaRequestId: string | null;
  requestMedia: (id: string | null) => void;
}

export const useDecorationEditStore = create<DecorationEditState>((set) => ({
  sceneIndex: null,
  selectedId: null,
  setScene: (sceneIndex) =>
    set((s) => (s.sceneIndex === sceneIndex ? s : { sceneIndex, selectedId: null })),
  select: (id) => set({ selectedId: id }),
  mediaRequestId: null,
  requestMedia: (id) => set({ mediaRequestId: id }),
}));
