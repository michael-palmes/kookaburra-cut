import { createSeededRandom } from "../../../../../engine/rng";
import { loopSeconds } from "../../kit/clock";
import type { GoboSunPath } from "../../kit/gobo";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

type Vec3 = [number, number, number];

/** Box kites constants: the lake floor, the exact loop, ribbon points per line, slider capacities, the shared rest wind (blowing toward +x), the train spacing along the line (tightened so the last kite rides at least `trainReach` up it) and the train's sideways zigzag in spans, and the elevations (degrees from the stage) over which a lamp fades in. */
export const KITES = {
  floorY: -2.1,
  period: 120,
  segments: 48,
  maxLines: 12,
  maxTrain: 4,
  wind: [1 / Math.hypot(1, 0.3), 0, 0.3 / Math.hypot(1, 0.3)] as Vec3,
  trainStep: 0.15,
  trainReach: 0.5,
  zig: 0.55,
  lampFade: [7, 9] as [number, number],
  seed: 0xb0c5,
} as const;

/** The virtual sun that shades the cells, and the companion sun's bearing (v9 orbit convention). */
export const KITE_SUN: GoboSunPath = { azimuthDeg: 320, elevationDeg: 55 };

/** Head azimuth (degrees, 0 behind the stage on -z, clockwise from above), ground distance, head height, kites in the train at Train length 3, cell variant (0 square, 1 triangular) and span. Listed in slider order: the first eight are the approved layout (heads a twentieth lower so the lab and atlas cameras frame more of each train), every line sits at least 25 degrees off the wind axis (107 and 287 degrees) so no train is seen end-on from the stage, and the later four fill the gaps. */
const LINE_TABLE = [
  { az: -20, d: 42, y: 11.9, n: 3, v: 0, s: 2.9 },
  { az: 182, d: 38, y: 11.4, n: 3, v: 1, s: 2.8 },
  { az: 66, d: 42, y: 13.3, n: 2, v: 1, s: 3 },
  { az: 318, d: 40, y: 11.9, n: 2, v: 1, s: 2.8 },
  { az: 36, d: 40, y: 11.4, n: 2, v: 0, s: 2.7 },
  { az: 130, d: 46, y: 14.7, n: 1, v: 0, s: 3.2 },
  { az: 236, d: 44, y: 14.3, n: 1, v: 0, s: 3.2 },
  { az: 7, d: 46, y: 12.8, n: 1, v: 1, s: 3.1 },
  { az: 157, d: 41, y: 12.8, n: 2, v: 1, s: 2.9 },
  { az: 209, d: 43, y: 13.8, n: 2, v: 0, s: 3 },
  { az: 98, d: 45, y: 14.3, n: 1, v: 0, s: 3.1 },
  { az: 268, d: 42, y: 12.4, n: 1, v: 1, s: 2.9 },
] as const;

/** One kite line: rest head and ground anchor (look space), figure-eight and sway-wave cycles per loop with their phases, train size, cell variant, span, the train's spacing along the line and its zigzag amplitude. */
export interface KiteLine {
  head: Vec3;
  anchor: Vec3;
  /** Figure-eight cycles per loop, its phase, sway-wave cycles per loop, its phase. */
  wave: [number, number, number, number];
  count: number;
  variant: 0 | 1;
  span: number;
  step: number;
  zig: number;
}

/** One kite: its line, place in the train, cell variant, span, and whether its front cell takes the Cell colour. */
export interface Kite {
  line: number;
  j: number;
  variant: 0 | 1;
  span: number;
  swap: 0 | 1;
}

/** Kites a line carries at a Train length: the approved trains at 3, singles stay single. */
export function trainCount(n: number, train: number): number {
  return Math.max(1, Math.min(KITES.maxTrain, Math.round((n * Math.round(train)) / 3)));
}

/** The first `count` lines of the table at a flying height and kite size. Each head sits downwind of its anchor, the line slanting down at 1 : 1.25 to the lake. Cycles are whole numbers per loop, drawn in table order from one seed. */
export function kiteLines(count: number, train: number, height: number, size: number): KiteLine[] {
  const rand = createSeededRandom(KITES.seed);
  const waves = LINE_TABLE.map(
    () =>
      [
        7 + Math.floor(rand() * 4),
        rand() * TAU,
        9 + Math.floor(rand() * 5),
        rand() * TAU,
      ] as KiteLine["wave"],
  );
  const n = Math.max(0, Math.min(KITES.maxLines, Math.round(count)));
  const [wx, , wz] = KITES.wind;
  return LINE_TABLE.slice(0, n).map((row, i) => {
    const a = row.az * DEG;
    const y = row.y * height;
    const head: Vec3 = [row.d * Math.sin(a), y, -row.d * Math.cos(a)];
    const run = (y - KITES.floorY) * 1.25;
    const anchor: Vec3 = [head[0] - wx * run, KITES.floorY, head[2] - wz * run];
    const kites = trainCount(row.n, train);
    const span = row.s * (size / 3);
    return {
      head,
      anchor,
      wave: waves[i],
      count: kites,
      variant: row.v as 0 | 1,
      span,
      step: kites > 1 ? Math.min(KITES.trainStep, KITES.trainReach / (kites - 1)) : KITES.trainStep,
      zig: kites > 1 ? KITES.zig * span : 0,
    };
  });
}

/** Every kite on the lines, line by line, front of the train first, each shrinking a tenth down the train. */
export function kiteList(lines: readonly KiteLine[]): Kite[] {
  const out: Kite[] = [];
  lines.forEach((line, li) => {
    for (let j = 0; j < line.count; j++) {
      out.push({
        line: li,
        j,
        variant: line.variant,
        span: line.span * (1 - 0.1 * j),
        swap: ((li + j) % 2) as 0 | 1,
      });
    }
  });
  return out;
}

/** The wind veer in radians at look time: the shared wind swings `veerDeg` either way once per loop. */
export function windVeer(t: number, veerDeg: number): number {
  return veerDeg * DEG * Math.sin((TAU * loopSeconds(t, KITES.period)) / KITES.period + 0.4);
}

/** Scratch for linePoint: the veered wind and its sideways axis, written on every call. */
export interface LineFrame {
  wind: Vec3;
  side: Vec3;
}

export function createLineFrame(): LineFrame {
  return { wind: [0, 0, 0], side: [0, 0, 0] };
}

/** A point `u` along a line (0 anchor, 1 head) at loop time `t`: the head swung round the anchor by the veer, tracing a figure eight, a shallow sag, a sway wave running up the line, and a sideways zigzag through the train (kites alternate sides, so a train seen end-on fans out instead of stacking). Mirrors the GLSL `bkLine` exactly; writes the frame's wind and side axes. */
export function linePoint(
  line: KiteLine,
  u: number,
  t: number,
  psi: number,
  figure: number,
  frame: LineFrame,
  out: Vec3,
): Vec3 {
  const c = Math.cos(psi);
  const s = Math.sin(psi);
  const w0x = KITES.wind[0];
  const w0z = KITES.wind[2];
  const wx = w0x * c - w0z * s;
  const wz = w0x * s + w0z * c;
  frame.wind[0] = wx;
  frame.wind[1] = 0;
  frame.wind[2] = wz;
  frame.side[0] = -wz;
  frame.side[1] = 0;
  frame.side[2] = wx;
  const ax = line.anchor[0];
  const ay = line.anchor[1];
  const az = line.anchor[2];
  const dx = line.head[0] - ax;
  const dz = line.head[2] - az;
  const ph = (TAU * line.wave[0] * t) / KITES.period + line.wave[1];
  const sway = line.span * 0.55 * Math.sin(ph) * figure;
  const hx = ax + dx * c - dz * s - wz * sway;
  const hy = line.head[1] + line.span * 0.22 * Math.sin(2 * ph + 0.6) * figure;
  const hz = az + dx * s + dz * c + wx * sway;
  const len = Math.hypot(hx - ax, hy - ay, hz - az);
  const wave =
    Math.sin(Math.PI * u) *
    Math.sin((TAU * line.wave[2] * t) / KITES.period - 7 * u + line.wave[3]);
  const last = 1 - line.step * (line.count - 1);
  const t01 = Math.min(1, Math.max(0, (u - last + line.step) / line.step));
  const lat =
    0.35 * line.span * wave +
    line.zig * Math.cos((Math.PI * (1 - u)) / line.step) * t01 * t01 * (3 - 2 * t01);
  out[0] = ax + (hx - ax) * u - wz * lat;
  out[1] = ay + (hy - ay) * u - 0.045 * len * 4 * u * (1 - u);
  out[2] = az + (hz - az) * u + wx * lat;
  return out;
}

/** Where kite `j` rides on its line (1 at the head). */
export function trainU(line: KiteLine, j: number): number {
  return 1 - line.step * j;
}

/** Scratch for poseKite, so per-frame posing allocates nothing. */
export interface KiteScratch {
  frame: LineFrame;
  ahead: LineFrame;
  a: Vec3;
  b: Vec3;
}

export function createKiteScratch(): KiteScratch {
  return { frame: createLineFrame(), ahead: createLineFrame(), a: [0, 0, 0], b: [0, 0, 0] };
}

/** Poses one kite at loop time `t`: nose upwind at its angle of attack, banked by its sideways speed along the line (a quarter second ahead), riding 0.3 span above its point on the line. Writes a column-major 4x4 (span-scaled basis, centre) and the lamp under the front cell. */
export function poseKite(
  line: KiteLine,
  kite: Kite,
  t: number,
  veerDeg: number,
  figure: number,
  scratch: KiteScratch,
  matrix: number[] | Float32Array,
  lamp: Vec3,
): void {
  const u = trainU(line, kite.j);
  const ahead = linePoint(
    line,
    u,
    t + 0.25,
    windVeer(t + 0.25, veerDeg),
    figure,
    scratch.ahead,
    scratch.b,
  );
  const at = linePoint(line, u, t, windVeer(t, veerDeg), figure, scratch.frame, scratch.a);
  const { wind, side } = scratch.frame;
  const lat = (ahead[0] - at[0]) * side[0] + (ahead[2] - at[2]) * side[2];
  const aoa =
    0.32 + 0.05 * Math.sin((TAU * (line.wave[0] + 2) * t) / KITES.period + line.wave[1] + kite.j);
  const ca = Math.cos(aoa);
  const sa = Math.sin(aoa);
  const fl = Math.hypot(wind[0] * ca, sa, wind[2] * ca);
  const fx = (-wind[0] * ca) / fl;
  const fy = sa / fl;
  const fz = (-wind[2] * ca) / fl;
  const rl = Math.hypot(fz, fx);
  const rx = fz / rl;
  const rz = -fx / rl;
  const ux = fy * rz;
  const uy = fz * rx - fx * rz;
  const uz = -fy * rx;
  const roll = Math.max(-0.35, Math.min(0.35, -lat * 0.9));
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const sc = kite.span;
  const bxx = rx * cr + ux * sr;
  const bxy = uy * sr;
  const bxz = rz * cr + uz * sr;
  const byx = ux * cr - rx * sr;
  const byy = uy * cr;
  const byz = uz * cr - rz * sr;
  const cx = at[0] + byx * 0.3 * sc;
  const cy = at[1] + byy * 0.3 * sc;
  const cz = at[2] + byz * 0.3 * sc;
  matrix[0] = bxx * sc;
  matrix[1] = bxy * sc;
  matrix[2] = bxz * sc;
  matrix[3] = 0;
  matrix[4] = byx * sc;
  matrix[5] = byy * sc;
  matrix[6] = byz * sc;
  matrix[7] = 0;
  matrix[8] = fx * sc;
  matrix[9] = fy * sc;
  matrix[10] = fz * sc;
  matrix[11] = 0;
  matrix[12] = cx;
  matrix[13] = cy;
  matrix[14] = cz;
  matrix[15] = 1;
  lamp[0] = cx + (-byx * 0.45 + fx * 0.5) * sc;
  lamp[1] = cy + (-byy * 0.45 + fy * 0.5) * sc;
  lamp[2] = cz + (-byz * 0.45 + fz * 0.5) * sc;
}
