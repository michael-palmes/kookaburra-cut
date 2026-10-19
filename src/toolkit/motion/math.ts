import { type EaseOptions, ease } from "../../engine/ease";

export { lerp } from "../../engine/keyframes";

/** Clamps to [0, 1]; NaN reads as 0. */
export function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

/** Eased progress of `localMs` through [startMs, endMs] (the time is clamped, a Back ease may still overshoot); a zero or negative span steps from 0 to 1 at `startMs`. */
export function ramp(
  localMs: number,
  startMs: number,
  endMs: number,
  easeName = "linear",
  opts?: EaseOptions,
): number {
  if (!(endMs > startMs)) return localMs >= startMs ? 1 : 0;
  return ease(easeName, (localMs - startMs) / (endMs - startMs), opts);
}
