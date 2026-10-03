import { createSeededRandom } from "../../../../../engine/rng";
import { loopSeconds } from "../../kit/clock";
import type { InstancePose } from "../../kit/instanced";

const TAU = Math.PI * 2;

/** Fixed staging: the floor, capacities, the seed and the lamps' loop, height and depth behind the ring. */
export const FROSTED = {
  floorY: -2,
  maxPanes: 32,
  maxLamps: 8,
  seed: 0xf0e57,
  lampPeriod: 60,
  lampY: 6.5,
  /** Lamps orbit this far outside the ring radius, give or take `lampSwing`. */
  lampOffset: 4.5,
  lampSwing: 1.5,
  /** Lamp angle wander either side of its seat, radians. */
  lampWander: 0.35,
  coreRadius: 0.2,
} as const;

/** One frosted pane: its seat round the ring, size and a seed for its etch band and tooth. */
export interface Pane {
  angle: number;
  radius: number;
  width: number;
  height: number;
  seed: number;
}

/** One lamp behind the ring: its seat angle, integer Lissajous frequencies and phases. */
export interface Lamp {
  angle: number;
  a: number;
  b: number;
  c: number;
  p1: number;
  p2: number;
  p3: number;
}

/** Seeded ring of panes (jittered seats, staggered depth and height, gaps between), then the lamps, from one stream in the sketch's draw order. */
export function frostedLayout(
  paneCount: number,
  lampCount: number,
  ringRadius: number,
): { panes: Pane[]; lamps: Lamp[] } {
  const p = Math.min(FROSTED.maxPanes, Math.max(1, Math.round(paneCount)));
  const n = Math.min(FROSTED.maxLamps, Math.max(1, Math.round(lampCount)));
  const rand = createSeededRandom(FROSTED.seed);
  const panes: Pane[] = [];
  for (let i = 0; i < p; i++) {
    const angle = ((i + 0.5) / p) * TAU + (rand() - 0.5) * 0.08;
    const radius = ringRadius - 1.5 + rand() * 3;
    const width = ((TAU * radius) / p) * (0.62 + rand() * 0.22);
    const height = 5 + rand() * 5.5;
    panes.push({ angle, radius, width, height, seed: rand() });
  }
  const lamps: Lamp[] = [];
  for (let j = 0; j < n; j++) {
    lamps.push({
      angle: ((j + rand() * 0.6) / n) * TAU,
      a: 1 + Math.floor(rand() * 2),
      b: 1 + Math.floor(rand() * 3),
      c: 1 + Math.floor(rand() * 2),
      p1: rand() * TAU,
      p2: rand() * TAU,
      p3: rand() * TAU,
    });
  }
  return { panes, lamps };
}

/** A lamp's position at look time `t` on its exact 60 s Lissajous loop. */
export function lampPosition(
  lamp: Lamp,
  ringRadius: number,
  t: number,
  out: { set(x: number, y: number, z: number): unknown },
): void {
  const { lampPeriod, lampY, lampOffset, lampSwing, lampWander } = FROSTED;
  const w = (TAU * loopSeconds(t, lampPeriod)) / lampPeriod;
  const th = lamp.angle + lampWander * Math.sin(lamp.a * w + lamp.p1);
  const r = ringRadius + lampOffset + lampSwing * Math.sin(lamp.c * w + lamp.p3);
  out.set(Math.cos(th) * r, lampY + Math.sin(lamp.b * w + lamp.p2), Math.sin(th) * r);
}

/** Instance pose of a unit pane quad: local x along the ring's tangent, y up, +z (the front face) toward the stage axis. */
export function panePose(pane: Pane, _i: number, out: InstancePose): void {
  const c = Math.cos(pane.angle);
  const s = Math.sin(pane.angle);
  out.position.set(c * pane.radius, FROSTED.floorY + pane.height / 2, s * pane.radius);
  out.rotation.set(0, Math.atan2(-c, -s), 0);
  out.scale.set(pane.width, pane.height, 1);
}
