import { remapScreenUv, type ScreenUvMap } from "../../engine/screenFit";
import { ramp } from "../motion/math";

/** A display rectangle in screen UV, `[u0, v0, u1, v1]`: u runs right and v down from the top-left. */
export type ScreenUvRect = [number, number, number, number];

/** Where a card's own UV (s right, t up, three's plane) samples the display's texture: `origin + s * s + t * t`. A display's crop, turn and flip are all affine, so three corners fix it. */
export interface RegionSampling {
  origin: [number, number];
  s: [number, number];
  t: [number, number];
}

/** The texture sampling for a card that shows `rect` of a display mapped by `map`. */
export function regionSampling(map: ScreenUvMap, rect: ScreenUvRect): RegionSampling {
  const [u0, v0, u1, v1] = rect;
  const bottomLeft = remapScreenUv(u0, v1, map);
  const bottomRight = remapScreenUv(u1, v1, map);
  const topLeft = remapScreenUv(u0, v0, map);
  return {
    origin: bottomLeft,
    s: [bottomRight[0] - bottomLeft[0], bottomRight[1] - bottomLeft[1]],
    t: [topLeft[0] - bottomLeft[0], topLeft[1] - bottomLeft[1]],
  };
}

/** The display rectangle a round lens of `radius` (fitted units) over `centre` shows at `zoom` times. */
export function lensRect(
  centre: [number, number],
  radius: number,
  zoom: number,
  display: { width: number; height: number },
): ScreenUvRect {
  const reach = radius / (zoom > 0 ? zoom : 1);
  const du = reach / display.width;
  const dv = reach / display.height;
  return [centre[0] - du, centre[1] - dv, centre[0] + du, centre[1] + dv];
}

export interface RegionLiftTiming {
  /** Scene ms the lift starts (default 0). */
  at?: number;
  /** Lift length in ms (default 600). */
  durationMs?: number;
  /** Both ways (default `outCubic`, so it lands softly too). */
  ease?: string;
  /** Scene ms it starts settling back onto the glass; absent stays up. */
  outAt?: number;
  /** Settle length in ms (default `durationMs`). */
  outDurationMs?: number;
}

/** How far through its lift a region is at `localMs`, 0 on the glass to 1 fully up. */
export function regionLift(localMs: number, timing: RegionLiftTiming = {}): number {
  const { at = 0, durationMs = 600, ease = "outCubic", outAt, outDurationMs } = timing;
  const up = ramp(localMs, at, at + durationMs, ease);
  if (outAt === undefined) return up;
  return up * (1 - ramp(localMs, outAt, outAt + (outDurationMs ?? durationMs), ease));
}
