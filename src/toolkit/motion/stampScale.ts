import { lerp } from "../../engine/keyframes";
import { ramp } from "./math";

export interface StampScaleOptions {
  /** Scale before the stamp starts. */
  from?: number;
  /** Overshoot scale reached at `inMs`. */
  peak?: number;
  /** `from` to `peak`, outCubic. */
  inMs?: number;
  /** `peak` back to 1, inOutSine. */
  settleMs?: number;
}

/** A "stamped in" pop: returns the scale for ms since the stamp started (`from` before 0, 1 once settled). The defaults are part of the export contract. */
export function stampScale({
  from = 0,
  peak = 1.12,
  inMs = 180,
  settleMs = 260,
}: StampScaleOptions = {}): (msSinceStart: number) => number {
  return (ms) => {
    if (!(ms >= 0)) return from;
    if (ms < inMs) return lerp(from, peak, ramp(ms, 0, inMs, "outCubic"));
    if (ms < inMs + settleMs) return lerp(peak, 1, ramp(ms, inMs, inMs + settleMs, "inOutSine"));
    return 1;
  };
}
