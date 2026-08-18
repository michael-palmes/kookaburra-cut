import { create } from "zustand";
import type { LightingPose } from "../theme/tokens";
import type { KeyedTrack } from "./keyedTrack";

export type LightingTrackDoc = KeyedTrack<LightingPose>;
export type LightingTarget = "scene" | "compareB";

export interface LightingDraft {
  projectId: string;
  sceneIndex: number;
  target: LightingTarget;
  track: LightingTrackDoc;
  committed: boolean;
}

interface LightingEditState {
  open: boolean;
  selectedKeyId: string | null;
  selectedSegment: number | null;
  target: LightingTarget;
  writeError: string | null;
  draft: LightingDraft | null;
  setOpen: (open: boolean) => void;
  setTarget: (target: LightingTarget) => void;
  select: (keyId: string | null, segment: number | null) => void;
  setDraft: (draft: LightingDraft | null) => void;
  setWriteError: (error: string | null) => void;
  reset: () => void;
}

const initial = {
  open: false,
  selectedKeyId: null,
  selectedSegment: null,
  target: "scene" as const,
  writeError: null,
  draft: null,
};

export const useLightingEditStore = create<LightingEditState>((set) => ({
  ...initial,
  setOpen: (open) => set({ open }),
  setTarget: (target) =>
    set((state) =>
      state.target === target
        ? { target }
        : {
            target,
            selectedKeyId: null,
            selectedSegment: null,
            writeError: null,
            draft: state.draft?.target === target ? state.draft : null,
          },
    ),
  select: (selectedKeyId, selectedSegment) => set({ selectedKeyId, selectedSegment }),
  setDraft: (draft) => set({ draft }),
  setWriteError: (writeError) => set({ writeError }),
  reset: () => set(initial),
}));
