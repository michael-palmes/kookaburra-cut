import { create } from "zustand";
import type { GizmoDomain } from "../engine/gizmoRegistry";
import type { ThemeBackdrop, ThemeBackground } from "../theme/tokens";

/** Main-window chrome state: the command palette, preview-audio mute, the inspector panel's tab and drill-in nav stack, the timeline's background clipboard, and the rail-wizard request channel (lets the palette, and later the playback bar, ask TerminalPanel to open a scene wizard without threading callbacks through every layer). Like editorStore, the deterministic export path never reads this store, it holds chrome-only state that must never influence rendered pixels. */

export type InspectorTab = "project" | "scene";

export type InspectorNavigationKind = "push" | "pop" | "reset" | "jump" | "replace";

export interface InspectorNavigationEvent {
  sequence: number;
  kind: InspectorNavigationKind;
}

export interface InspectorOverviewSelection {
  sceneIndex: number;
  rowId: string;
  domain: GizmoDomain | null;
}

export type PreviewQuality = "full" | "balanced" | "performance";

const QUALITY_KEY = "kookaburra:preview-quality";
const DETAILED_LANE_KEY = "kookaburra:detailed-animation-view";
const BEAT_LANE_KEY = "kookaburra:beat-lane-hidden";
const FREE_CAMERA_WARNING_KEY = "kookaburra:free-camera-warning-dismissed";

function loadPreviewQuality(): PreviewQuality {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    return v === "balanced" || v === "performance" ? v : "full";
  } catch {
    return "full";
  }
}

function loadDetailedAnimationView(): boolean {
  try {
    return localStorage.getItem(DETAILED_LANE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadBeatLaneHidden(): boolean {
  try {
    return localStorage.getItem(BEAT_LANE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadFreeCameraWarningDismissed(): boolean {
  try {
    return localStorage.getItem(FREE_CAMERA_WARNING_KEY) === "1";
  } catch {
    return false;
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
  /** The Scene-overview row selected without opening a drill. Kept through push/pop so returning restores the same row and Stage gizmo domain. */
  overviewSelection: InspectorOverviewSelection | null;
}

interface UiState {
  /** The ⌘K command palette (editor view only; decision 14). */
  paletteOpen: boolean;
  /** Preview-soundtrack mute; preview-only, never touches export audio. */
  audioMuted: boolean;
  /** Preview canvas resolution; preview-only, the exporter pins its own pixel ratio. */
  previewQuality: PreviewQuality;
  /** Animation lanes draw keyframes as narrow lines instead of diamonds (finer editing); chrome-only. */
  detailedAnimationView: boolean;
  /** The beat lane auto-shows whenever the project has a soundtrack; this is the opt-out. */
  beatLaneHidden: boolean;
  /** The Free-camera warning stays hidden once the user ticks "Don't show this again". */
  freeCameraWarningDismissed: boolean;
  inspector: InspectorState;
  inspectorNavigation: InspectorNavigationEvent;
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
  setDetailedAnimationView: (detailed: boolean) => void;
  setBeatLaneHidden: (hidden: boolean) => void;
  setFreeCameraWarningDismissed: (dismissed: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setInspectorOverviewSelection: (selection: InspectorOverviewSelection | null) => void;
  /** Push a screen (forward navigation): row list to a group, or a group to a detail. */
  openInspectorDrill: (id: string) => void;
  /** Pop one level (the DrillBack affordance). */
  closeInspectorDrill: () => void;
  /** Clear to the row list (tab/scene/project switch, or a full close). */
  resetInspectorDrill: () => void;
  /** Land directly on a screen path (external jumps from the palette or timeline). */
  jumpInspectorDrill: (ids: string[]) => void;
  /** Replace the current screen at the same depth without changing Back history. */
  replaceInspectorDrill: (id: string) => void;
  requestRailWizard: (wizard: "new-scene" | "edit-scene" | null) => void;
  requestPlaybackOptions: () => void;
  setBackgroundClipboard: (clip: BackgroundClipboard | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  paletteOpen: false,
  audioMuted: false,
  previewQuality: loadPreviewQuality(),
  detailedAnimationView: loadDetailedAnimationView(),
  beatLaneHidden: loadBeatLaneHidden(),
  freeCameraWarningDismissed: loadFreeCameraWarningDismissed(),
  // Scene is the default tab: it's where editing happens; bundled projects heal back to Project.
  inspector: { tab: "scene", drillStack: [], drillIn: null, overviewSelection: null },
  inspectorNavigation: { sequence: 0, kind: "reset" },
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
  setDetailedAnimationView: (detailedAnimationView) => {
    try {
      localStorage.setItem(DETAILED_LANE_KEY, detailedAnimationView ? "1" : "0");
    } catch {
      // Storage unavailable: the choice still applies for this session.
    }
    set({ detailedAnimationView });
  },
  setBeatLaneHidden: (beatLaneHidden) => {
    try {
      localStorage.setItem(BEAT_LANE_KEY, beatLaneHidden ? "1" : "0");
    } catch {
      // Storage unavailable: the choice still applies for this session.
    }
    set({ beatLaneHidden });
  },
  setFreeCameraWarningDismissed: (freeCameraWarningDismissed) => {
    try {
      localStorage.setItem(FREE_CAMERA_WARNING_KEY, freeCameraWarningDismissed ? "1" : "0");
    } catch {
      // Storage unavailable: the choice still applies for this session.
    }
    set({ freeCameraWarningDismissed });
  },
  setInspectorTab: (tab) =>
    set((s) => ({
      inspector: {
        ...s.inspector,
        tab,
        drillStack: [],
        drillIn: null,
        overviewSelection: null,
      },
      inspectorNavigation: {
        sequence: s.inspectorNavigation.sequence + 1,
        kind: "reset",
      },
    })),
  setInspectorOverviewSelection: (overviewSelection) =>
    set((s) => ({ inspector: { ...s.inspector, overviewSelection } })),
  openInspectorDrill: (id) =>
    set((s) => {
      const drillStack = [...s.inspector.drillStack, id];
      return {
        inspector: { ...s.inspector, drillStack, drillIn: id },
        inspectorNavigation: {
          sequence: s.inspectorNavigation.sequence + 1,
          kind: "push",
        },
      };
    }),
  closeInspectorDrill: () =>
    set((s) => {
      if (s.inspector.drillStack.length === 0) return s;
      const drillStack = s.inspector.drillStack.slice(0, -1);
      return {
        inspector: { ...s.inspector, drillStack, drillIn: drillStack.at(-1) ?? null },
        inspectorNavigation: {
          sequence: s.inspectorNavigation.sequence + 1,
          kind: "pop",
        },
      };
    }),
  resetInspectorDrill: () =>
    set((s) => ({
      inspector: {
        ...s.inspector,
        drillStack: [],
        drillIn: null,
        overviewSelection: null,
      },
      inspectorNavigation: {
        sequence: s.inspectorNavigation.sequence + 1,
        kind: "reset",
      },
    })),
  jumpInspectorDrill: (ids) =>
    set((s) => {
      const drillStack = [...ids];
      return {
        inspector: { ...s.inspector, drillStack, drillIn: drillStack.at(-1) ?? null },
        inspectorNavigation: {
          sequence: s.inspectorNavigation.sequence + 1,
          kind: "jump",
        },
      };
    }),
  replaceInspectorDrill: (id) =>
    set((s) => {
      if (s.inspector.drillStack.length === 0) {
        return {
          inspector: { ...s.inspector, drillStack: [id], drillIn: id },
          inspectorNavigation: {
            sequence: s.inspectorNavigation.sequence + 1,
            kind: "push",
          },
        };
      }
      const drillStack = [...s.inspector.drillStack.slice(0, -1), id];
      return {
        inspector: { ...s.inspector, drillStack, drillIn: id },
        inspectorNavigation: {
          sequence: s.inspectorNavigation.sequence + 1,
          kind: "replace",
        },
      };
    }),
  requestRailWizard: (railWizardRequest) => set({ railWizardRequest }),
  requestPlaybackOptions: () => set((s) => ({ playbackOptionsNonce: s.playbackOptionsNonce + 1 })),
  setBackgroundClipboard: (backgroundClipboard) => set({ backgroundClipboard }),
}));
