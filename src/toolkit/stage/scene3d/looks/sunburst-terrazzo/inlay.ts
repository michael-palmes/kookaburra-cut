import { loopSeconds } from "../../kit/clock";
import { medallionTurn } from "../../kit/medallion";

/** Medallion layout (world units) and clock: the border ring, the glint cadence and the arc drift. The loop closes at 480 s with the default 4 minute turn. */
export const TERRAZZO = {
  floorY: -2,
  ceilingY: 5.5,
  border: 21.9,
  glintPeriod: 12,
  arcPeriod: 96,
  loop: 480,
} as const;

/** Clock values: the ray turn (radians), the outward glint run (0 to 1 every 12 s) and the arc drift (radians). */
export interface TerrazzoPhases {
  turn: number;
  glint: number;
  arc: number;
}

export function terrazzoPhases(t: number, turnMinutes: number): TerrazzoPhases {
  return {
    turn: medallionTurn(t, turnMinutes * 60),
    glint: loopSeconds(t, TERRAZZO.glintPeriod) / TERRAZZO.glintPeriod,
    arc: medallionTurn(t, TERRAZZO.arcPeriod),
  };
}

/** The far fade from the Fade radius slider: the floor washes toward the backing from `start` and lands on it at `end`, in the sketch's 28 / 45 proportion. */
export function terrazzoFade(fadeRadius: number): { start: number; end: number } {
  return { start: (fadeRadius * 28) / 45, end: fadeRadius };
}

/** Rays snap to even counts so the two-tone wedges meet across the angle seam. */
export function terrazzoRays(rays: number): number {
  return Math.max(2, Math.round(rays / 2) * 2);
}
