import { useClockStore } from "../engine/clock";

/** Where a lane may park the playhead: the scene's ATTRIBUTION window, mid incoming transition to mid outgoing transition, project ends excepted. Extracted from `TrackLane` so the clamp is one testable rule. */

export interface LaneWindow {
  windowStartMs: number;
  windowEndMs: number;
  /** No scene follows: a seek may land exactly on the window end. */
  lastScene: boolean;
}

/** Scene-local `tMs` held inside the window, one ms short of the next scene's boundary unless nothing follows, so a seek can never retarget the chrome to a neighbouring scene. The window-start floor wins on a degenerate (zero-width) window, so the cap can never undershoot into the PREVIOUS scene either. */
export function clampLaneSeek(tMs: number, w: LaneWindow): number {
  const max = Math.max(w.windowStartMs, w.lastScene ? w.windowEndMs : w.windowEndMs - 1);
  return Math.min(max, Math.max(w.windowStartMs, tMs));
}

/** Seek the clock to scene-local `tMs`, clamped to the scene's window and the project length. */
export function seekSceneLocal(slotStartMs: number, tMs: number, w: LaneWindow) {
  const clock = useClockStore.getState();
  clock.setCurrentMs(Math.min(clock.durationMs, slotStartMs + clampLaneSeek(tMs, w)));
}
