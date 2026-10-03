import { loopSeconds } from "../../kit/clock";
import { lookLuminance } from "../../kit/material";

/** Mezzotint sky constants: the plate's key range, the burr at Grain size 4 (340 cells per radian, about 4 px at 1080p) and the sketch's cloud thresholds at Cloud cover 0.5. */
export const MEZZO = {
  keyMin: 0.04,
  keyMax: 0.7,
  cellsAtGrain4: 340,
  /** Cloud thresholds slide this far per unit of Cloud cover. */
  coverSlide: 0.24,
} as const;

/** The plate's mean tone (0 rocked Ground, 1 burnished): where the backing's luminance sits between the two inks, so pale backings print a burnished dawn and dark ones a rocked night, and the Backing control still drives the dome. */
export function mezzotintKey(groundHex: string, burnishHex: string, backingHex: string): number {
  const g = lookLuminance(groundHex);
  const b = lookLuminance(burnishHex);
  const k = (lookLuminance(backingHex) - g) / Math.max(b - g, 1e-4);
  return Math.min(MEZZO.keyMax, Math.max(MEZZO.keyMin, k));
}

/** Burr cells per radian of sky for a Grain size (larger grain, fewer cells). */
export function mezzotintCells(grain: number): number {
  return (MEZZO.cellsAtGrain4 * 4) / Math.max(grain, 0.5);
}

/** Cloud threshold shift: more cover lowers every threshold, 0 at the sketch's 0.5. */
export function mezzotintCoverShift(cover: number): number {
  return (0.5 - cover) * MEZZO.coverSlide;
}

/** The glow band's elevation (sin), the azimuth sway's amplitude (radians) and its breath's depth, as the dome shader draws them. */
export const MEZZO_GLOW = { sinElevation: 0.27, sway: 0.35, breath: 0.15 } as const;

/** The glow's azimuth (radians right of -z), breath (0.7 to 1) and unit direction from the stage. */
export interface MezzoGlow {
  azimuth: number;
  breathe: number;
  direction: [number, number, number];
}

/** The glow at look time `t` on the Drift loop, written into `out` (no allocation per frame), so the land catches light where the dome glows. */
export function mezzotintGlow(
  t: number,
  period: number,
  out: MezzoGlow = { azimuth: 0, breathe: 1, direction: [0, 0, -1] },
): MezzoGlow {
  const T = (2 * Math.PI * loopSeconds(t, period)) / period;
  const e = MEZZO_GLOW.sinElevation;
  const c = Math.sqrt(1 - e * e);
  out.azimuth = MEZZO_GLOW.sway * Math.sin(T);
  out.breathe = 1 - MEZZO_GLOW.breath + MEZZO_GLOW.breath * Math.sin(3 * T);
  out.direction[0] = Math.sin(out.azimuth) * c;
  out.direction[1] = e;
  out.direction[2] = -Math.cos(out.azimuth) * c;
  return out;
}
