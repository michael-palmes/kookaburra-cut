import type { Vector4 } from "three";
import { loopSeconds, tinyHash } from "../../kit";

/** Closed-form motion for Wash dome, all from the absolute look clock. */

export const WASH_BLOOM_SLOTS = 8;
/** Cloud-plane drift per second at wind 1 (about 1.5 degrees/s of sky), the stroke layer's slower slide, and the seconds of wind already blown at t = 0 (so a project opens on broken cloud with shadows near the stage). */
export const WASH_WIND = { x: 0.027, y: 0.01, stroke: 0.012, phase: 40 } as const;

/** Wind travel in cloud-plane seconds: the drift is this times WASH_WIND.x/y. */
export function washWind(t: number, wind: number): number {
  return t * wind + WASH_WIND.phase;
}
/** The threshold dries and creeps: amplitude and period in seconds. */
export const WASH_DRY = { amp: 0.025, period: 30 } as const;

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Field threshold inside the cloud band: more coverage, lower threshold. */
export function washThreshold(coverage: number): number {
  return 0.635 - 0.5 * coverage;
}

/** Sines of the calm band edges: below `calmDeg` of elevation the sky is one graded wash, clouds fade in over the next 4 degrees. */
export function washCalmBand(calmDeg: number): [number, number] {
  return [Math.sin(calmDeg * DEG), Math.sin((calmDeg + 4) * DEG)];
}

export function washDry(t: number): number {
  return WASH_DRY.amp * Math.sin((TAU * loopSeconds(t, WASH_DRY.period)) / WASH_DRY.period);
}

/** Backrun blooms: slot k reopens every 22 + 5k s at a hashed bearing 14 to 23 degrees up, grows, spreads its rim and fades. Writes the centre direction (xyz) and radius (w) and the amplitude; slots at or past `count` stay dark. */
export function writeWashBlooms(
  t: number,
  count: number,
  centres: Vector4[],
  amps: number[],
): void {
  for (let k = 0; k < WASH_BLOOM_SLOTS; k++) {
    if (k >= count) {
      amps[k] = 0;
      continue;
    }
    const period = 22 + 5 * k;
    const phase = (t + k * 9) / period;
    const n = Math.floor(phase);
    const u = phase - n;
    const seed = n * 7 + k * 131 + 17;
    const az = tinyHash(seed, 0, 0) * TAU;
    const el = 0.24 + tinyHash(seed + 1, 0, 0) * 0.16;
    centres[k].set(
      Math.cos(az) * Math.cos(el),
      Math.sin(el),
      Math.sin(az) * Math.cos(el),
      0.015 + 0.055 * Math.sqrt(u),
    );
    amps[k] = smooth(0, 0.12, u) * (1 - smooth(0.55, 1, u));
  }
}
