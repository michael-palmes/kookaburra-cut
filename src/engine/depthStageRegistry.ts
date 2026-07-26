import { create } from "zustand";

/** Which mounted scenes lay their content out in DEPTH BANDS (`toolkit/stage/DepthStage.tsx`). Scenes are opaque compiled components, so mount-time reporting is the only ground truth; count-based and registered from an effect inside the canvas, exactly like `stageRegistry.ts`. The bounds advisory reads it: a banded scene sizes its own layers from the camera's travel envelope, so its keys pass by construction and warning about them would be noise. UI-only, never read by the render or export path. */
interface DepthStageRegistryState {
  banded: Record<number, number>;
  register: (index: number) => void;
  unregister: (index: number) => void;
}

export const useDepthStageRegistry = create<DepthStageRegistryState>((set) => ({
  banded: {},
  register: (index) =>
    set((s) => ({ banded: { ...s.banded, [index]: (s.banded[index] ?? 0) + 1 } })),
  unregister: (index) =>
    set((s) => {
      const n = (s.banded[index] ?? 0) - 1;
      const banded = { ...s.banded };
      if (n <= 0) delete banded[index];
      else banded[index] = n;
      return { banded };
    }),
}));

export function useSceneIsBanded(index: number): boolean {
  return useDepthStageRegistry((s) => (s.banded[index] ?? 0) > 0);
}
