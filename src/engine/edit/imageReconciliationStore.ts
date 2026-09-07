import { create } from "zustand";

export type ImageReconciliationOrigin =
  | {
      kind: "legacy-promotion";
      imageId: string;
      decorationId: string;
    }
  | {
      kind: "duplicate";
      imageId: string;
      sourceImageId: string;
    };

interface ImageReconciliationState {
  projectId: string | null;
  originsByScene: Record<string, readonly ImageReconciliationOrigin[]>;
  bindProject: (projectId: string | null) => void;
  recordOrigin: (
    projectId: string,
    sceneFile: string | null,
    origin: ImageReconciliationOrigin,
  ) => void;
  originsFor: (projectId: string, sceneFile: string | null) => readonly ImageReconciliationOrigin[];
  reset: () => void;
}

const EMPTY_ORIGINS: readonly ImageReconciliationOrigin[] = [];

function sceneKey(projectId: string, sceneFile: string): string {
  return JSON.stringify([projectId, sceneFile]);
}

export const useImageReconciliationStore = create<ImageReconciliationState>((set, get) => ({
  projectId: null,
  originsByScene: {},
  bindProject: (projectId) =>
    set((state) => (state.projectId === projectId ? state : { projectId, originsByScene: {} })),
  recordOrigin: (projectId, sceneFile, origin) => {
    if (!sceneFile) return;
    set((state) => {
      if (state.projectId !== projectId) return state;
      const key = sceneKey(projectId, sceneFile);
      const current = state.originsByScene[key] ?? EMPTY_ORIGINS;
      return {
        originsByScene: {
          ...state.originsByScene,
          [key]: [...current.filter((candidate) => candidate.imageId !== origin.imageId), origin],
        },
      };
    });
  },
  originsFor: (projectId, sceneFile) => {
    const state = get();
    if (state.projectId !== projectId || !sceneFile) return EMPTY_ORIGINS;
    return state.originsByScene[sceneKey(projectId, sceneFile)] ?? EMPTY_ORIGINS;
  },
  reset: () => set({ projectId: null, originsByScene: {} }),
}));
