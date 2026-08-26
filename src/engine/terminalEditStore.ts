import { create } from "zustand";

/** Terminal-edit UI state (the chartEditStore pattern; one terminal per scene, so the selection is just the scene). UI-only: the export path never reads it, and `exportPreamble` clears the selection so a gizmo can never leak into an export. */
interface TerminalEditState {
  selected: { sceneIndex: number } | null;
  select: (selected: TerminalEditState["selected"]) => void;
}

export const useTerminalEditStore = create<TerminalEditState>((set) => ({
  selected: null,
  select: (selected) => set({ selected }),
}));
