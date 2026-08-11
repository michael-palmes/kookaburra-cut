import { create } from "zustand";

interface StageImageRegistryState {
  consumers: Record<number, number>;
  register: (index: number) => void;
  unregister: (index: number) => void;
}

export const useStageImageRegistry = create<StageImageRegistryState>((set) => ({
  consumers: {},
  register: (index) =>
    set((state) => ({
      consumers: {
        ...state.consumers,
        [index]: (state.consumers[index] ?? 0) + 1,
      },
    })),
  unregister: (index) =>
    set((state) => {
      const count = (state.consumers[index] ?? 0) - 1;
      const consumers = { ...state.consumers };
      if (count <= 0) delete consumers[index];
      else consumers[index] = count;
      return { consumers };
    }),
}));

export function useSceneConsumesStageImages(index: number | undefined): boolean {
  return useStageImageRegistry((state) => index !== undefined && (state.consumers[index] ?? 0) > 0);
}
