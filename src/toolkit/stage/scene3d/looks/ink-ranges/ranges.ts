import type { RingBandShape, RingFloorShape } from "../../kit";
import type { Scene3dCompanionLighting } from "../../types";

/** Ink ranges layout: five ridge bands round the stage (near to far), a sky wall and a valley floor, all in one F5 ring stack. */

export const INK_FLOOR_Y = -2.2;
/** Every spin loops exactly over this many seconds of look time. */
export const INK_PERIOD = 3600;
/** The horizon slider's top: bands are built tall enough for it. */
export const INK_HORIZON_MAX = 1.4;
export const INK_SKY_RADIUS = 120;

/** `turns` per period (8 is 0.8 degrees/s, 2 is 0.2), signed so neighbours counter-rotate; `wisp` is the mist's own turns against its band. */
export const INK_RIDGES = [
  { radius: 15, lo: -1.3, hi: 0.5, turns: 8, wisp: 30, seed: 11 },
  { radius: 21, lo: -0.9, hi: 1.8, turns: -6, wisp: 28, seed: 18.3 },
  { radius: 29, lo: -0.2, hi: 4.2, turns: 4, wisp: 24, seed: 25.6 },
  { radius: 40, lo: 0.6, hi: 7.4, turns: -2, wisp: 21, seed: 32.9 },
  { radius: 54, lo: 1.8, hi: 10.8, turns: 1, wisp: 17, seed: 40.2 },
] as const;

/** Which ridges each Ranges count shows, near to far: two keeps foothills and the high range. */
const LAYER_SETS: Record<number, readonly number[]> = {
  2: [0, 3],
  3: [0, 2, 3],
  4: [0, 1, 2, 3],
  5: [0, 1, 2, 3, 4],
};

/** Visible ridge indices for the Ranges slider (rounded, clamped to 2..5). */
export function inkVisibleRidges(layers: number): readonly number[] {
  const n = Math.min(5, Math.max(2, Math.round(Number.isFinite(layers) ? layers : 4)));
  return LAYER_SETS[n];
}

/** A crest height scaled about the floor by the Horizon height slider. */
export function inkRidgeHeight(y: number, horizon: number): number {
  return INK_FLOOR_Y + (y - INK_FLOOR_Y) * horizon;
}

/** Stack input order: the sky wall is band 0, ridge `k` is band `k + 1`, the floor comes last. */
export const INK_BANDS: RingBandShape[] = [
  { radius: INK_SKY_RADIUS, bottom: INK_FLOOR_Y, top: 160 },
  ...INK_RIDGES.map((r) => ({
    radius: r.radius,
    bottom: INK_FLOOR_Y,
    top: inkRidgeHeight(r.hi + 0.6, INK_HORIZON_MAX),
  })),
];
export const INK_FLOOR: RingFloorShape = { radius: INK_SKY_RADIUS, y: INK_FLOOR_Y };

/** The disc sits 32 degrees right of the default view, grazing the far range's crests. */
export const INK_DISC_AZIMUTH_DEG = 32;

export function inkDiscElevationDeg(horizon: number): number {
  return 3 + 8.6 * horizon;
}

/** Unit direction from the stage to the disc (the default camera looks down -z), written into `out`. */
export function inkDiscDirection(horizon: number, out: number[] = [0, 0, 0]): number[] {
  const az = (INK_DISC_AZIMUTH_DEG * Math.PI) / 180;
  const el = (inkDiscElevationDeg(horizon) * Math.PI) / 180;
  out[0] = Math.sin(az) * Math.cos(el);
  out[1] = Math.sin(el);
  out[2] = -Math.cos(az) * Math.cos(el);
  return out;
}

/** Matching rig: a soft low sun (light) or cool dim moon (dark) on the disc's bearing, so the handset takes its rim from the disc. */
export function inkLighting(mode: "light" | "dark", horizon: number): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:dawn", intensity: dark ? 0.25 : 0.7, rotationDeg: 0 },
    sun: {
      azimuthDeg: 180 - INK_DISC_AZIMUTH_DEG,
      elevationDeg: Math.round(inkDiscElevationDeg(horizon)),
      intensity: dark ? 0.9 : 1.6,
      kelvin: dark ? 8200 : 4300,
      angularDeg: 3,
    },
    ambient: dark ? 0.16 : 0.45,
  };
}
