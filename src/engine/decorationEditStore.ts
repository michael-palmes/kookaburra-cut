import { create } from "zustand";

/** Decoration-editing UI state: which panel decoration the preview gizmo has selected. Shared by the gizmo overlay and the inspector's decoration cards so selection stays in sync both ways. UI-only; the export path never reads this store. */
interface DecorationEditState {
  selectedId: string | null;
  select: (id: string | null) => void;
}

export const useDecorationEditStore = create<DecorationEditState>((set) => ({
  selectedId: null,
  select: (id) => set({ selectedId: id }),
}));
