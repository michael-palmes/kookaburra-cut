import { ramp } from "../motion/math";
import type { BeatGrid } from "../music/useBeatGrid";
import type { EaseName } from "../types";

export interface CounterTiming {
  durationMs: number;
  startMs?: number;
  ease?: EaseName;
  steps?: number;
  /** Scene-local ms of each jump; each moves the count one equal share (bent by `ease`), the last landing on `to`. Wins over the window and `steps`. */
  stepsAt?: readonly number[];
}

/** The count's progress at `localMs`: the legacy linear expression unless a timing option is set. `steps` jumps wherever the EASED progress crosses each k/n (so `ease` moves the jump times, and the count holds `from` until the first crossing), `stepsAt` jumps at exact times (so `ease` bends the values instead). */
export function counterProgress(props: CounterTiming, localMs: number): number {
  const { durationMs, startMs, steps, stepsAt } = props;
  if (stepsAt?.length) {
    let done = 0;
    for (const at of stepsAt) if (at <= localMs) done++;
    return props.ease === undefined || done === 0 || done === stepsAt.length
      ? done / stepsAt.length
      : ramp(done, 0, stepsAt.length, props.ease);
  }
  if (startMs === undefined && props.ease === undefined && steps === undefined) {
    return durationMs <= 0 ? 1 : Math.min(1, Math.max(0, localMs / durationMs));
  }
  const p = ramp(localMs, startMs ?? 0, (startMs ?? 0) + durationMs, props.ease ?? "linear");
  if (steps === undefined || !(steps >= 1)) return p;
  const n = Math.floor(steps);
  return p >= 1 ? p : Math.floor(p * n) / n;
}

/** The scene-local beats a count ticks on: every grid beat from `startMs` to `startMs + durationMs` (ends included). */
export function beatsInWindow(grid: BeatGrid, startMs: number, durationMs: number): number[] {
  const endMs = startMs + durationMs;
  const first = grid.position(startMs);
  let bar = first.bar;
  let beat = first.beat;
  // Not on a beat: the next one up, wherever it falls.
  if (first.beatPhase > 0) beat += 1;
  const beats: number[] = [];
  for (let guard = 0; guard < MAX_TICKS; guard++) {
    if (beat > grid.beatsPerBar) {
      beat = 1;
      bar += 1;
    }
    const at = grid.bar(bar, beat);
    if (at > endMs) break;
    if (at >= startMs) beats.push(at);
    beat += 1;
  }
  return beats;
}

const MAX_TICKS = 4096;
