import { loopSeconds } from "../../kit/clock";
import { smoothstep } from "../../kit/math";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Origami tide constants: the Miura-ori cell at the reference pleat, the tide shape and the virtual sun. */
export const ORIGAMI = {
  /** Wall foot, below the floor line so the fade reaches the backing before the floor. */
  bottom: -3,
  /** Pleat the cell constants below are authored at. */
  refPleat: 0.85,
  /** Row pitch as a share of the pleat. */
  rowRatio: 0.965,
  /** Fold depth and chevron leg at the reference pleat. */
  depth: 0.95,
  leg: 0.95,
  /** Chevron angle and the fold angle at full tide (degrees). */
  alphaDeg: 62,
  psiMaxDeg: 56,
  /** Fold held everywhere above the floor, so a still wall still reads as paper. */
  base: 0.06,
  /** Crest counts and passes per loop of the two opposing waves (24 s and 30 s at a point over 120 s). */
  waves: [
    { crests: 3, passes: 5 },
    { crests: 2, passes: -4 },
  ],
  /** Virtual sun: raking from +x (orbit azimuth 90), this elevation, swaying once per loop. */
  sunAzimuthDeg: 90,
  sunElevationDeg: 35,
  maxColumns: 256,
  maxRows: 32,
} as const;

/** Pleat columns round the ring: even, so the depth zigzag closes. */
export function origamiColumns(radius: number, pleat: number): number {
  const n = Math.round((TAU * radius) / pleat / 2) * 2;
  return Math.min(ORIGAMI.maxColumns, Math.max(8, n));
}

/** Pleat rows from the foot to the wall top, and their exact pitch. */
export function origamiRows(top: number, pleat: number): { rows: number; pitch: number } {
  const span = Math.max(1, top - ORIGAMI.bottom);
  const rows = Math.min(
    ORIGAMI.maxRows,
    Math.max(2, Math.round(span / (pleat * ORIGAMI.rowRatio))),
  );
  return { rows, pitch: span / rows };
}

/** Grid indices (i, j) per vertex and two triangles per cell, wound so the front faces the stage. */
export function origamiGrid(
  columns: number,
  rows: number,
): { ij: Float32Array; index: Uint32Array } {
  const ij = new Float32Array((columns + 1) * (rows + 1) * 2);
  let k = 0;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= columns; i++) {
      ij[k++] = i;
      ij[k++] = j;
    }
  }
  const index = new Uint32Array(columns * rows * 6);
  const at = (i: number, j: number) => j * (columns + 1) + i;
  k = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      index.set(
        [at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)],
        k,
      );
      k += 6;
    }
  }
  return { ij, index };
}

/** Loop phase in [0, 1), wrapped in double precision. */
export const origamiPhase = (t: number, period: number) => loopSeconds(t, period) / period;

/** CPU mirror of GLSL `otFold`: fold in 0..1 at wall angle `phi` and height `y`. */
export function origamiFold(phi: number, y: number, phase: number, amp: number): number {
  const ph = TAU * phase;
  const [a, b] = ORIGAMI.waves;
  const w1 = Math.sin(a.crests * phi - a.passes * ph + 0.45 * y);
  const w2 = Math.sin(b.crests * phi - b.passes * ph + 1.3 - 0.3 * y);
  const w = smoothstep(0.25, 0.95, 0.5 + 0.5 * (0.6 * w1 + 0.4 * w2));
  const tide = amp * smoothstep(-2.2, 0.8, y);
  return Math.min(1, Math.max(0, ORIGAMI.base * smoothstep(-2.6, 0, y) + tide * w));
}

/** Miura-ori vertex for grid (i, j) at fold `f`: odd columns step inward by the fold depth, odd rows slide along the wall by the chevron leg. */
export function origamiVertex(
  i: number,
  j: number,
  f: number,
  radius: number,
  pleat: number,
  rowPitch: number,
  columns: number,
): [number, number, number] {
  const k = pleat / ORIGAMI.refPleat;
  const s = (TAU * radius) / columns;
  const psi = f * ORIGAMI.psiMaxDeg * DEG;
  const h = ORIGAMI.depth * k * Math.sin(psi);
  const p = (ORIGAMI.leg * k * Math.cos(ORIGAMI.alphaDeg * DEG)) / Math.cos(psi);
  const phi = (i * s + p * (j % 2)) / radius;
  const r = radius - h * (i % 2);
  return [r * Math.sin(phi), ORIGAMI.bottom + j * rowPitch, r * Math.cos(phi)];
}

/** The virtual sun at loop phase `phase`: raking from +x, swaying `swayDeg` either side once per loop (v9 orbit convention). */
export function origamiSun(
  phase: number,
  swayDeg: number,
  out: { set(x: number, y: number, z: number): unknown },
): void {
  const az = (ORIGAMI.sunAzimuthDeg + swayDeg * Math.sin(TAU * phase)) * DEG;
  const el = ORIGAMI.sunElevationDeg * DEG;
  out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}
