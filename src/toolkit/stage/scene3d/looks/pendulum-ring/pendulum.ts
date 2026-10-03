import type { Vector3 } from "three";
import { loopSeconds } from "../../kit";

const TAU = Math.PI * 2;

/** Rig constants shared by the component, its shaders and tests. */
export const PENDULUM = {
  maxCount: 72,
  maxRails: 4,
  /** Each rail out is this much wider and higher. */
  railStep: 1.6,
  railY: 8,
  /** Each rail out carries this many more bobs. */
  extraPerRail: 8,
  /** Thread lengths: longest at the front of the ring, shortest at the back. */
  lengthMax: 5.2,
  lengthMin: 4.4,
  /** The front bob's rough swing period, seconds; the back runs faster. */
  swingSeconds: 10,
  /** The virtual sun's rough turn, seconds. */
  sunSeconds: 120,
  sunElevation: 0.55,
} as const;

/** Bobs on rail `k`. */
export const railCount = (count: number, k: number) => count + PENDULUM.extraPerRail * k;

/** Pendulums drawn for a count and rail number (rail-major). */
export function pendulumTotal(count: number, rails: number): number {
  let total = 0;
  for (let k = 0; k < rails; k++) total += railCount(count, k);
  return total;
}

/** Fixed capacity: every slider at its maximum. */
export const PENDULUM_CAPACITY = pendulumTotal(PENDULUM.maxCount, PENDULUM.maxRails);

/** Rail, index on the rail and that rail's count for pendulum `s` (the GLSL `prRail` mirror). */
export function pendulumAt(s: number, count: number): { rail: number; index: number; n: number } {
  let rail = 0;
  let index = s;
  let n = count;
  for (let r = 0; r < PENDULUM.maxRails - 1 && index >= n; r++) {
    index -= n;
    rail++;
    n += PENDULUM.extraPerRail;
  }
  return { rail, index, n };
}

/** Steps from the front of the ring, mirrored, so frequencies match on both sides and the snakes have no seam. */
export const pendulumTri = (index: number, n: number) => Math.min(index, n - index);

/** Swings the front bob makes per realign period (the back bob adds half the rail count). */
export const swingBase = (period: number) =>
  Math.max(1, Math.round(period / PENDULUM.swingSeconds));

/** Realign phase in [0, 1): 0 is the moment every bob lines up. */
export function pendulumPhase(t: number, period: number, epoch: number): number {
  return loopSeconds(t + epoch, period) / period;
}

/** Thread length for a mirrored step. */
export function pendulumLength(tri: number, n: number): number {
  const k = tri / (n * 0.5);
  return PENDULUM.lengthMax + (PENDULUM.lengthMin - PENDULUM.lengthMax) * k;
}

/** Swing angle (radians, along the rail) of a pendulum: whole swings per period, so all realign at phase 0. */
export function pendulumAngle(
  tri: number,
  n: number,
  phase: number,
  period: number,
  swing: number,
) {
  const amp = Math.asin(Math.min(1, swing / pendulumLength(tri, n)));
  return amp * Math.cos(TAU * loopSeconds((swingBase(period) + tri) * phase, 1));
}

/** Unit direction to the drifting virtual sun, a whole number of turns per realign period. */
export function writeSunDirection(out: Vector3, t: number, period: number): void {
  const turns = Math.max(1, Math.round(period / PENDULUM.sunSeconds));
  const az = TAU * loopSeconds((loopSeconds(t, period) * turns) / period, 1) + 0.8;
  const el = PENDULUM.sunElevation;
  out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}
