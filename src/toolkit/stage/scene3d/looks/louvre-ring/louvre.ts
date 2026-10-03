import { loopSeconds } from "../../kit/clock";

const TAU = Math.PI * 2;

/** Louvre ring geometry and motion constants (world units, fractions of the sweep). */
export const LOUVRE = {
  maxSlats: 320,
  maxRows: 6,
  /** Slat feet sit on the floor line. */
  bottom: -2,
  /** Slat width as a share of the slat pitch round the ring: gaps of about 0.25 u at the default 160. */
  fill: 0.525,
  depth: 0.04,
  /** Gap between stacked rows. */
  rowGap: 0.14,
  /** The settle sway after a turn lasts this multiple of the turn (capped by the next pass). */
  tail: 1.2,
  /** Settle sway scale (radians): the sway peaks near 12 degrees. */
  sway: 0.25,
  /** Rows stagger their fronts by this share of the front width in total, so a stack turns as a diagonal. */
  stagger: 0.5,
  /** Fixed virtual light: orbit azimuth and elevation (degrees), also the companion key. */
  sunAzimuthDeg: 25,
  sunElevationDeg: 35,
} as const;

/** One slat's static anchor: the foot of its row on the ring. */
export interface LouvreSlat {
  x: number;
  y: number;
  z: number;
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));

export const louvreCount = (count: number) => clampInt(count, 2, LOUVRE.maxSlats);
export const louvreRows = (rows: number) => clampInt(rows, 1, LOUVRE.maxRows);

/** Row pitch and the slat height inside it (rows above one leave a small gap). */
export function louvreRowSize(height: number, rows: number): { pitch: number; slat: number } {
  const n = louvreRows(rows);
  const pitch = height / n;
  return { pitch, slat: n > 1 ? pitch - LOUVRE.rowGap : pitch };
}

/** Arc length between neighbouring slats. */
export const louvrePitch = (count: number, radius: number) => (TAU * radius) / louvreCount(count);

/** Static anchors, row by row from the floor, each row anticlockwise from +x (export contract: the instance order). */
export function louvreSlats(
  count: number,
  rows: number,
  radius: number,
  height: number,
): LouvreSlat[] {
  const n = louvreCount(count);
  const r = louvreRows(rows);
  const { pitch } = louvreRowSize(height, r);
  const out: LouvreSlat[] = [];
  for (let k = 0; k < r; k++) {
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * TAU;
      out.push({
        x: Math.cos(theta) * radius,
        y: LOUVRE.bottom + k * pitch,
        z: Math.sin(theta) * radius,
      });
    }
  }
  return out;
}

/** Sweep phase in [0, 1): look time over the sweep period, wrapped in double precision. */
export const louvrePhase = (t: number, period: number) => loopSeconds(t, period) / period;

/** Per-row front lag (a share of the sweep). */
export const louvreRowLag = (front: number, rows: number) =>
  (LOUVRE.stagger * front) / Math.max(1, louvreRows(rows) - 1);

/** Settle length behind a front, ending by the next pass so wide fronts still loop seamlessly. */
export const louvreTail = (front: number) => Math.min(front * LOUVRE.tail, 1 - front);

/** CPU mirror of GLSL `lrTurn`: the slat's turn (radians) at sweep offset `u` behind the front. One smootherstep full turn over `front`, then a damped sway that starts and ends at rest with zero velocity, so the ring is seamless and C1. */
export function louvreTurn(u: number, front: number): number {
  const k = Math.min(1, Math.max(0, u / front));
  const turn = TAU * k * k * k * (k * (k * 6 - 15) + 10);
  const s = Math.min(1, Math.max(0, (u - front) / louvreTail(front)));
  const settle = 6.75 * LOUVRE.sway * s * (1 - s) * (1 - s) * Math.sin(3 * Math.PI * s);
  return turn + settle;
}

/** The fixed virtual light as a unit vector (v9 orbit convention: azimuth from +z toward +x). */
export function louvreSun(): [number, number, number] {
  const az = (LOUVRE.sunAzimuthDeg * Math.PI) / 180;
  const el = (LOUVRE.sunElevationDeg * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}
