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

/** Centripetal Catmull-Rom exponent: 0.5 is the alpha that keeps the curve free of cusps and self-intersections on unevenly spaced points. EXPORT CONTRACT (rig paths re-render if it changes). */
export const CATMULL_ROM_ALPHA = 0.5;

type V3 = readonly [number, number, number];

const knotStep = (a: V3, b: V3, alpha: number): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return (dx * dx + dy * dy + dz * dz) ** (alpha / 2);
};

/** Barry-Goldman evaluation of the non-uniform curve through p1 -> p2, returning both the point and the derivative with respect to the knot parameter. Duplicated neighbours (the endpoint trick) collapse their pyramid level to the shared point rather than dividing by a zero knot span. */
function evalCatmullRom(
  p0: V3,
  p1: V3,
  p2: V3,
  p3: V3,
  u: number,
  alpha: number,
): { point: [number, number, number]; tangent: [number, number, number] } {
  const d01 = knotStep(p0, p1, alpha);
  const d12 = knotStep(p1, p2, alpha);
  const d23 = knotStep(p2, p3, alpha);
  if (d12 === 0) return { point: [p1[0], p1[1], p1[2]], tangent: [0, 0, 0] };
  const t0 = 0;
  const t1 = d01;
  const t2 = t1 + d12;
  const t3 = t2 + d23;
  const t = t1 + u * d12;
  const s02 = t2 - t0;
  const s13 = t3 - t1;

  const point: [number, number, number] = [0, 0, 0];
  const tangent: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const a1 = d01 === 0 ? p1[i] : ((t1 - t) * p0[i] + (t - t0) * p1[i]) / d01;
    const a1d = d01 === 0 ? 0 : (p1[i] - p0[i]) / d01;
    const a2 = ((t2 - t) * p1[i] + (t - t1) * p2[i]) / d12;
    const a2d = (p2[i] - p1[i]) / d12;
    const a3 = d23 === 0 ? p2[i] : ((t3 - t) * p2[i] + (t - t2) * p3[i]) / d23;
    const a3d = d23 === 0 ? 0 : (p3[i] - p2[i]) / d23;

    const b1 = ((t2 - t) * a1 + (t - t0) * a2) / s02;
    const b1d = (a2 - a1 + (t2 - t) * a1d + (t - t0) * a2d) / s02;
    const b2 = ((t3 - t) * a2 + (t - t1) * a3) / s13;
    const b2d = (a3 - a2 + (t3 - t) * a2d + (t - t1) * a3d) / s13;

    point[i] = ((t2 - t) * b1 + (t - t1) * b2) / d12;
    // dC/du = dC/dt · dt/du, and dt/du is exactly the p1 -> p2 knot span, so the divide cancels.
    tangent[i] = b2 - b1 + (t2 - t) * b1d + (t - t1) * b2d;
  }
  return { point, tangent };
}

/** Position on the centripetal Catmull-Rom curve through `p1` (u=0) and `p2` (u=1); `p0`/`p3` are the shaping neighbours, duplicated at a path's ends. EXPORT CONTRACT. */
export function catmullRom(
  p0: V3,
  p1: V3,
  p2: V3,
  p3: V3,
  u: number,
  alpha: number = CATMULL_ROM_ALPHA,
): [number, number, number] {
  return evalCatmullRom(p0, p1, p2, p3, u, alpha).point;
}

/** The analytic derivative of `catmullRom` at `u` (never a finite difference, so a tangent aim is exact and reproducible); zero-length when the segment is degenerate, which callers treat as "no tangent". */
export function catmullRomTangent(
  p0: V3,
  p1: V3,
  p2: V3,
  p3: V3,
  u: number,
  alpha: number = CATMULL_ROM_ALPHA,
): [number, number, number] {
  return evalCatmullRom(p0, p1, p2, p3, u, alpha).tangent;
}

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
