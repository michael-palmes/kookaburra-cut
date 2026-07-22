import { create } from "zustand";

/** Decoration-editing UI state: which panel decoration the preview gizmo has selected, plus a one-shot request from the gizmo's context menu to open the inspector's media picker for a decoration. Shared by the gizmo overlay and the inspector so selection stays in sync both ways. UI-only; the export path never reads this store. */
interface DecorationEditState {
  selectedId: string | null;
  select: (id: string | null) => void;
  /** Set by the gizmo's "Change media" action; the inspector opens its media picker for this decoration, then clears it. */
  mediaRequestId: string | null;
  requestMedia: (id: string | null) => void;
}

export const useDecorationEditStore = create<DecorationEditState>((set) => ({
  selectedId: null,
  select: (id) => set({ selectedId: id }),
  mediaRequestId: null,
  requestMedia: (id) => set({ mediaRequestId: id }),
}));
