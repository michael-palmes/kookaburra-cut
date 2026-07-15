import { create } from "zustand";
import type { FormatSpec } from "../engine/format";
import { defaultTheme } from "../theme/registry";
import type { Theme } from "../theme/tokens";

/** Editor UI state (playback flag, export format, active theme); timeline position lives in the separate clock store (`engine/clock.ts`). The export path deliberately never reads this store, it drives the clock from a pure frame-index-derived value so export stays independent of UI; backed by zustand so the format/theme hooks built on it remain readable inside the r3f `<Canvas>` reconciler. */
interface EditorState {
  playing: boolean;
  /** Currently loaded project id; the project picker drives this. */
  projectId: string;
  format: FormatSpec;
  theme: Theme;
  setPlaying: (playing: boolean) => void;
  setProjectId: (projectId: string) => void;
  setFormat: (format: FormatSpec) => void;
  setTheme: (theme: Theme) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  playing: false,
  projectId: "showcase-tour",
  format: { name: "16:9", width: 3840, height: 2160 },
  theme: defaultTheme,
  setPlaying: (playing) => set({ playing }),
  setProjectId: (projectId) => set({ projectId }),
  setFormat: (format) => set({ format }),
  setTheme: (theme) => set({ theme }),
}));
