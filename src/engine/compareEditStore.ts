import { create } from "zustand";
import type { KeyedTrack } from "./keyedTrack";

/** Comparison divider-lane UI state: selection plus the live drag draft the preview renders while a pointer is down; UI-only, the export path never reads this store (exportProject samples only ExportOptions.sceneDocs). No armed tools: the divider is a one-channel value, the lane's diamonds are the whole gesture surface. */

/** One divider key's pose: the mask value, plus an OPTIONAL angle overriding the static mask angle from this key on. Absent means the static angle, so a track authored before angles rides unchanged. */
export interface ComparePose {
  value: number;
  angleDeg?: number;
}

export type CompareTrackDoc = KeyedTrack<ComparePose>;

export interface CompareDraft {
  projectId: string;
  sceneIndex: number;
  track: CompareTrackDoc;
  /** True once written to the sidecar; cleared when the patched project lands. */
  committed: boolean;
}

interface CompareEditState {
  selectedKeyId: string | null;
  /** Doc index of the selected segment (opens the easing popover). */
  selectedSegment: number | null;
  writeError: string | null;
  draft: CompareDraft | null;
  select: (keyId: string | null, segment: number | null) => void;
  setDraft: (draft: CompareDraft | null) => void;
  setWriteError: (err: string | null) => void;
  clearCommittedDraft: () => void;
}

export const useCompareEditStore = create<CompareEditState>((set) => ({
  selectedKeyId: null,
  selectedSegment: null,
  writeError: null,
  draft: null,
  select: (selectedKeyId, selectedSegment) => set({ selectedKeyId, selectedSegment }),
  setDraft: (draft) => set({ draft }),
  setWriteError: (writeError) => set({ writeError }),
  clearCommittedDraft: () => set((s) => (s.draft?.committed ? { draft: null } : {})),
}));
