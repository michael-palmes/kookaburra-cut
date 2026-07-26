import { create } from "zustand";
import type { SceneCameraTracks } from "./sceneCamera";

/** Camera-editing UI state: mini-timeline open/selection/tool state plus the live drag draft the preview renders while a pointer is down; UI-only, the export path never reads this store (exportProject samples only ExportOptions.sceneDocs). The camera MODE is deliberately absent: it lives in the scene doc, so an undo restores it with the keys it belongs to. */

/** Orbit-mode tools leash the camera to a target; free-mode tools move a free pose. Which set is offered follows the DOC's `cameraMode`, never store state, so the pill switch is the one writer. */
export type CameraTool = "pan" | "rotate" | "zoom" | "move" | "forward" | "look" | "tilt";

export const ORBIT_TOOLS = ["rotate", "pan", "zoom"] as const;
export const FREE_TOOLS = ["move", "forward", "look", "tilt"] as const;

export const isFreeTool = (tool: CameraTool | null): boolean =>
  tool === "move" || tool === "forward" || tool === "look" || tool === "tilt";

export interface CameraDraft {
  projectId: string;
  sceneIndex: number;
  /** Normalized replacement for the scene's camera (null = track removed). */
  track: SceneCameraTracks | null;
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
