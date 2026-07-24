import { create } from "zustand";
import type { ThemeBackdrop, ThemeBackground } from "../theme/tokens";

/** Main-window chrome state: the command palette, preview-audio mute, the inspector panel's tab and drill-in nav stack, the timeline's background clipboard, and the rail-wizard request channel (lets the palette, and later the playback bar, ask TerminalPanel to open a scene wizard without threading callbacks through every layer). Like editorStore, the deterministic export path never reads this store, it holds chrome-only state that must never influence rendered pixels. */

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
  /** The drill-in nav stack; top = current screen, [] = the row list. Screen ids are the same strings each screen matches on. */
  drillStack: string[];
  /** Read-only mirror of the stack top (drillStack.at(-1) ?? null): what the render dispatch and preview-only gates match against. Maintained by the drill actions, never set directly. */
  drillIn: string | null;
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
  /** Push a screen (forward navigation): row list to a group, or a group to a detail. */
  openInspectorDrill: (id: string) => void;
  /** Pop one level (the DrillBack affordance). */
  closeInspectorDrill: () => void;
  /** Clear to the row list (tab/scene/project switch, or a full close). */
  resetInspectorDrill: () => void;
  /** Land directly on a screen path (external jumps from the palette or timeline). */
  jumpInspectorDrill: (ids: string[]) => void;
  requestRailWizard: (wizard: "new-scene" | "edit-scene" | null) => void;
  requestPlaybackOptions: () => void;
  setBackgroundClipboard: (clip: BackgroundClipboard | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  paletteOpen: false,
  audioMuted: false,
  previewQuality: loadPreviewQuality(),
  // Scene is the default tab: it's where editing happens; bundled projects heal back to Project.
  inspector: { tab: "scene", drillStack: [], drillIn: null },
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
  setInspectorTab: (tab) =>
    set((s) => ({ inspector: { ...s.inspector, tab, drillStack: [], drillIn: null } })),
  openInspectorDrill: (id) =>
    set((s) => {
      const drillStack = [...s.inspector.drillStack, id];
      return { inspector: { ...s.inspector, drillStack, drillIn: id } };
    }),
  closeInspectorDrill: () =>
    set((s) => {
      const drillStack = s.inspector.drillStack.slice(0, -1);
      return { inspector: { ...s.inspector, drillStack, drillIn: drillStack.at(-1) ?? null } };
    }),
  resetInspectorDrill: () =>
    set((s) => ({ inspector: { ...s.inspector, drillStack: [], drillIn: null } })),
  jumpInspectorDrill: (ids) =>
    set((s) => ({ inspector: { ...s.inspector, drillStack: ids, drillIn: ids.at(-1) ?? null } })),
  requestRailWizard: (railWizardRequest) => set({ railWizardRequest }),
  requestPlaybackOptions: () => set((s) => ({ playbackOptionsNonce: s.playbackOptionsNonce + 1 })),
  setBackgroundClipboard: (backgroundClipboard) => set({ backgroundClipboard }),
}));
