import { create } from "zustand";
import type { ThemeBackdrop } from "../theme/tokens";

/** Which mounted scenes stage a backdrop, and of what resolved type: the unified Background editor reads this to warn that an image/video background will sit hidden behind world-space staging (scenes are opaque compiled components, so mount-time reporting is the only ground truth). Count-based like textMotionRegistry; registered from inside the canvas (an effect, never the render path); read only by UI chrome, so export purity is untouched. */
interface StageRegistryState {
  stages: Record<number, { count: number; backdropType: ThemeBackdrop["type"] }>;
  register: (index: number, backdropType: ThemeBackdrop["type"]) => void;
  unregister: (index: number) => void;
}

export const useStageRegistry = create<StageRegistryState>((set) => ({
  stages: {},
  register: (index, backdropType) =>
    set((s) => ({
      stages: {
        ...s.stages,
        [index]: { count: (s.stages[index]?.count ?? 0) + 1, backdropType },
      },
    })),
  unregister: (index) =>
    set((s) => {
      const n = (s.stages[index]?.count ?? 0) - 1;
      const stages = { ...s.stages };
      if (n <= 0) delete stages[index];
      else stages[index] = { ...stages[index], count: n };
      return { stages };
    }),
}));

/** The resolved backdrop type of the scene's mounted stage, or null when the scene mounts no `SceneStage` at all. */
export function useSceneStageBackdrop(index: number): ThemeBackdrop["type"] | null {
  return useStageRegistry((s) => s.stages[index]?.backdropType ?? null);
}
