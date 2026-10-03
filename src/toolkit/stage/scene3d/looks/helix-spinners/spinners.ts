import { createSeededRandom } from "../../../../../engine/rng";

/** Helix spinners model: a seeded grove of hanging spinners (Jennifer Townley's Asinas and Bussola), each two interleaved helices of flat bars turning opposite ways. The bar pose is closed form in the vertex shader; `barAngle` is its CPU mirror. */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const SEED = 0x7e11;
/** Exact loop: helix A makes whole turns per loop and helix B one more the other way. */
export const SPINNER_LOOP = 120;
/** Vertical pitch between bars of one helix; helix B sits half a pitch lower. */
export const BAR_GAP = 0.24;
/** Helix B's bar length relative to helix A. */
export const HELIX_B_SCALE = 0.72;
/** Phase offset of helix B against helix A, radians. */
export const HELIX_B_PHASE = 1.3;
/** World y the rods fade into. */
export const ROD_TOP = 26;
/** Distance behind the stage the clearance angle is measured from (the default camera at z 5). */
const EYE_BACK = 5;
/** Extra clearance for the centre-line spinner, so a 9:16 headline never meets it. */
const CENTRE_LIFT_DEG = 6.3;
export const MAX_SPINNERS = 48;
export const MIN_SPINNERS = 8;

export interface Spinner {
  x: number;
  z: number;
  r: number;
  /** Lowest bar's y, and the stack height. */
  bottom: number;
  len: number;
  /** Half length of a helix A bar. */
  rad: number;
  /** Twist between neighbouring bars, radians. */
  twist: number;
  /** Whole turns of helix A per loop (helix B turns once more, the other way). */
  turnsA: number;
  phase: number;
  /** Bars per helix. */
  bars: number;
}

export interface SpinnerParams {
  count: number;
  length: number;
  /** Degrees a bar. */
  twist: number;
  /** Seconds a turn of helix A. */
  turn: number;
  /** Degrees the lowest bar clears above the default eye line. */
  clearance: number;
}

/** Seeded ring band (r 13 to 42), evenly spread in angle so every azimuth has some; the first hangs higher on the centre line. */
export function layoutSpinners(params: SpinnerParams): Spinner[] {
  const n = Math.min(MAX_SPINNERS, Math.max(MIN_SPINNERS, Math.round(params.count)));
  const rand = createSeededRandom(SEED);
  const out: Spinner[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.2 + 0.6 * rand()) / n) * TAU;
    const r = 13 + 29 * rand() ** 0.8;
    out.push({
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      r,
      bottom: 0,
      len: 0,
      rad: 0,
      twist: 0,
      turnsA: 1,
      phase: 0,
      bars: 1,
    });
  }
  out[0].x = 0.4;
  out[0].z = -24;
  out[0].r = Math.hypot(0.4, 24);
  const clear = Math.tan(params.clearance * DEG);
  out.forEach((sp, i) => {
    const slope = i === 0 ? Math.tan((params.clearance + CENTRE_LIFT_DEG) * DEG) : clear;
    sp.bottom = (slope + 0.04 * rand()) * (sp.r + EYE_BACK);
    sp.len = (3.6 + 0.12 * sp.r + 1.5 * rand()) * params.length;
    sp.rad = 0.9 + 0.015 * sp.r + 0.25 * rand();
    sp.twist = params.twist * (0.79 + 0.48 * rand()) * DEG;
    sp.turnsA = Math.max(1, Math.round((SPINNER_LOOP / params.turn) * (0.83 + 0.42 * rand())));
    sp.phase = rand() * TAU;
    sp.bars = Math.max(2, Math.floor(sp.len / BAR_GAP));
  });
  return out;
}

/** Total bars (both helices) for a layout. */
export function barCount(spinners: readonly Spinner[]): number {
  return spinners.reduce((sum, sp) => sum + 2 * sp.bars, 0);
}

/** Per-bar instance data, spinner-major then helix then bar: `aSp` (x, z, half length, phase) and `aBar` (y, twist offset, helix, turns of A). */
export function spinnerBarAttributes(spinners: readonly Spinner[]): {
  sp: Float32Array;
  bar: Float32Array;
} {
  const count = barCount(spinners);
  const sp = new Float32Array(count * 4);
  const bar = new Float32Array(count * 4);
  let k = 0;
  for (const s of spinners) {
    for (let h = 0; h < 2; h++) {
      for (let j = 0; j < s.bars; j++) {
        sp.set(
          [s.x, s.z, s.rad * (h === 0 ? 1 : HELIX_B_SCALE), s.phase + h * HELIX_B_PHASE],
          k * 4,
        );
        bar.set([s.bottom + (j + 0.5 * h) * BAR_GAP, j * s.twist, h, s.turnsA], k * 4);
        k++;
      }
    }
  }
  return { sp, bar };
}

/** CPU mirror of the bar shader: a bar's yaw at loop phase `phase` (2 pi * t / SPINNER_LOOP). Helix A turns `turnsA` times a loop, helix B `turnsA + 1` times the other way. */
export function barAngle(s: Spinner, helix: 0 | 1, bar: number, phase: number): number {
  const sign = helix === 0 ? 1 : -1;
  const turns = helix === 0 ? s.turnsA : s.turnsA + 1;
  return sign * (bar * s.twist + turns * phase) + s.phase + helix * HELIX_B_PHASE;
}
