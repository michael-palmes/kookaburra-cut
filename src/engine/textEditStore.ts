import { create } from "zustand";

/** Text-editing UI state (the `decorationEditStore` pattern): which text element the preview gizmo has selected, shared with the inspector's Text drill so selection stays in sync both ways. Scene-scoped, because text keys are only unique within a scene. UI-only: nothing inside the canvas reads it and the export path never touches it. */
interface TextEditState {
  selected: { sceneIndex: number; key: string } | null;
  select: (selected: TextEditState["selected"]) => void;
}

export const useTextEditStore = create<TextEditState>((set) => ({
  selected: null,
  select: (selected) => set({ selected }),
}));
