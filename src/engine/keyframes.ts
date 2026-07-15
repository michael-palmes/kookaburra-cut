/** Generic per-property keyframe sampling shared by the camera track (engine/cameraTrack.ts) and the shared-element morph transform (engine/sharedElement.ts), so both share identical interpolation semantics; pure (no three.js, no clock reads) so it unit-tests in isolation and frames stay a pure function of `t`. */

/** Any keyframe: a global-clock time plus per-property optional fields. */
export interface TimedKey {
  tMs: number;
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const lerp3 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Sort a track copy by time (stable, later key wins at equal times). Never mutates input. */
export function sortKeys<K extends TimedKey>(track: readonly K[]): K[] {
  return [...track].sort((a, b) => a.tMs - b.tMs);
}

/** Interpolate one property across the keys that define it: linear between the surrounding keys, clamped before the first / after the last (later wins at equal times); `undefined` when no key defines the property (caller falls back to its base value). `keys` must be sorted (use `sortKeys`). */
export function sampleKeyProperty<K extends TimedKey, T>(
  keys: readonly K[],
  globalMs: number,
  pick: (k: K) => T | undefined,
  mix: (a: T, b: T, t: number) => T,
): T | undefined {
  let before: K | null = null;
  let after: K | null = null;
  for (const k of keys) {
    if (pick(k) === undefined) continue;
    if (k.tMs <= globalMs) {
      before = k; // keys are sorted; the last one at/before wins
    } else {
      after = k;
      break;
    }
  }
  const a = before ? pick(before) : undefined;
  const b = after ? pick(after) : undefined;
  if (a !== undefined && b !== undefined && before && after && after.tMs > before.tMs) {
    return mix(a, b, (globalMs - before.tMs) / (after.tMs - before.tMs));
  }
  return a !== undefined ? a : b; // clamp: before-first / after-last / single-key
}
