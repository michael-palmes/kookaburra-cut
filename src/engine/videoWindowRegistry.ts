import { create } from "zustand";

/** Which mounted scenes consume the sidecar videoWindow block via `useSceneVideoWindow` (the layeredScreenshotRegistry pattern): `VideoWindowFallback` renders the window itself only when the scene's TSX doesn't. Count-based, registered from a layout effect so the fallback's render gate settles before any frame paints. */
interface VideoWindowRegistryState {
  consumers: Record<number, number>;
  register: (index: number) => void;
  unregister: (index: number) => void;
}

export const useVideoWindowRegistry = create<VideoWindowRegistryState>((set) => ({
  consumers: {},
  register: (index) =>
    set((s) => ({ consumers: { ...s.consumers, [index]: (s.consumers[index] ?? 0) + 1 } })),
  unregister: (index) =>
    set((s) => {
      const n = (s.consumers[index] ?? 0) - 1;
      const consumers = { ...s.consumers };
      if (n <= 0) delete consumers[index];
      else consumers[index] = n;
      return { consumers };
    }),
}));

/** True when the scene at `index` has a mounted `useSceneVideoWindow` consumer. */
export function useSceneConsumesVideoWindow(index: number | undefined): boolean {
  return useVideoWindowRegistry((s) => index !== undefined && (s.consumers[index] ?? 0) > 0);
}
