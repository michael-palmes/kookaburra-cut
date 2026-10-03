import { loopSeconds } from "../../kit/clock";
import { SEA, SEA_HORIZON_Y } from "./coast";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

type Vec3 = [number, number, number];

/** Long exposure constants: one sky turn per `period` seconds at Sky turn 1 (2 degrees a second), the sea horizon as a dome direction height (the sea's far edge), star bands `bandWidth` radians apart in `cells` angular cells. */
export const LONG_EXPOSURE = {
  radius: SEA.domeRadius,
  period: 180,
  horizonY: SEA_HORIZON_Y,
  bandWidth: 0.0105,
  cells: 9,
  crossPhase: 0.47,
} as const;

/** The Southern Cross and the Pointers: right ascension (hours), declination (degrees) and head weight. */
export const NAMED_STARS = [
  { name: "Acrux", ra: 12.443, dec: -63.1, weight: 1 },
  { name: "Mimosa", ra: 12.795, dec: -59.69, weight: 0.95 },
  { name: "Gacrux", ra: 12.519, dec: -57.11, weight: 0.9 },
  { name: "Imai", ra: 12.252, dec: -58.75, weight: 0.7 },
  { name: "Ginan", ra: 12.356, dec: -60.4, weight: 0.45 },
  { name: "Rigil Kentaurus", ra: 14.66, dec: -60.83, weight: 1 },
  { name: "Hadar", ra: 14.064, dec: -60.37, weight: 0.95 },
] as const;

/** The south celestial pole at an azimuth (degrees right of the stage's -z) and height, with the sky's in-plane axes: `v` is world up projected off the pole, `u = pole x v` points right as seen facing the pole. */
export function poleBasis(azimuthDeg: number, heightDeg: number): { pole: Vec3; u: Vec3; v: Vec3 } {
  const az = azimuthDeg * DEG;
  const el = heightDeg * DEG;
  const pole: Vec3 = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const up = pole[1];
  const vRaw: Vec3 = [-up * pole[0], 1 - up * pole[1], -up * pole[2]];
  const vl = Math.hypot(...vRaw);
  const v: Vec3 = [vRaw[0] / vl, vRaw[1] / vl, vRaw[2] / vl];
  const u: Vec3 = [
    pole[1] * v[2] - pole[2] * v[1],
    pole[2] * v[0] - pole[0] * v[2],
    pole[0] * v[1] - pole[1] * v[0],
  ];
  return { pole, u, v };
}

/** Named stars as (pole distance, phase, weight) in radians: phase grows with right ascension, so the Pointers follow the Cross round the pole. */
export function namedStarPolar(): Vec3[] {
  return NAMED_STARS.map((s) => [
    (90 + s.dec) * DEG,
    (s.ra * 15 * DEG + LONG_EXPOSURE.crossPhase) % TAU,
    s.weight,
  ]);
}

/** The sky's turn in [0, TAU): look time wrapped on the CPU (exact loop every period / turn), plus Sky hour as a fixed offset. A fragment's phase is its angle round the pole plus this, so heads move clockwise as seen facing the pole. */
export function skyTurn(t: number, turn: number, skyHour: number): number {
  const spun = (loopSeconds(t * turn, LONG_EXPOSURE.period) / LONG_EXPOSURE.period) * TAU;
  const a = (spun + (skyHour / 24) * TAU) % TAU;
  return a < 0 ? a + TAU : a;
}
