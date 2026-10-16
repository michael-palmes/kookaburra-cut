import { create } from "zustand";

/** The single source of timeline position consumed by `useTimeline()`; kept separate from the editor UI store so the export path can advance frames without reading UI state, and backed by zustand so it stays readable inside the r3f `<Canvas>` reconciler where outside React context doesn't bridge. See `docs/determinism.md`. */
interface ClockState {
  /** Current position on the global timeline, in milliseconds. */
  currentMs: number;
  /** Total project duration, in milliseconds. */
  durationMs: number;
  /** Motion blur sub-sample offsets per scene index; empty outside a shutter sample (see engine/shutterPlan.ts). */
  shutter: ShutterSample;
  /** Bumped on every shutter write, so the export bridge can stamp the commit that carries it. */
  shutterSeq: number;
  setCurrentMs: (ms: number) => void;
  setDurationMs: (ms: number) => void;
  setShutter: (shutter: ShutterSample) => void;
}

/** One shutter sample: per scene index, how far its objects' time moves (`dtMs`) and the scene's inherited amount (`objects`, 0 or 1). */
export type ShutterSample = Readonly<Record<number, { dtMs: number; objects: number }>>;

export const NO_SHUTTER: ShutterSample = Object.freeze({});

export const useClockStore = create<ClockState>((set) => ({
  // Start mid-reveal so a freshly loaded project shows content on launch; scrub left to see the fade-in.
  currentMs: 1500,
  durationMs: 5000,
  shutter: NO_SHUTTER,
  shutterSeq: 0,
  setCurrentMs: (ms) => set({ currentMs: ms }),
  setDurationMs: (ms) => set({ durationMs: ms }),
  setShutter: (shutter) => set((s) => ({ shutter, shutterSeq: s.shutterSeq + 1 })),
}));
