/** Pure px↔ms mapping for the timeline dock, shared by the playback bar and the animation lane; structure-pinned in unit tests so scrub geometry can't drift between them. */

/** The scrub step (ms); parity with the old range input's `step={16}`. */
export const SCRUB_STEP_MS = 16;

/** Track x → clock ms: clamped, proportional, snapped to `stepMs` (old range-input semantics), never past either end. */
export function msFromTrackX(
  x: number,
  width: number,
  durationMs: number,
  stepMs: number = SCRUB_STEP_MS,
): number {
  if (width <= 0 || durationMs <= 0) return 0;
  const t = Math.min(1, Math.max(0, x / width));
  // The far end always lands exactly on the duration (a range input's max is always reachable); snapping there would fall one part-step short.
  if (t >= 1) return durationMs;
  const snapped = Math.round((t * durationMs) / stepMs) * stepMs;
  return Math.min(durationMs, Math.max(0, snapped));
}

/** Clock ms → playhead fraction (0..1), for `left: {fraction * 100}%`. */
export function playheadFraction(currentMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, currentMs / durationMs));
}

export interface SceneCellSpan {
  index: number;
  /** Flex weight (ms of track this cell owns). */
  weight: number;
}

/** Scene cells tile the track exactly: cell i runs from its slot's `startMs` to the next slot's `startMs` (last to `totalMs`); transitions overlap slots so raw durations would over-count, and tiling on start boundaries keeps the playhead aligned with cell edges. */
export function sceneCellSpans(
  slots: { startMs: number; durationMs: number }[],
  totalMs: number,
): SceneCellSpan[] {
  return slots.map((slot, i) => ({
    index: i,
    weight: Math.max(1, (i + 1 < slots.length ? slots[i + 1].startMs : totalMs) - slot.startMs),
  }));
}
