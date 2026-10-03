import { loopSeconds } from "../../kit/clock";
import type { InstancePose } from "../../kit/instanced";
import { seededPlacements } from "../../kit/instanced";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

type Vec3 = [number, number, number];

/** Fixed staging: the floor, the mean azimuth the light travels toward (v9 convention, from +z toward +x), the loops and the dust drift. */
export const CLERESTORY = {
  floorY: -2,
  azimuthDeg: 105,
  sweepPeriod: 40,
  breathPeriod: 20,
  maxShafts: 12,
  seed: 0xc1e5,
  /** Gap every shaft and pool keeps from the content volume through the whole sweep. */
  clearance: 2,
  /** Dust fall speed down the beams, world units per second. */
  dustSpeed: 0.4,
  /** Shafts stop this far above the floor so their ends never z-fight it. */
  floorGap: 0.02,
} as const;

/** The content volume the shafts keep clear of (y from the floor up). */
export const CONTENT_BOX = { x: 4, top: 2, zMin: -6, zMax: 9 } as const;

/** Periodic noise along the fall axis: cells per world unit and cells per period, so both loop with the sweep (period / (cells * speed) = 40 s). */
export const DUST_NOISE = { cells: 4, period: 64 } as const;
export const WISP_NOISE = { cells: 0.75, period: 12 } as const;

/** One roof slot and the shaft it throws. */
export interface Shaft {
  slot: Vec3;
  /** Unit xz axes: tangent along the slot's length, radial across its width. */
  tangent: [number, number];
  radial: [number, number];
  length: number;
  width: number;
  /** Whole breaths per breath period (1 or 2) and the breath's phase. */
  cycles: number;
  phase: number;
}

/** Unit direction the light travels at `azimuthDeg`, leaning `tiltDeg` off vertical (written into `out` when given). */
export function shaftDirection(tiltDeg: number, azimuthDeg: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const t = tiltDeg * DEG;
  const a = azimuthDeg * DEG;
  out[0] = Math.sin(t) * Math.sin(a);
  out[1] = -Math.cos(t);
  out[2] = Math.sin(t) * Math.cos(a);
  return out;
}

/** The light's azimuth at look time `t`: `sweepDeg` either side of the mean over 40 s. */
export function shaftAzimuth(t: number, sweepDeg: number): number {
  const { azimuthDeg, sweepPeriod } = CLERESTORY;
  return azimuthDeg + sweepDeg * Math.sin((TAU * loopSeconds(t, sweepPeriod)) / sweepPeriod);
}

/** A shaft's breath in [0.6, 1] at look time `t`, looping every 20 s. */
export function shaftBreath(shaft: Shaft, t: number): number {
  const { breathPeriod } = CLERESTORY;
  const phase = loopSeconds(t, breathPeriod) / breathPeriod;
  return 0.8 + 0.2 * Math.sin(TAU * shaft.cycles * phase + shaft.phase);
}

/** Vertical drop from a slot to the end of its shaft. */
export function shaftDrop(shaft: Shaft): number {
  return shaft.slot[1] - CLERESTORY.floorY - CLERESTORY.floorGap;
}

const SAMPLE_STEP = 0.25;

function rectCorners(cx: number, cz: number, s: Shaft): [number, number][] {
  const [tx, tz] = s.tangent;
  const [rx, rz] = s.radial;
  const hl = s.length / 2;
  const hw = s.width / 2;
  return [
    [cx + tx * hl + rx * hw, cz + tz * hl + rz * hw],
    [cx + tx * hl - rx * hw, cz + tz * hl - rz * hw],
    [cx - tx * hl - rx * hw, cz - tz * hl - rz * hw],
    [cx - tx * hl + rx * hw, cz - tz * hl + rz * hw],
  ];
}

const BOX_CORNERS: [number, number][] = [
  [-CONTENT_BOX.x, CONTENT_BOX.zMin],
  [CONTENT_BOX.x, CONTENT_BOX.zMin],
  [CONTENT_BOX.x, CONTENT_BOX.zMax],
  [-CONTENT_BOX.x, CONTENT_BOX.zMax],
];

function boxDistance(x: number, z: number): number {
  const dx = Math.max(Math.abs(x) - CONTENT_BOX.x, 0);
  const dz = Math.max(CONTENT_BOX.zMin - z, z - CONTENT_BOX.zMax, 0);
  return Math.hypot(dx, dz);
}

function rectDistance(x: number, z: number, cx: number, cz: number, s: Shaft): number {
  const u = (x - cx) * s.tangent[0] + (z - cz) * s.tangent[1];
  const v = (x - cx) * s.radial[0] + (z - cz) * s.radial[1];
  return Math.hypot(
    Math.max(Math.abs(u) - s.length / 2, 0),
    Math.max(Math.abs(v) - s.width / 2, 0),
  );
}

/** Separating-axis overlap of the content box and a slot rectangle. */
function rectOverlapsBox(corners: [number, number][], s: Shaft): boolean {
  const axes: [number, number][] = [[1, 0], [0, 1], s.tangent, s.radial];
  for (const [ax, az] of axes) {
    const proj = (p: [number, number]) => p[0] * ax + p[1] * az;
    const a = corners.map(proj);
    const b = BOX_CORNERS.map(proj);
    if (Math.max(...a) < Math.min(...b) || Math.max(...b) < Math.min(...a)) return false;
  }
  return true;
}

/** Horizontal gap between the content box and the slot rectangle centred at (cx, cz). */
export function rectBoxGap(cx: number, cz: number, s: Shaft): number {
  const corners = rectCorners(cx, cz, s);
  if (rectOverlapsBox(corners, s)) return 0;
  let gap = Number.POSITIVE_INFINITY;
  for (const [x, z] of corners) gap = Math.min(gap, boxDistance(x, z));
  for (const [x, z] of BOX_CORNERS) gap = Math.min(gap, rectDistance(x, z, cx, cz, s));
  return gap;
}

/** Smallest 3D gap between a shaft (slot to floor pool) and the content volume over the whole sweep. */
export function shaftClearance(shaft: Shaft, tiltDeg: number, sweepDeg: number): number {
  const { floorY, azimuthDeg, clearance } = CLERESTORY;
  let gap = Number.POSITIVE_INFINITY;
  for (let k = -8; k <= 8; k++) {
    const d = shaftDirection(tiltDeg, azimuthDeg + (sweepDeg * k) / 8);
    const sx = d[0] / -d[1];
    const sz = d[2] / -d[1];
    for (let y = floorY; y <= CONTENT_BOX.top + clearance; y += SAMPLE_STEP) {
      const drop = shaft.slot[1] - y;
      const h = rectBoxGap(shaft.slot[0] + sx * drop, shaft.slot[2] + sz * drop, shaft);
      gap = Math.min(gap, Math.hypot(h, Math.max(y - CONTENT_BOX.top, 0)));
    }
  }
  return gap;
}

const POOL_PUSH = 0.25;
const POOL_LIMIT = 40;

/** Seeded slots: pools first (a ring outside the clearing, the sketch's draws in its order), each slot traced back up the mean light, then each pool pushed outward until its shaft clears the content volume at this lean and sweep. */
export function clerestoryLayout(count: number, tiltDeg: number, sweepDeg: number): Shaft[] {
  const n = Math.min(CLERESTORY.maxShafts, Math.max(1, Math.round(count)));
  const { floorY, azimuthDeg, seed, clearance } = CLERESTORY;
  const d0 = shaftDirection(tiltDeg, azimuthDeg);
  const place = (
    a: number,
    poolR: number,
    top: number,
    rest: Omit<Shaft, "slot" | "tangent" | "radial">,
  ): Shaft => {
    const rise = (top - floorY) / -d0[1];
    const sx = Math.cos(a) * poolR - d0[0] * rise;
    const sz = Math.sin(a) * poolR - d0[2] * rise;
    const th = Math.atan2(sz, sx);
    return {
      slot: [sx, top, sz],
      tangent: [-Math.sin(th), Math.cos(th)],
      radial: [Math.cos(th), Math.sin(th)],
      ...rest,
    };
  };
  return seededPlacements(seed, n, (rand, i) => {
    const a = (i / n) * TAU + (rand() - 0.5) * 0.5 - Math.PI / 2;
    let poolR = 11.5 + rand() * 5;
    const top = 16 + rand() * 3;
    const rest = {
      length: 3.2 + rand() * 2.4,
      width: 1.3 + rand() * 0.8,
      cycles: 1 + Math.floor(rand() * 2),
      phase: rand() * TAU,
    };
    let shaft = place(a, poolR, top, rest);
    while (shaftClearance(shaft, tiltDeg, sweepDeg) < clearance && poolR < POOL_LIMIT) {
      poolR += POOL_PUSH;
      shaft = place(a, poolR, top, rest);
    }
    return shaft;
  });
}

const yaw = (s: Shaft) => -Math.atan2(s.radial[1], s.radial[0]);

/** Instance pose of a shaft's unit box: slot centre, local x radial (width), y the drop, z tangent (length). The vertex shader shears it down the light; this order keeps the determinant positive, so BackSide still culls the near faces. */
export function shaftPose(shaft: Shaft, _i: number, out: InstancePose): void {
  out.position.set(...shaft.slot);
  out.rotation.set(0, yaw(shaft), 0);
  out.scale.set(shaft.width, shaftDrop(shaft), shaft.length);
}

/** Instance pose of a slot's unit plane (laid in xz). */
export function slotPose(shaft: Shaft, _i: number, out: InstancePose): void {
  out.position.set(...shaft.slot);
  out.rotation.set(0, yaw(shaft), 0);
  out.scale.set(shaft.width, 1, shaft.length);
}

/** Dust frame: two axes across the mean fall direction and the fall direction itself, so the noise loops along the fall. */
export function dustFrame(tiltDeg: number): [Vec3, Vec3, Vec3] {
  const c = shaftDirection(tiltDeg, CLERESTORY.azimuthDeg);
  const a = CLERESTORY.azimuthDeg * DEG;
  const across: Vec3 = [Math.cos(a), 0, -Math.sin(a)];
  const third: Vec3 = [
    c[1] * across[2] - c[2] * across[1],
    c[2] * across[0] - c[0] * across[2],
    c[0] * across[1] - c[1] * across[0],
  ];
  return [across, third, c];
}

/** Noise shift along the fall axis at look time `t`, wrapped to the noise period so dust drifts down without a seam. */
export function fallShift(t: number, noise: { cells: number; period: number }): number {
  return loopSeconds(t * CLERESTORY.dustSpeed * noise.cells, noise.period);
}
