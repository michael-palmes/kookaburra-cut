import { create } from "zustand";
import type { ThemeBackdrop, ThemeBackground } from "../theme/tokens";

/** Main-window chrome state: the command palette, preview-audio mute, the inspector panel's tab/drill-in/collapsed-section state, the timeline's background clipboard, and the rail-wizard request channel (lets the palette, and later the playback bar, ask TerminalPanel to open a scene wizard without threading callbacks through every layer). Like editorStore, the deterministic export path never reads this store, it holds chrome-only state that must never influence rendered pixels. */

export type InspectorTab = "project" | "scene";

/** A copied scene look (Copy background): raw override fields, so absent = "follow theme" pastes as absence. Cleared on project switch since image/video fills reference project assets. */
export interface BackgroundClipboard {
  background?: ThemeBackground;
  backdrop?: ThemeBackdrop;
}

export interface InspectorState {
  tab: InspectorTab;
  /** The open drill-in view's id (single-level push/pop), or null at the row list. */
  drillIn: string | null;
  /** Collapsed Scene-tab section ids (sections default open). */
  collapsed: string[];
}

interface UiState {
  /** The ⌘K command palette (editor view only; decision 14). */
  paletteOpen: boolean;
  /** Preview-soundtrack mute; preview-only, never touches export audio. */
  audioMuted: boolean;
  inspector: InspectorState;
  /** A pending "open this wizard" request for the Claude rail (consumed by TerminalPanel). */
  railWizardRequest: "new-scene" | "edit-scene" | null;
  /** null = nothing copied yet (Paste disabled). */
  backgroundClipboard: BackgroundClipboard | null;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setAudioMuted: (muted: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setInspectorDrillIn: (id: string | null) => void;
  toggleInspectorSection: (id: string) => void;
  requestRailWizard: (wizard: "new-scene" | "edit-scene" | null) => void;
  setBackgroundClipboard: (clip: BackgroundClipboard | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  paletteOpen: false,
  audioMuted: false,
  inspector: { tab: "project", drillIn: null, collapsed: [] },
  railWizardRequest: null,
  backgroundClipboard: null,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setAudioMuted: (audioMuted) => set({ audioMuted }),
  setInspectorTab: (tab) => set((s) => ({ inspector: { ...s.inspector, tab, drillIn: null } })),
  setInspectorDrillIn: (drillIn) => set((s) => ({ inspector: { ...s.inspector, drillIn } })),
  toggleInspectorSection: (id) =>
    set((s) => ({
      inspector: {
        ...s.inspector,
        collapsed: s.inspector.collapsed.includes(id)
          ? s.inspector.collapsed.filter((c) => c !== id)
          : [...s.inspector.collapsed, id],
      },
    })),
  requestRailWizard: (railWizardRequest) => set({ railWizardRequest }),
  setBackgroundClipboard: (backgroundClipboard) => set({ backgroundClipboard }),
}));
