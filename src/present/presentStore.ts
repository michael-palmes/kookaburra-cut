import { create } from "zustand";
import { type DeckEvent, type DeckState, initialDeckState, stepDeck } from "./presentStateMachine";

/** Present-session state shared between the app shell, scene hosts and the driver. The clock stays monotonic for the whole session; each scene's local time is steered by its anchor (the clock value at which that scene's local 0 sits), so backgrounds never see time jump. */
interface PresentStore {
  deck: DeckState;
  sceneCount: number;
  /** Clock ms at which each mounted scene's local time is 0; unset falls back to the authored slot start. */
  anchors: Record<number, number>;
  /** 0..1 black overlay opacity for the end-of-deck fade. */
  endFade: number;
  /** Video mode transport. */
  videoPaused: boolean;
  setSceneCount: (n: number) => void;
  dispatch: (e: DeckEvent) => void;
  setAnchor: (sceneIndex: number, clockMs: number) => void;
  setEndFade: (opacity: number) => void;
  setVideoPaused: (paused: boolean) => void;
  reset: () => void;
}

export const usePresentStore = create<PresentStore>((set, get) => ({
  deck: initialDeckState(),
  sceneCount: 0,
  anchors: {},
  endFade: 0,
  videoPaused: false,
  setSceneCount: (n) => set({ sceneCount: n }),
  dispatch: (e) => set({ deck: stepDeck(get().deck, e, get().sceneCount) }),
  setAnchor: (sceneIndex, clockMs) =>
    set((s) => ({ anchors: { ...s.anchors, [sceneIndex]: clockMs } })),
  setEndFade: (opacity) => {
    if (get().endFade !== opacity) set({ endFade: opacity });
  },
  setVideoPaused: (paused) => set({ videoPaused: paused }),
  reset: () => set({ deck: initialDeckState(), anchors: {}, endFade: 0, videoPaused: false }),
}));
