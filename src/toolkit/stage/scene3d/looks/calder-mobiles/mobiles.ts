import { createSeededRandom } from "../../../../../engine/rng";

/** Calder mobiles model: seeded balance trees (arm pivots inverse to the weight each side) and closed-form forward kinematics, written into preallocated arrays so a frame allocates nothing. */

const TAU = Math.PI * 2;
const SEED = 0xca1de5;
/** Each arm end sits this far below its pivot per unit of reach (a shallow V). */
const SAG = 0.06;
/** Conservative depth of a paddle below its attachment, in paddle sizes (the outlines reach about 0.72). */
const PADDLE_DROP = 0.8;
/** Height of the hanging thread above each mobile's top pivot. */
export const THREAD_RISE = 9;
/** Yaw swing of the whole mobile about its thread at the default swing, radians. */
const TOP_SWING = 0.3;
/** Paddle tilt about its own long axis at the default swing, radians. */
const TILT = 0.09;
/** The swing the base amplitudes are authored at, degrees. */
export const BASE_SWING = 35;
/** Vertical half field of view of the default level camera (0, 0, 5), as a tangent. */
const HALF_FOV_TAN = Math.tan((22.5 * Math.PI) / 180);
const DEFAULT_EYE_Z = 5;

export type PaddleShape = 0 | 1 | 2;

/** Paddle outlines in the XY plane, attached at the origin and reaching along +X: gum leaf, crescent, disc. */
export function paddleOutline(shape: PaddleShape): [number, number][] {
  const out: [number, number][] = [];
  const push = (x: number, y: number) => {
    const last = out.at(-1);
    if (!last || Math.abs(last[0] - x) > 1e-9 || Math.abs(last[1] - y) > 1e-9) out.push([x, y]);
  };
  if (shape === 0) {
    const n = 18;
    const lower: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const w = 0.19 * Math.sin(Math.PI * u ** 0.62) ** 0.9;
      const yc = -0.16 * u * u;
      push(u, yc + w);
      lower.push([u, yc - w * 0.8]);
    }
    for (let i = n - 1; i > 0; i--) push(lower[i][0], lower[i][1]);
  } else if (shape === 1) {
    const m = 20;
    for (let i = 0; i <= m; i++) {
      const th = Math.PI + (Math.PI * i) / m;
      push(0.5 + 0.5 * Math.cos(th), 0.12 + 0.5 * Math.sin(th));
    }
    for (let i = m - 1; i > 0; i--) {
      const th = Math.PI + (Math.PI * i) / m;
      push(0.5 + 0.5 * Math.cos(th), 0.12 + 0.24 * Math.sin(th));
    }
  } else {
    const m = 48;
    for (let i = 0; i < m; i++) {
      const th = Math.PI + (TAU * i) / m;
      push(0.46 + 0.46 * Math.cos(th), -0.04 + 0.37 * Math.sin(th));
    }
  }
  return out;
}

export interface Paddle {
  shape: PaddleShape;
  /** Colour slot 0..2. */
  slot: number;
  size: number;
  roll: number;
  droop: number;
  /** Tilt harmonic (whole cycles a loop) and phase. */
  tn: number;
  tp: number;
}

export interface Arm {
  /** Reach left and right of the pivot: dl * weight(left) = dr * weight(everything right). */
  dl: number;
  dr: number;
  /** Wire drop from the right end to the next pivot. */
  drop: number;
  left: Paddle;
  /** Only the lowest arm carries a right paddle; the others carry the next arm. */
  right: Paddle | null;
  /** Swing amplitude (radians at the default swing) and two integer harmonics with phases. */
  amp: number;
  n1: number;
  n2: number;
  p1: number;
  p2: number;
}

export interface Mobile {
  /** Top pivot, where the thread meets the first arm. */
  anchor: [number, number, number];
  arms: Arm[];
  yaw0: number;
  yp: number;
  /** First joint index (thread top, then pivot, left end, right end per arm). */
  joint: number;
  /** Lowest point any paddle reaches. */
  floor: number;
}

export interface MobileRig {
  mobiles: Mobile[];
  /** Every paddle, mobile-major, with its draw (shape) and instance index. */
  paddles: { paddle: Paddle; mobile: number; arm: number; side: 0 | 1 }[];
  jointCount: number;
}

export interface MobileParams {
  count: number;
  paddle: number;
  clearance: number;
  depth: number;
  seed: number;
}

/** One hanging position: x/z, whether it is a back piece (scaled by depth, hung by clearance), arm levels, top arm length, paddle size, and its floor (back: NDC lift over `clearance`; others: world y). */
interface Slot {
  x: number;
  z: number;
  back: boolean;
  levels: number;
  len: number;
  size: number;
  floor: number;
}

/** Back three fill the top of the default frame (one on the centre line for 9:16), two hang low on the back arc and one overhead in front for orbit views; a seventh hangs furthest back. */
const SLOTS: Slot[] = [
  { x: 1, z: -38, back: true, levels: 3, len: 9, size: 3, floor: 0.1 },
  { x: -17, z: -30, back: true, levels: 4, len: 6.5, size: 2.6, floor: 0 },
  { x: 17, z: -33, back: true, levels: 4, len: 6.5, size: 2.6, floor: 0.08 },
  { x: -14, z: -10, back: false, levels: 4, len: 4.6, size: 2, floor: 2.4 },
  { x: 14.5, z: -10, back: false, levels: 4, len: 4.4, size: 1.9, floor: 2.8 },
  { x: -1.5, z: 11, back: false, levels: 4, len: 4.8, size: 1.8, floor: 3 },
  { x: 9, z: -46, back: true, levels: 3, len: 7.5, size: 2.4, floor: 0.12 },
];

export const MAX_MOBILES = SLOTS.length;
export const MIN_MOBILES = 3;
/** Joint capacity: a thread top plus pivot and both ends per arm. */
export const MAX_JOINTS = SLOTS.reduce((n, s) => n + 1 + 3 * s.levels, 0);
export const MAX_PADDLES = SLOTS.reduce((n, s) => n + s.levels + 1, 0);
/** Back depth the slot table is authored at. */
export const BASE_DEPTH = 34;

/** Lowest world y of a back mobile's paddles: `clearance` (plus the slot's lift) as a height in the default level frame's upper half. */
export function backFloor(x: number, z: number, lift: number): number {
  return lift * Math.hypot(x, z - DEFAULT_EYE_Z) * HALF_FOV_TAN;
}

/** Builds the seeded rig. Placement draws come from one stream in slot order, so every arrangement is stable whatever the count. */
export function buildMobiles(params: MobileParams): MobileRig {
  const seed = Math.max(1, Math.round(params.seed));
  const rand = createSeededRandom(SEED + (seed - 1) * 7919);
  const count = Math.min(MAX_MOBILES, Math.max(MIN_MOBILES, Math.round(params.count)));
  const reach = 0.4 + 0.6 * params.paddle;
  const pick = (a: number, b: number) => (rand() < 0.5 ? a : b);
  let lastSlot = -1;
  const newPaddle = (size: number): Paddle => {
    let slot = Math.floor(rand() * 3) % 3;
    if (slot === lastSlot) slot = (slot + 1) % 3;
    lastSlot = slot;
    return {
      shape: (Math.floor(rand() * 3) % 3) as PaddleShape,
      slot,
      size,
      roll: (rand() - 0.5) * 1.6,
      droop: 0.1 + rand() * 0.25,
      tn: 2 + (Math.floor(rand() * 4) % 4),
      tp: rand() * TAU,
    };
  };
  const mobiles: Mobile[] = [];
  const paddles: MobileRig["paddles"] = [];
  let joint = 0;
  SLOTS.forEach((slot, m) => {
    const scale = slot.back ? params.depth / BASE_DEPTH : 1;
    const x = slot.x * scale;
    const z = slot.z * scale;
    const arms: Arm[] = [];
    let len = slot.len * reach;
    for (let k = 0; k < slot.levels; k++) {
      const size = slot.size * params.paddle * (1 - 0.1 * k) * (0.8 + rand() * 0.35);
      arms.push({
        dl: len,
        dr: 0,
        drop: 1.2 + rand() * 0.4,
        left: newPaddle(size),
        right: null,
        amp: 0.5 + 0.08 * k,
        n1: pick(1, 2),
        n2: pick(3, 4),
        p1: rand() * TAU,
        p2: rand() * TAU,
      });
      len *= 0.78;
    }
    const last = arms[arms.length - 1];
    last.right = newPaddle(slot.size * params.paddle * 0.7);
    // Balance from the bottom up: dl * wLeft = dr * wBelow, weights from paddle area plus wire.
    let below = last.right.size ** 2;
    for (let k = arms.length - 1; k >= 0; k--) {
      const a = arms[k];
      const span = a.dl;
      const wl = a.left.size ** 2;
      a.dl = (span * below) / (wl + below);
      a.dr = span - a.dl;
      below += wl + 0.05 * span;
    }
    // Hang it so the lowest paddle sits at the floor (heights never change with time).
    let y = 0;
    let lowest = 0;
    for (const a of arms) {
      lowest = Math.min(lowest, y - SAG * a.dl - PADDLE_DROP * a.left.size);
      if (a.right) lowest = Math.min(lowest, y - SAG * a.dr - PADDLE_DROP * a.right.size);
      else y -= SAG * a.dr + a.drop;
    }
    const floor = slot.back ? backFloor(x, z, params.clearance + slot.floor) : slot.floor;
    const yaw0 = rand() * TAU;
    const yp = rand() * TAU;
    if (m < count) {
      arms.forEach((a, k) => {
        paddles.push({ paddle: a.left, mobile: mobiles.length, arm: k, side: 0 });
        if (a.right) paddles.push({ paddle: a.right, mobile: mobiles.length, arm: k, side: 1 });
      });
      mobiles.push({ anchor: [x, floor - lowest, z], arms, yaw0, yp, joint, floor });
      joint += 1 + 3 * arms.length;
    }
  });
  return { mobiles, paddles, jointCount: joint };
}

/** One frame of the rig: joint positions (xyz per joint) and per paddle its attachment, yaw and tilt. */
export interface MobileFrame {
  joints: Float32Array;
  /** Per paddle: x, y, z, yaw, tilt (rig paddle order). */
  paddles: Float32Array;
}

export function createMobileFrame(): MobileFrame {
  return {
    joints: new Float32Array(MAX_JOINTS * 3),
    paddles: new Float32Array(MAX_PADDLES * 5),
  };
}

/** Forward kinematics at loop time `t` of `period` seconds, swing scaled by `swingScale` (1 at BASE_SWING degrees): each arm yaws about its wire by two summed integer-harmonic sines and children inherit the parent's yaw, so the loop is exact. Writes into `out` without allocating. */
export function poseMobiles(
  rig: MobileRig,
  t: number,
  period: number,
  swingScale: number,
  out: MobileFrame,
): void {
  const w = TAU / period;
  const j = out.joints;
  const pd = out.paddles;
  let p = 0;
  const writePaddle = (paddle: Paddle, x: number, y: number, z: number, yaw: number) => {
    pd[p * 5] = x;
    pd[p * 5 + 1] = y;
    pd[p * 5 + 2] = z;
    pd[p * 5 + 3] = yaw;
    pd[p * 5 + 4] = paddle.roll + swingScale * TILT * Math.sin(w * paddle.tn * t + paddle.tp);
    p++;
  };
  for (const mb of rig.mobiles) {
    let px = mb.anchor[0];
    let py = mb.anchor[1];
    let pz = mb.anchor[2];
    let o = mb.joint * 3;
    j[o] = px;
    j[o + 1] = py + THREAD_RISE;
    j[o + 2] = pz;
    o += 3;
    let yaw = mb.yaw0 + swingScale * TOP_SWING * Math.sin(w * t + mb.yp);
    for (const a of mb.arms) {
      yaw +=
        swingScale *
        a.amp *
        (0.65 * Math.sin(w * a.n1 * t + a.p1) + 0.35 * Math.sin(w * a.n2 * t + a.p2));
      const dx = Math.cos(yaw);
      const dz = -Math.sin(yaw);
      const lx = px - dx * a.dl;
      const ly = py - SAG * a.dl;
      const lz = pz - dz * a.dl;
      const rx = px + dx * a.dr;
      const ry = py - SAG * a.dr;
      const rz = pz + dz * a.dr;
      j[o] = px;
      j[o + 1] = py;
      j[o + 2] = pz;
      j[o + 3] = lx;
      j[o + 4] = ly;
      j[o + 5] = lz;
      j[o + 6] = rx;
      j[o + 7] = ry;
      j[o + 8] = rz;
      o += 9;
      writePaddle(a.left, lx, ly, lz, yaw + Math.PI);
      if (a.right) writePaddle(a.right, rx, ry, rz, yaw);
      else {
        px = rx;
        py = ry - a.drop;
        pz = rz;
      }
    }
  }
}

/** Ink strands as joint-index pairs: per mobile the thread (pivot up to its top), each arm (left end, pivot, right end) and each drop wire. `kind` 1 marks threads that fade toward the ceiling. */
export function mobileWires(): { joints: number[]; kind: number; mobile: number }[] {
  const out: { joints: number[]; kind: number; mobile: number }[] = [];
  let joint = 0;
  SLOTS.forEach((slot, m) => {
    const top = joint;
    out.push({ joints: [top + 1, top], kind: 1, mobile: m });
    for (let k = 0; k < slot.levels; k++) {
      const pivot = top + 1 + 3 * k;
      out.push({ joints: [pivot + 1, pivot, pivot + 2], kind: 0, mobile: m });
      if (k < slot.levels - 1) out.push({ joints: [pivot + 2, pivot + 3], kind: 0, mobile: m });
    }
    joint += 1 + 3 * slot.levels;
  });
  return out;
}
