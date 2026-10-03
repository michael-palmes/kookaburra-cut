import { BufferAttribute, BufferGeometry } from "three";
import { createSeededRandom } from "../../../../../engine/rng";
import { lookLuminance } from "../../kit/material";

/** Aurora veil constants: curtains are built at their max and the Curtains slider draws the first N, so geometry never rebuilds. Every motion is an integer harmonic of `period`, so the look loops exactly. */
export const AURORA = {
  maxCurtains: 5,
  segments: 160,
  rows: 24,
  period: 240,
  seed: 0xa0b0,
  /** Sketch spreads round the Distance and Hem height sliders: radius +-7, hem +-1.2. */
  radiusSpread: 14,
  hemSpread: 2.4,
} as const;

/** Brightness wave periods along each curtain (harmonics of the 240 s loop: 24, 20, 16, 12 and 20 s). */
const PULSE_HARMONICS = [10, 12, 15, 20, 12] as const;

export interface AuroraCurtain {
  /** Bearing offset from the even spacing, radians (curtain 0 holds 0, so it always stands behind the stage). */
  jitter: number;
  /** Angular span, radians. */
  span: number;
  /** Radius and hem offsets from the Distance and Hem height sliders. */
  radius: number;
  hem: number;
  /** Curtain height above its hem. */
  height: number;
  /** Ray noise seed (integer). */
  seed: number;
  /** Fold, hem and pulse phases, radians. */
  phase: [number, number, number, number];
  /** Brightness wave harmonic of the loop. */
  pulse: number;
}

/** The approved sketch's seeded curtains, drawn in its exact order (curtain 0 skips the bearing jitter). */
export function auroraCurtains(): AuroraCurtain[] {
  const rand = createSeededRandom(AURORA.seed);
  const out: AuroraCurtain[] = [];
  for (let i = 0; i < AURORA.maxCurtains; i++) {
    const jitter = i === 0 ? 0 : (rand() - 0.5) * 0.5;
    const span = 0.9 + rand() * 0.5;
    const radius = (rand() - 0.5) * AURORA.radiusSpread;
    const hem = (rand() - 0.5) * AURORA.hemSpread;
    const height = 20 + rand() * 8;
    const phase: [number, number, number, number] = [
      rand() * 6.28,
      rand() * 6.28,
      rand() * 6.28,
      rand() * 6.28,
    ];
    out.push({
      jitter,
      span,
      radius,
      hem,
      height,
      seed: 11 + i * 17,
      phase,
      pulse: PULSE_HARMONICS[i],
    });
  }
  return out;
}

/** Every curtain as one strip mesh: `position` is (s, v, curtain index), the vertex shader folds it onto the ring; per-curtain constants ride in `aShape` (jitter, span, radius, hem), `aRay` (height, seed, pulse, pulse phase) and `aPhase`. Curtains are consecutive index ranges, so `setDrawRange(0, n * auroraCurtainIndices())` shows the first n. */
export function auroraCurtainGeometry(curtains: readonly AuroraCurtain[]): BufferGeometry {
  const { segments: S, rows: R } = AURORA;
  const perCurtain = (S + 1) * (R + 1);
  const n = curtains.length;
  const position = new Float32Array(n * perCurtain * 3);
  const shape = new Float32Array(n * perCurtain * 4);
  const ray = new Float32Array(n * perCurtain * 4);
  const phase = new Float32Array(n * perCurtain * 4);
  const index = new Uint32Array(n * S * R * 6);
  let v = 0;
  let o = 0;
  curtains.forEach((c, k) => {
    const base = k * perCurtain;
    for (let j = 0; j <= R; j++) {
      for (let i = 0; i <= S; i++) {
        position.set([i / S, j / R, k], v * 3);
        shape.set([c.jitter, c.span, c.radius, c.hem], v * 4);
        ray.set([c.height, c.seed, c.pulse, c.phase[0] * 0.7], v * 4);
        phase.set(c.phase, v * 4);
        v++;
      }
    }
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < S; i++) {
        const a = base + j * (S + 1) + i;
        const b = a + S + 1;
        index.set([a, a + 1, b, a + 1, b + 1, b], o);
        o += 6;
      }
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("aShape", new BufferAttribute(shape, 4));
  geometry.setAttribute("aRay", new BufferAttribute(ray, 4));
  geometry.setAttribute("aPhase", new BufferAttribute(phase, 4));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

/** Index count of one curtain strip. */
export function auroraCurtainIndices(): number {
  return AURORA.segments * AURORA.rows * 6;
}

/** Below this backing luminance (linear) the veils add light like the real thing; above it they lay pastel colour over the sky. */
export const AURORA_DARK_BACKING = 0.2;

/** True when the veils should blend additively: a dark backing. Read from the backing, so Theme-derived and hand-picked palettes keep their polarity. */
export function auroraAdditive(backingHex: string): boolean {
  return lookLuminance(backingHex) < AURORA_DARK_BACKING;
}

/** Curtain opacity at Brightness 0.8, scaled linearly: the sketch's 0.75 when additive, a firmer 1.1 (clamped per fragment) when laid over a light sky, so pastel veils still read at picker size. */
export function auroraAlpha(brightness: number, additive: boolean): number {
  return (additive ? 0.75 : 1.1) * (brightness / 0.8);
}
