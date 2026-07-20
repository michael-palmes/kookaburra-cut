import { create } from "zustand";
import { isExporting } from "./exportState";
import type { NormalizedLayeredScreenshot } from "./sceneLayeredScreenshot";

/** Layered-screenshot editing UI state (the cameraEditStore pattern plus the builder's 4th spread tool): panel/selection/tool state and the live draft the stage renders while a gesture is in flight; UI-only, the export path never reads this store. */

export type LayeredScreenshotTool = "pan" | "rotate" | "zoom" | "spread";

export interface LayeredScreenshotDraft {
  projectId: string;
  sceneIndex: number;
  /** Normalized replacement for the scene's composition (null = block removed). */
  normalized: NormalizedLayeredScreenshot | null;
  /** True once written to the sidecar; cleared by App when the reload lands. */
  committed: boolean;
}

interface LayeredScreenshotEditState {
  /** The builder panel's open toggle. */
  open: boolean;
  selectedLayerId: string | null;
  selectedItemId: string | null;
  armedTool: LayeredScreenshotTool | null;
  draft: LayeredScreenshotDraft | null;
  /** Last sidecar-write failure, shown in the strip; otherwise the on-screen stack lies while the disk write silently failed. */
  writeError: string | null;
  setOpen: (open: boolean) => void;
  select: (layerId: string | null, itemId: string | null) => void;
  armTool: (tool: LayeredScreenshotTool | null) => void;
  setDraft: (draft: LayeredScreenshotDraft | null) => void;
  setWriteError: (writeError: string | null) => void;
  clearCommittedDraft: () => void;
  reset: () => void;
}

export const useLayeredScreenshotEditStore = create<LayeredScreenshotEditState>((set) => ({
  open: false,
  selectedLayerId: null,
  selectedItemId: null,
  armedTool: null,
  draft: null,
  writeError: null,
  setOpen: (open) =>
    set(
      open
        ? { open }
        : { open, selectedLayerId: null, selectedItemId: null, armedTool: null, writeError: null },
    ),
  select: (selectedLayerId, selectedItemId) => set({ selectedLayerId, selectedItemId }),
  armTool: (armedTool) => set({ armedTool }),
  setDraft: (draft) => set({ draft }),
  setWriteError: (writeError) => set((s) => (s.writeError === writeError ? {} : { writeError })),
  clearCommittedDraft: () => set((s) => (s.draft?.committed ? { draft: null } : {})),
  reset: () =>
    set({
      open: false,
      selectedLayerId: null,
      selectedItemId: null,
      armedTool: null,
      draft: null,
      writeError: null,
    }),
}));

/** This scene's live draft for render merge, or null; exports never merge (the draft is UI state, and `exportProject` samples only the sidecar docs). */
export function useLayeredScreenshotDraft(
  projectId: string | null,
  sceneIndex: number | undefined,
): LayeredScreenshotDraft | null {
  return useLayeredScreenshotEditStore((s) =>
    !isExporting() &&
    s.draft !== null &&
    s.draft.sceneIndex === sceneIndex &&
    s.draft.projectId === projectId
      ? s.draft
      : null,
  );
}
