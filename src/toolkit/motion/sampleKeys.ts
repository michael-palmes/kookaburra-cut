import { type EaseOptions, ease } from "../../engine/ease";
import { lerp, sampleKeyProperty, sortKeys } from "../../engine/keyframes";

/** One key: a scene-local time, the ease of the segment ARRIVING at it, and any values. */
export type MotionKey = { tMs: number; ease?: string; [prop: string]: unknown };

export interface SampleKeysOptions extends EaseOptions {
  /** Ease for segments whose arriving key names none (default `linear`). */
  ease?: string;
}

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** The sampled values: every key property except `tMs` and `ease`. */
export type SampledKeys<K> = {
  [P in Exclude<KeysOfUnion<K>, "tMs" | "ease">]: K extends { [Q in P]?: infer V }
    ? Exclude<V, undefined>
    : never;
};

const isNumber = (v: unknown): v is number => typeof v === "number";

function mixValue(a: unknown, b: unknown, t: number): unknown {
  if (isNumber(a) && isNumber(b)) return lerp(a, b, t);
  if (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every(isNumber) &&
    b.every(isNumber)
  ) {
    return a.map((v, i) => lerp(v, b[i] as number, t));
  }
  return a;
}

/** Samples keyed values at `localMs`: holds the first key before it and the last after it; each segment eases by its arriving key's `ease`. Numbers and equal-length number arrays interpolate, anything else holds the earlier key's value. A property missing from a key interpolates across the keys that set it. */
export function sampleKeys<K extends MotionKey>(
  keys: readonly K[],
  localMs: number,
  opts: SampleKeysOptions = {},
): SampledKeys<K> {
  const sorted = sortKeys(keys);
  const fallback = opts.ease ?? "linear";
  const curve = opts.overshoot === undefined ? undefined : { overshoot: opts.overshoot };
  const easeT = (t: number, _before: K, after: K) =>
    ease(typeof after.ease === "string" ? after.ease : fallback, t, curve);
  const out: Record<string, unknown> = {};
  for (const key of sorted) {
    for (const prop of Object.keys(key)) {
      if (prop === "tMs" || prop === "ease" || prop in out) continue;
      out[prop] = sampleKeyProperty(sorted, localMs, (k) => k[prop], mixValue, easeT);
    }
  }
  return out as SampledKeys<K>;
}
