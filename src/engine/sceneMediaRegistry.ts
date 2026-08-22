import { create } from "zustand";
import type { SceneMediaFamily } from "./sceneMedia";

/** Which mounted scenes consume the sidecar media entries themselves, per family: `<SceneStage>` takes the stage family and a scene's own `<VideoWindow/>` the window family, so `SceneMediaFallback` renders only what the scene's TSX left behind. Count-based, registered from a layout effect so the fallback's render gate settles before any frame paints (the folded stageImageRegistry + videoWindowRegistry). */
interface SceneMediaRegistryState {
  consumers: Record<string, number>;
  register: (index: number, family: SceneMediaFamily) => void;
  unregister: (index: number, family: SceneMediaFamily) => void;
}

const key = (index: number, family: SceneMediaFamily) => `${index}:${family}`;

export const useSceneMediaRegistry = create<SceneMediaRegistryState>((set) => ({
  consumers: {},
  register: (index, family) =>
    set((s) => {
      const k = key(index, family);
      return { consumers: { ...s.consumers, [k]: (s.consumers[k] ?? 0) + 1 } };
    }),
  unregister: (index, family) =>
    set((s) => {
      const k = key(index, family);
      const n = (s.consumers[k] ?? 0) - 1;
      const consumers = { ...s.consumers };
      if (n <= 0) delete consumers[k];
      else consumers[k] = n;
      return { consumers };
    }),
}));

/** True when the scene at `index` mounts its own consumer for this family. */
export function useSceneConsumesMedia(
  index: number | undefined,
  family: SceneMediaFamily,
): boolean {
  return useSceneMediaRegistry(
    (s) => index !== undefined && (s.consumers[key(index, family)] ?? 0) > 0,
  );
}
