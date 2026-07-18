import { create } from "zustand";
import type { ThemeBackdrop, ThemeBackground } from "../theme/tokens";

/** Main-window chrome state: the command palette, preview-audio mute, the inspector panel's tab/drill-in/collapsed-section state, the timeline's background clipboard, and the rail-wizard request channel (lets the palette, and later the playback bar, ask TerminalPanel to open a scene wizard without threading callbacks through every layer). Like editorStore, the deterministic export path never reads this store, it holds chrome-only state that must never influence rendered pixels. */

export type InspectorTab = "project" | "scene";

export type PreviewQuality = "full" | "balanced" | "performance";

const QUALITY_KEY = "kookaburra:preview-quality";

function loadPreviewQuality(): PreviewQuality {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    return v === "balanced" || v === "performance" ? v : "full";
  } catch {
    return "full";
  }
}

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
  /** Preview canvas resolution; preview-only, the exporter pins its own pixel ratio. */
  previewQuality: PreviewQuality;
  inspector: InspectorState;
  /** A pending "open this wizard" request for the Claude rail (consumed by TerminalPanel). */
  railWizardRequest: "new-scene" | "edit-scene" | null;
  /** Bumped by the stage's slowdown badge; the inspector opens the Playback options popover. */
  playbackOptionsNonce: number;
  /** null = nothing copied yet (Paste disabled). */
  backgroundClipboard: BackgroundClipboard | null;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  setAudioMuted: (muted: boolean) => void;
  setPreviewQuality: (quality: PreviewQuality) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setInspectorDrillIn: (id: string | null) => void;
  toggleInspectorSection: (id: string) => void;
  requestRailWizard: (wizard: "new-scene" | "edit-scene" | null) => void;
  requestPlaybackOptions: () => void;
  setBackgroundClipboard: (clip: BackgroundClipboard | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  paletteOpen: false,
  audioMuted: false,
  previewQuality: loadPreviewQuality(),
  inspector: { tab: "project", drillIn: null, collapsed: [] },
  railWizardRequest: null,
  playbackOptionsNonce: 0,
  backgroundClipboard: null,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setAudioMuted: (audioMuted) => set({ audioMuted }),
  setPreviewQuality: (previewQuality) => {
    try {
      localStorage.setItem(QUALITY_KEY, previewQuality);
    } catch {
      // Storage unavailable: the choice still applies for this session.
    }
    set({ previewQuality });
  },
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
  requestPlaybackOptions: () => set((s) => ({ playbackOptionsNonce: s.playbackOptionsNonce + 1 })),
  setBackgroundClipboard: (backgroundClipboard) => set({ backgroundClipboard }),
}));
