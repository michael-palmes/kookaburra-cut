import { ramp } from "../motion/math";
import type { EaseName } from "../types";

export interface CounterTiming {
  durationMs: number;
  startMs?: number;
  ease?: EaseName;
  steps?: number;
}

/** The count's progress at `localMs`: the legacy linear expression unless a timing option is set. */
export function counterProgress(props: CounterTiming, localMs: number): number {
  const { durationMs, startMs, steps } = props;
  if (startMs === undefined && props.ease === undefined && steps === undefined) {
    return durationMs <= 0 ? 1 : Math.min(1, Math.max(0, localMs / durationMs));
  }
  const p = ramp(localMs, startMs ?? 0, (startMs ?? 0) + durationMs, props.ease ?? "linear");
  if (steps === undefined || !(steps >= 1)) return p;
  const n = Math.floor(steps);
  return p >= 1 ? p : Math.floor(p * n) / n;
}
