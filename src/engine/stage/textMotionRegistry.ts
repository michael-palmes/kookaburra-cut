import { create } from "zustand";

/** Which mounted scenes contain text elements with explicit TSX animation props: the edit bar's Text-motion panel reads this to warn that a pick may not show, and to offer the sidecar `textAnimationForce` override, instead of printing a TSX hint nobody understands (Michael's live-round call). Count-based per scene index, since scenes render into multiple targets (the compositor's A/B pair) and elements mount/unmount across transitions, so each coded element increments on mount and decrements on unmount. Registered from inside the canvas (an effect, never the render path); read only by UI chrome, so export purity is untouched. */
interface TextMotionRegistryState {
  coded: Record<number, number>;
  register: (index: number) => void;
  unregister: (index: number) => void;
}

export const useTextMotionRegistry = create<TextMotionRegistryState>((set) => ({
  coded: {},
  register: (index) => set((s) => ({ coded: { ...s.coded, [index]: (s.coded[index] ?? 0) + 1 } })),
  unregister: (index) =>
    set((s) => {
      const n = (s.coded[index] ?? 0) - 1;
      const coded = { ...s.coded };
      if (n <= 0) delete coded[index];
      else coded[index] = n;
      return { coded };
    }),
}));

/** True when the scene at `index` has at least one coded-motion text element mounted. */
export function useSceneHasCodedTextMotion(index: number): boolean {
  return useTextMotionRegistry((s) => (s.coded[index] ?? 0) > 0);
}
