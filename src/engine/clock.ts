import { create } from "zustand";

/** The single source of timeline position consumed by `useTimeline()`; kept separate from the editor UI store so the export path can advance frames without reading UI state, and backed by zustand so it stays readable inside the r3f `<Canvas>` reconciler where outside React context doesn't bridge. See `docs/determinism.md`. */
interface ClockState {
  /** Current position on the global timeline, in milliseconds. */
  currentMs: number;
  /** Total project duration, in milliseconds. */
  durationMs: number;
  setCurrentMs: (ms: number) => void;
  setDurationMs: (ms: number) => void;
}

export const useClockStore = create<ClockState>((set) => ({
  // Start mid-reveal so a freshly loaded project shows content on launch; scrub left to see the fade-in.
  currentMs: 1500,
  durationMs: 5000,
  setCurrentMs: (ms) => set({ currentMs: ms }),
  setDurationMs: (ms) => set({ durationMs: ms }),
}));
