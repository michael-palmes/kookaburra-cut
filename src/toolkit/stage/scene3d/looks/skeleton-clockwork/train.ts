import { createSeededRandom } from "../../../../../engine/rng";
import { fract, smoothstep } from "../../kit/math";

/** Skeleton clockwork layout: seeded random-walk gear trains on up to four overhead planes plus two frieze rows of half-wheels at the horizon. Every wheel is a flat disc drawn by its fragment shader; meshing wheels share a plane, sit exactly R + R apart and take the phase that seats a gap on their driver's tooth, so they turn together as long as each passes the same teeth per second. */

const TAU = Math.PI * 2;

export type Vec3 = [number, number, number];

/** Wheel kinds, also the shader's `aW.w`: a brass ceiling wheel, a frieze wheel, a steel pinion. */
export const CLOCK_KIND = { wheel: 0, frieze: 1, pinion: 2 } as const;

/** Tooth profile in tooth phase (0 to 1, the tooth centred on 0.5): full tip height out to `tip` either side of the centre, ramping to the root by `tip + flank`. Slimmer than a 50/50 split, so meshing teeth clear each other. */
export const TOOTH = { tip: 0.14, flank: 0.17, addendum: 1, dedendum: 1.25 } as const;

/** Every ceiling train passes the master tooth count; the frieze runs at half. Tooth counts divide `LOOP_TEETH`, so the clock wraps there with every wheel back on a whole turn. */
export const LOOP_TEETH = 120;
export const FRIEZE_RATE = 0.5;
/** Tooth counts (20 or more, so the profile meshes) dividing LOOP_TEETH (ceiling) and LOOP_TEETH x FRIEZE_RATE (frieze); a layout keeps those whose pitch radius at its module lies in WHEEL_RADIUS, so Tooth size changes the teeth more than the wheels. */
const CEILING_TEETH = [60, 40, 30, 24, 20] as const;
const FRIEZE_TEETH = [60, 30, 20] as const;
const PINION_TEETH = 10;
export const WHEEL_RADIUS = { min: 2.9, max: 9.1, arbor: 4.4 } as const;

/** The tooth counts a train picks from at `module`. */
export function teethFor(list: readonly number[], module: number): number[] {
  return list.filter((z) => {
    const r = (module * z) / 2;
    return r >= WHEEL_RADIUS.min && r <= WHEEL_RADIUS.max;
  });
}

export const CLOCKWORK = {
  /** Plane k hangs at ceiling + k * planeGap. */
  planeGap: 1.4,
  maxPlanes: 4,
  /** Ceiling trains stay inside this horizontal radius and out of the stage axis. */
  reach: 27,
  hole: 1.5,
  wheelsPerPlane: 13,
  attemptsPerPlane: 80,
  /** Outer trains tilt toward the stage (a shallow dome), so low, wide and far cameras see their faces instead of an edge. */
  tilt: (40 * Math.PI) / 180,
  tiltFrom: 4,
  tiltTo: 18,
  /** A tilted wheel's lowest tooth stays this far under its plane at most. */
  maxDrop: 2.4,
  /** Frieze: seven movement plates per row facing the stage, hubs just under the floor line. */
  friezeRows: [
    { offset: 0, plates: 7, phase: 0, hubY: -2.6 },
    { offset: 5, plates: 7, phase: 0.5, hubY: -2.4 },
  ],
  friezeHalfWidth: 10.5,
  floorY: -2,
  /** The sketch's seed for arrangement 1. */
  seed: 0x5c10c4,
} as const;

export interface ClockWheel {
  centre: Vec3;
  /** Plane basis: `u` and `v` span the disc, `normal = u x v` faces the stage. */
  u: Vec3;
  v: Vec3;
  normal: Vec3;
  /** Pitch radius (module x teeth / 2). */
  radius: number;
  teeth: number;
  /** 0 for a solid pinion. */
  spokes: number;
  kind: number;
  /** Angle at tooth count 0, in the (u, v) plane. */
  phase: number;
  /** Signed turns per master tooth passed: the angle is `phase + TAU * turns * teeth passed`. */
  turns: number;
  /** -1 frieze, else the ceiling plane index. */
  plane: number;
  train: number;
}

export interface ClockLayout {
  wheels: ClockWheel[];
  /** Index pairs that mesh (driver first). */
  meshes: [number, number][];
  /** `ends[k]` is the wheel count through ceiling plane k - 1: ends[0] is the frieze, ends[n] shows n planes. */
  ends: number[];
}

export interface ClockworkParams {
  module: number;
  ceiling: number;
  frieze: number;
  seed: number;
}

/** A wheel in its train's plane coordinates. */
interface Planar {
  u: number;
  v: number;
  radius: number;
  teeth: number;
  phase: number;
  dir: 1 | -1;
}

/** Maps plane coordinates to the world: an origin, the plane axes and the normal. */
interface PlaneFrame {
  origin: Vec3;
  /** World direction of plane +u and +v, and the stage-facing normal. */
  axisU: Vec3;
  axisV: Vec3;
  normal: Vec3;
  /** Plane coordinates of `origin`. */
  at: [number, number];
}

interface Disc {
  centre: Vec3;
  normal: Vec3;
  radius: number;
}

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** Tip, root and profile radius of a wheel at angle `theta` in its own turning frame (the shader's tooth outline). */
export function toothRadius(theta: number, radius: number, teeth: number, module: number): number {
  const tip = radius + TOOTH.addendum * module;
  const root = radius - TOOTH.dedendum * module;
  const du = Math.abs(fract((theta * teeth) / TAU) - 0.5);
  const k = Math.min(1, Math.max(0, (du - TOOTH.tip) / TOOTH.flank));
  return tip + (root - tip) * k;
}

/** The angle a wheel has turned to after `teethPassed` master teeth (the shader's `vAng`). */
export function wheelAngle(
  wheel: Pick<ClockWheel, "phase" | "turns">,
  teethPassed: number,
): number {
  return wheel.phase + TAU * fract(wheel.turns * teethPassed);
}

/** The driven wheel's phase that seats a gap on the driver's tooth at the contact angle `phi` (the driver to driven heading, plane coordinates). */
export function meshPhase(driver: Planar, teeth: number, phi: number): number {
  return phi + Math.PI - (TAU / teeth) * (0.5 - ((phi - driver.phase) * driver.teeth) / TAU);
}

/** Master teeth passed at look time `t`: smooth by default; `tick` (0 to 1) blends in a deadbeat lock-then-advance step every half tooth. Wraps at LOOP_TEETH, where every wheel is back on a whole turn. */
export function clockTeeth(t: number, rate: number, tick: number): number {
  const raw = t * rate;
  const n = raw - LOOP_TEETH * Math.floor(raw / LOOP_TEETH);
  if (!(tick > 0)) return n;
  const beats = n * 2;
  const stepped = (Math.floor(beats) + smoothstep(0.72, 1, fract(beats))) / 2;
  return n + (stepped - n) * Math.min(1, tick);
}

/** Smallest distance between two discs: 0 when they cross, else sampled from both rims and a few inner rings. */
export function discGap(a: Disc, b: Disc): number {
  const apart = len(sub(a.centre, b.centre)) - a.radius - b.radius;
  if (apart > 0) return apart;
  if (discsCross(a, b)) return 0;
  return Math.min(sampledGap(a, b), sampledGap(b, a));
}

function discsCross(a: Disc, b: Disc): boolean {
  const line = cross(a.normal, b.normal);
  const l2 = dot(line, line);
  if (l2 < 1e-8) return false;
  const c = dot(a.normal, b.normal);
  const ha = dot(a.normal, a.centre);
  const hb = dot(b.normal, b.centre);
  const s = 1 - c * c;
  const p0 = add(scale(a.normal, (ha - hb * c) / s), b.normal, (hb - ha * c) / s);
  const dir = scale(line, 1 / Math.sqrt(l2));
  const chord = (d: Disc): [number, number] | null => {
    const at = dot(sub(d.centre, p0), dir);
    const h = len(sub(d.centre, add(p0, dir, at)));
    if (h >= d.radius) return null;
    const w = Math.sqrt(d.radius * d.radius - h * h);
    return [at - w, at + w];
  };
  const ca = chord(a);
  const cb = chord(b);
  return !!ca && !!cb && ca[0] < cb[1] && cb[0] < ca[1];
}

function pointToDisc(p: Vec3, d: Disc): number {
  const q = sub(p, d.centre);
  const h = dot(q, d.normal);
  const inPlane = sub(q, scale(d.normal, h));
  const r = len(inPlane);
  return r <= d.radius ? Math.abs(h) : Math.hypot(h, r - d.radius);
}

function sampledGap(from: Disc, to: Disc): number {
  const helper: Vec3 = Math.abs(from.normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = cross(from.normal, helper);
  const n1 = len(e1);
  const a = scale(e1, 1 / n1);
  const b = cross(from.normal, a);
  let best = pointToDisc(from.centre, to);
  for (const ring of [1, 0.75, 0.5, 0.25]) {
    const steps = ring === 1 ? 64 : 32;
    for (let i = 0; i < steps; i++) {
      const th = (i / steps) * TAU;
      const r = from.radius * ring;
      const p = add(add(from.centre, a, Math.cos(th) * r), b, Math.sin(th) * r);
      best = Math.min(best, pointToDisc(p, to));
    }
  }
  return best;
}

const frameWorld = (f: PlaneFrame, u: number, v: number): Vec3 =>
  add(add(f.origin, f.axisU, u - f.at[0]), f.axisV, v - f.at[1]);

/** A ceiling train's frame: plane k at its height, tilted about the horizontal tangent through the train's first hub so its normal leans from straight down toward the stage, more the further out the train starts. */
export function ceilingFrame(start: [number, number], height: number): PlaneFrame {
  const r0 = Math.hypot(start[0], start[1]);
  const alpha = CLOCKWORK.tilt * smoothstep(CLOCKWORK.tiltFrom, CLOCKWORK.tiltTo, r0);
  const rx = r0 > 1e-6 ? start[0] / r0 : 1;
  const rz = r0 > 1e-6 ? start[1] / r0 : 0;
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  // Tilted axes: radial r -> (ca r - sa y), up y -> (ca y + sa r), tangent unchanged.
  const tilt = (x: Vec3): Vec3 => {
    const along = x[0] * rx + x[2] * rz;
    const across = -x[0] * rz + x[2] * rx;
    const up = x[1];
    const radial = ca * along + sa * up;
    return [radial * rx - across * rz, ca * up - sa * along, radial * rz + across * rx];
  };
  const axisU = tilt([1, 0, 0]);
  const axisV = tilt([0, 0, 1]);
  return {
    origin: [start[0], height, start[1]],
    axisU,
    axisV,
    normal: cross(axisU, axisV),
    at: start,
  };
}

/** A frieze plate's frame: tangent to the ring at `phi` (0 = +z), plane u along the tangent, v straight up, facing the stage. */
function friezeFrame(phi: number, radius: number): PlaneFrame {
  const rad: Vec3 = [Math.sin(phi), 0, Math.cos(phi)];
  const axisU: Vec3 = [-Math.cos(phi), 0, Math.sin(phi)];
  const axisV: Vec3 = [0, 1, 0];
  return {
    origin: [rad[0] * radius, 0, rad[2] * radius],
    axisU,
    axisV,
    normal: cross(axisU, axisV),
    at: [0, 0],
  };
}

interface TrainSpec {
  teeth: readonly number[];
  length: number;
  start: [number, number];
  heading: number;
  turn: number;
  rate: number;
  kind: number;
  plane: number;
  /** Plane-coordinate bounds for a wheel. */
  inBounds: (w: Planar) => boolean;
  frame: (start: [number, number]) => PlaneFrame;
  /** Optional world-space bound (the tilted drop). */
  worldOk?: (centre: Vec3, normal: Vec3, tipRadius: number) => boolean;
  /** Alternate wheels step back along the normal by this much, so meshing tooth edges never fight for depth. */
  lift: number;
}

/** Builds clockwork from one seeded stream: the frieze rows first, then ceiling planes 0 to 3 (each only checked against what came before, so showing the first n planes never changes them). */
export function clockworkLayout(params: ClockworkParams): ClockLayout {
  const m = params.module;
  const rand = createSeededRandom(CLOCKWORK.seed + (Math.round(params.seed) - 1) * 7919);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length) % list.length];
  const wheels: ClockWheel[] = [];
  const meshes: [number, number][] = [];
  const ends: number[] = [];
  const clearance = 0.6 * m + 0.3;
  const tipDisc = (w: ClockWheel): Disc => ({
    centre: w.centre,
    normal: w.normal,
    radius: w.radius + TOOTH.addendum * m,
  });
  let trainId = 0;

  const clearOfOthers = (disc: Disc, skip: (w: ClockWheel) => boolean): boolean => {
    for (const o of wheels) {
      if (skip(o)) continue;
      if (discGap(disc, tipDisc(o)) < clearance) return false;
    }
    return true;
  };

  const train = (spec: TrainSpec): void => {
    const id = trainId++;
    const frame = spec.frame(spec.start);
    const placed: Planar[] = [];
    const toWorld = (w: Planar, k: number): ClockWheel => {
      const centre = add(frameWorld(frame, w.u, w.v), frame.normal, -(k % 2) * spec.lift);
      return {
        centre,
        u: frame.axisU,
        v: frame.axisV,
        normal: frame.normal,
        radius: w.radius,
        teeth: w.teeth,
        spokes: 0,
        kind: spec.kind,
        phase: w.phase,
        turns: (w.dir * spec.rate) / w.teeth,
        plane: spec.plane,
        train: id,
      };
    };
    const fits = (w: Planar, prev: Planar | null, k: number): boolean => {
      if (!spec.inBounds(w)) return false;
      for (const o of placed) {
        if (o === prev) continue;
        if (Math.hypot(o.u - w.u, o.v - w.v) < o.radius + w.radius + 2 * m + clearance)
          return false;
      }
      const world = toWorld(w, k);
      const tip = w.radius + TOOTH.addendum * m;
      if (spec.worldOk && !spec.worldOk(world.centre, world.normal, tip)) return false;
      return clearOfOthers(
        { centre: world.centre, normal: world.normal, radius: tip },
        (o) => o.train === id,
      );
    };
    const z0 = pick(spec.teeth);
    let prev: Planar = {
      u: spec.start[0],
      v: spec.start[1],
      radius: (m * z0) / 2,
      teeth: z0,
      phase: rand() * TAU,
      dir: rand() < 0.5 ? 1 : -1,
    };
    if (!fits(prev, null, 0)) return;
    placed.push(prev);
    let heading = spec.heading;
    for (let k = 1; k < spec.length; k++) {
      let ok = false;
      for (let tries = 0; tries < 10 && !ok; tries++) {
        const teeth = pick(spec.teeth);
        const radius = (m * teeth) / 2;
        const h = heading + (rand() - 0.5) * spec.turn;
        const d = prev.radius + radius;
        const w: Planar = {
          u: prev.u + Math.cos(h) * d,
          v: prev.v + Math.sin(h) * d,
          radius,
          teeth,
          phase: 0,
          dir: prev.dir === 1 ? -1 : 1,
        };
        if (!fits(w, prev, k)) continue;
        w.phase = meshPhase(prev, teeth, h);
        placed.push(w);
        prev = w;
        heading = h;
        ok = true;
      }
      if (!ok) break;
    }
    let driver = -1;
    placed.forEach((w, k) => {
      const wheel = toWorld(w, k);
      wheel.spokes = pick([4, 5, 6]);
      const index = wheels.length;
      wheels.push(wheel);
      if (driver >= 0) meshes.push([driver, index]);
      driver = index;
      if (w.radius >= WHEEL_RADIUS.arbor && spec.kind === CLOCK_KIND.wheel) {
        // A pinion on the same arbor, one layer further from the stage, turning with its wheel.
        const pinion: ClockWheel = {
          ...wheel,
          centre: add(wheel.centre, wheel.normal, -0.3),
          radius: (m * PINION_TEETH) / 2,
          teeth: PINION_TEETH,
          spokes: 0,
          kind: CLOCK_KIND.pinion,
        };
        const disc = tipDisc(pinion);
        if (!spec.worldOk || spec.worldOk(disc.centre, disc.normal, disc.radius)) {
          if (clearOfOthers(disc, (o) => o.train === id)) wheels.push(pinion);
        }
      }
    });
  };

  for (const row of CLOCKWORK.friezeRows) {
    const radius = params.frieze + row.offset;
    for (let k = 0; k < row.plates; k++) {
      const phi = ((k + row.phase + (rand() - 0.5) * 0.3) / row.plates) * TAU;
      train({
        teeth: teethFor(FRIEZE_TEETH, m),
        length: 3,
        start: [-6 + rand() * 2, row.hubY],
        heading: 0,
        turn: 0.2,
        rate: FRIEZE_RATE,
        kind: CLOCK_KIND.frieze,
        plane: -1,
        inBounds: (w) =>
          Math.abs(w.u) + w.radius <= CLOCKWORK.friezeHalfWidth && Math.abs(w.v - row.hubY) <= 0.4,
        frame: () => friezeFrame(phi, radius),
        lift: 0.04,
      });
    }
  }
  ends.push(wheels.length);

  for (let plane = 0; plane < CLOCKWORK.maxPlanes; plane++) {
    const height = params.ceiling + plane * CLOCKWORK.planeGap;
    const first = wheels.length;
    for (let k = 0; k < CLOCKWORK.attemptsPerPlane; k++) {
      const count = wheels.slice(first).filter((w) => w.kind === CLOCK_KIND.wheel).length;
      if (count >= CLOCKWORK.wheelsPerPlane) break;
      const a = rand() * TAU;
      const rr = 5 + rand() * 18;
      const length = 3 + Math.floor(rand() * 3);
      train({
        teeth: teethFor(CEILING_TEETH, m),
        length,
        start: [Math.sin(a) * rr, Math.cos(a) * rr],
        heading: rand() * TAU,
        turn: 2.4,
        rate: 1,
        kind: CLOCK_KIND.wheel,
        plane,
        inBounds: (w) => {
          const r = Math.hypot(w.u, w.v);
          return r + w.radius <= CLOCKWORK.reach && r - w.radius >= CLOCKWORK.hole;
        },
        frame: (start) => ceilingFrame(start, height),
        worldOk: (centre, normal, tip) => {
          const reach = tip * Math.sqrt(Math.max(0, 1 - normal[1] * normal[1]));
          return centre[1] - reach >= height - CLOCKWORK.maxDrop;
        },
        lift: 0.03,
      });
    }
    ends.push(wheels.length);
  }
  return { wheels, meshes, ends };
}
