import { loopSeconds } from "../../kit/clock";
import type { DishShape } from "../../kit/dish";
import { fract } from "../../kit/math";

/** Sand table layout and clock: the ball draws one closed polar rose every `loop` seconds (`turns` turns, the Petals slider sets its radial lobes), the ribbon stores path time every `pathStep` seconds and the sand dish rises from `dishStart` so far grooves face a level camera. */
export const SAND = {
  floorY: -2.3,
  loop: 1800,
  turns: 12,
  startAngle: -2.466,
  startOffset: 62,
  pathStep: 0.16,
  halfWidth: 0.8,
  ballRadius: 0.26,
  ballSink: 0.3,
  sunAzimuth: 2.2,
  swingPeriod: 40,
  swingPhase: 10,
  dishStart: 9,
  dishSpan: 31,
  dishRadius: 58,
} as const;

/** Ribbon segments for one loop: path time `i * pathStep` at segment `i`. */
export const SAND_SEGMENTS = Math.round(SAND.loop / SAND.pathStep);

/** The rose's radial band: lobes between `clear` and `reach` (world units). */
export interface SandRose {
  clear: number;
  reach: number;
  petals: number;
}

/** Whole petals and grooves: the rose closes only for whole lobe counts. */
export function sandRose(clear: number, reach: number, petals: number): SandRose {
  return { clear, reach: Math.max(reach, clear + 2), petals: Math.max(1, Math.round(petals)) };
}

const TAU = Math.PI * 2;

/** The ball's xz at path time `s` (seconds into the loop), as the groove vertex shader places it; writes into `out` when given. */
export function sandPath(
  s: number,
  rose: SandRose,
  out: [number, number] = [0, 0],
): [number, number] {
  const u = s / SAND.loop;
  const mid = (rose.clear + rose.reach) / 2;
  const half = (rose.reach - rose.clear) / 2;
  const r = mid + half * Math.cos(TAU * fract(rose.petals * u));
  const a = SAND.startAngle + TAU * fract(SAND.turns * u);
  out[0] = Math.sin(a) * r;
  out[1] = -Math.cos(a) * r;
  return out;
}

/** The sand dish for the Dish rise slider: flat under the clearing, rising past the near grooves (kit `dishHeight`). */
export function sandDishShape(rise: number): DishShape {
  return { start: SAND.dishStart, span: SAND.dishSpan, rise };
}

/** Path time of the ball at look time `t`, wrapped into the loop. */
export function sandBallTime(t: number): number {
  return loopSeconds(t + SAND.startOffset, SAND.loop);
}

/** Ribbon draw split at path time `tm`: segments before `cut` are the newest groove, drawn last so it lands on top across the loop seam. */
export function sandCut(tm: number): number {
  return Math.min(SAND_SEGMENTS, Math.floor(tm / SAND.pathStep) + 1);
}

/** The virtual sun's azimuth (radians, v9 orbit convention) at look time `t`: one slow turn per loop plus a `swingDeg` sway every 40 s, so groove light shifts within seconds. */
export function sandSunAzimuth(t: number, swingDeg: number): number {
  const lt = loopSeconds(t, SAND.loop);
  const swing = (swingDeg * Math.PI) / 180;
  return (
    SAND.sunAzimuth +
    (TAU * lt) / SAND.loop +
    swing * Math.sin((TAU * (lt - SAND.swingPhase)) / SAND.swingPeriod)
  );
}

/** Writes the unit sun direction at look time `t` without allocating. */
export function writeSandSun(
  target: { set(x: number, y: number, z: number): unknown },
  t: number,
  swingDeg: number,
  heightDeg: number,
): void {
  const az = sandSunAzimuth(t, swingDeg);
  const el = (heightDeg * Math.PI) / 180;
  target.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}
