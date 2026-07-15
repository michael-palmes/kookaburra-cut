import { create } from "zustand";
import type { SceneCameraTrack } from "./sceneCamera";

/** Camera-editing UI state: mini-timeline open/selection/tool state plus the live drag draft the preview renders while a pointer is down; UI-only, the export path never reads this store (exportProject samples only ExportOptions.sceneDocs). */

export type CameraTool = "pan" | "rotate" | "zoom";

export interface CameraDraft {
  projectId: string;
  sceneIndex: number;
  /** Normalized replacement for the scene's track (null = track removed). */
  track: SceneCameraTrack | null;
  /** True once written to the sidecar; cleared by App when the reload lands. */
  committed: boolean;
}

interface CameraEditState {
  /** The edit bar's Edit-camera toggle (shows the mini-timeline + tools). */
  open: boolean;
  selectedKeyId: string | null;
  /** Doc index of the selected segment (opens the easing popover). */
  selectedSegment: number | null;
  armedTool: CameraTool | null;
  draft: CameraDraft | null;
  /** Last sidecar-write failure, shown in the strip; otherwise the on-screen pose lies while the disk write silently failed. */
  writeError: string | null;
  setOpen: (open: boolean) => void;
  select: (keyId: string | null, segment: number | null) => void;
  armTool: (tool: CameraTool | null) => void;
  setDraft: (draft: CameraDraft | null) => void;
  setWriteError: (writeError: string | null) => void;
  clearCommittedDraft: () => void;
  reset: () => void;
}

export const useCameraEditStore = create<CameraEditState>((set) => ({
  open: false,
  selectedKeyId: null,
  selectedSegment: null,
  armedTool: null,
  draft: null,
  writeError: null,
  setOpen: (open) =>
    set(
      open
        ? { open }
        : { open, selectedKeyId: null, selectedSegment: null, armedTool: null, writeError: null },
    ),
  select: (selectedKeyId, selectedSegment) => set({ selectedKeyId, selectedSegment }),
  armTool: (armedTool) => set({ armedTool }),
  setDraft: (draft) => set({ draft }),
  setWriteError: (writeError) => set((s) => (s.writeError === writeError ? {} : { writeError })),
  clearCommittedDraft: () => set((s) => (s.draft?.committed ? { draft: null } : {})),
  reset: () =>
    set({
      open: false,
      selectedKeyId: null,
      selectedSegment: null,
      armedTool: null,
      draft: null,
      writeError: null,
    }),
}));
