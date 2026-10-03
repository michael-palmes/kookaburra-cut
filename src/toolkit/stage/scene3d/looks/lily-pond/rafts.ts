import {
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  PlaneGeometry,
  Sphere,
  Vector3,
} from "three";
import { createSeededRandom } from "../../../../../engine/rng";

/** Lily pond rafts: pads packed compactly inside rafts with a minimum gap (neighbours at most touch), each raft drifting rigidly round its own eddy, and every raft's whole sweep clear of every other raft, the clearing and the water's rim. Placements are EXPORT CONTRACT: one seeded stream, then rafts nearest the stage first, each raft's pads core first. */

const TAU = Math.PI * 2;

export const WATER_Y = -2.2;
/** The water disc; rafts stay inside RAFT_LIMIT, deep in the haze. */
export const WATER_RADIUS = 110;
const RAFT_LIMIT = 104;
/** Raft eddy periods (s): all divide RAFT_LOOP, so the drift loops exactly. */
export const RAFT_PERIODS = [30, 40, 60] as const;
export const RAFT_LOOP = 120;
/** Pads turn in place by up to this many radians each side as their raft circles. */
export const PAD_TURN = 0.25;
/** The densest Pads slider value: the pool size. */
export const PAD_POOL = 400;
const SEED = 0x1117;
const MAX_TRIES = 20000;
/** Darts thrown per pad: the one nearest the raft centre that fits wins, so rafts pack compactly. */
const PAD_DARTS = 16;
/** Minimum water between two rafts' sweeps. */
export const RAFT_GAP = 0.15;
/** Raft centres start this far beyond the clearing, out to RAFT_BAND further. */
const RAFT_INNER = 2;
const RAFT_BAND = 85;

export interface LilyRaft {
  x: number;
  z: number;
  /** Pad centres sit within this radius of the raft centre. */
  spread: number;
  eddy: number;
  /** Radius of the disc the raft sweeps over a whole orbit. */
  reach: number;
  period: number;
  phase: number;
}

export interface LilyPad {
  raft: number;
  x: number;
  z: number;
  radius: number;
  yaw: number;
  eddy: number;
  period: number;
  phase: number;
  spin: number;
  tone: number;
  /** A blossom shows on this pad while `bloomKey < blossoms`. */
  bloomKey: number;
  bloomSize: number;
  /** Blossom offset from the pad centre, as a fraction of the pad radius. */
  bloomOffset: number;
  bloomAngle: number;
}

/** The pad pool for a clearing radius, PAD_POOL long: rafts nearest the stage first, each raft's pads nearest its centre first. A Pads value of n shows the first n, so fewer pads means fewer, nearer rafts, never holed ones. */
export function placeLilyPads(clearRadius: number): { rafts: LilyRaft[]; pads: LilyPad[] } {
  const rand = createSeededRandom(SEED);
  const placed: { raft: LilyRaft; pads: LilyPad[] }[] = [];
  let total = 0;
  for (let tries = 0; total < PAD_POOL && tries < MAX_TRIES; tries++) {
    const ca = rand() * TAU;
    const cr = clearRadius + RAFT_INNER + rand() * RAFT_BAND;
    const spread = 1.8 + rand() * 2 + cr * 0.07;
    const eddy = 0.35 + rand() * 0.5;
    const period = RAFT_PERIODS[Math.floor(rand() * RAFT_PERIODS.length)];
    const phase = rand() * TAU;
    const scale = 1 + cr / 40;
    const reach = spread + 1.15 * scale + eddy;
    if (cr - reach < clearRadius || cr + reach > RAFT_LIMIT) continue;
    const x = Math.cos(ca) * cr;
    const z = Math.sin(ca) * cr;
    if (placed.some(({ raft: r }) => Math.hypot(r.x - x, r.z - z) < r.reach + reach + RAFT_GAP))
      continue;
    const raft: LilyRaft = { x, z, spread, eddy, reach, period, phase };
    const want = 8 + Math.floor(rand() * 10);
    const mine: LilyPad[] = [];
    for (let attempt = 0; mine.length < want && attempt < 60; attempt++) {
      const radius = (0.55 + rand() * 0.6) * scale;
      let best: { x: number; z: number; d: number } | null = null;
      for (let k = 0; k < PAD_DARTS; k++) {
        const a = rand() * TAU;
        const d = Math.sqrt(rand()) * spread;
        const px = x + Math.cos(a) * d;
        const pz = z + Math.sin(a) * d;
        if (mine.some((q) => Math.hypot(q.x - px, q.z - pz) < q.radius + radius)) continue;
        if (!best || d < best.d) best = { x: px, z: pz, d };
      }
      const pad: LilyPad = {
        raft: 0,
        x: best?.x ?? x,
        z: best?.z ?? z,
        radius,
        yaw: rand() * TAU,
        eddy,
        period,
        phase,
        spin: rand() * TAU,
        tone: rand(),
        bloomKey: rand(),
        bloomSize: 0.26 + rand() * 0.08,
        bloomOffset: 0.25 + rand() * 0.2,
        bloomAngle: rand() * TAU,
      };
      if (best) mine.push(pad);
    }
    const core = (p: LilyPad) => Math.hypot(p.x - x, p.z - z);
    mine.sort((a, b) => core(a) - core(b));
    placed.push({ raft, pads: mine });
    total += mine.length;
  }
  const centre = (r: LilyRaft) => Math.hypot(r.x, r.z);
  placed.sort((a, b) => centre(a.raft) - centre(b.raft));
  const rafts = placed.map((p) => p.raft);
  const pads = placed
    .flatMap((p, raft) => p.pads.map((pad) => ({ ...pad, raft })))
    .slice(0, PAD_POOL);
  return { rafts, pads };
}

/** A pad's centre and yaw at raft time `t` (seconds, looped at RAFT_LOOP); the pad vertex shader mirrors it. */
export function lilyPadPose(pad: LilyPad, t: number): { x: number; z: number; yaw: number } {
  const w = (TAU * t) / pad.period + pad.phase;
  return {
    x: pad.x + Math.cos(w) * pad.eddy,
    z: pad.z + Math.sin(w) * pad.eddy,
    yaw: pad.yaw + PAD_TURN * Math.sin(w + pad.spin),
  };
}

/** One quad per pad with the pool as instance attributes: `aPad` (x, z, radius, yaw), `aRaft` (eddy, period, phase, spin), `aPadKey` (tone, bloom key, 0, 0), `aBloom` (size, offset, angle, 0). Pads and blossoms share it; `instanceCount` is the Pads value. The bounding sphere is stage-centred so mount order is draw order. */
export function lilyPadGeometry(pads: readonly LilyPad[]): InstancedBufferGeometry {
  const quad = new PlaneGeometry(2, 2);
  const g = new InstancedBufferGeometry();
  g.setIndex(quad.getIndex());
  g.setAttribute("position", quad.getAttribute("position"));
  const n = pads.length;
  const pad = new Float32Array(n * 4);
  const raft = new Float32Array(n * 4);
  const key = new Float32Array(n * 4);
  const bloom = new Float32Array(n * 4);
  let reach = 1;
  pads.forEach((p, i) => {
    pad.set([p.x, p.z, p.radius, p.yaw], i * 4);
    raft.set([p.eddy, p.period, p.phase, p.spin], i * 4);
    key.set([p.tone, p.bloomKey, 0, 0], i * 4);
    bloom.set([p.bloomSize, p.bloomOffset, p.bloomAngle, 0], i * 4);
    reach = Math.max(reach, Math.hypot(p.x, p.z) + p.eddy + p.radius);
  });
  g.setAttribute("aPad", new InstancedBufferAttribute(pad, 4));
  g.setAttribute("aRaft", new InstancedBufferAttribute(raft, 4));
  g.setAttribute("aPadKey", new InstancedBufferAttribute(key, 4));
  g.setAttribute("aBloom", new InstancedBufferAttribute(bloom, 4));
  g.instanceCount = n;
  g.boundingSphere = new Sphere(new Vector3(), reach);
  quad.dispose();
  return g;
}

/** Ripple ring periods (s): the first six spawn every 6 to 15 s, and every period divides RIPPLE_LOOP, so the schedule loops exactly. */
export const RIPPLE_PERIODS = [6, 7.5, 9, 10, 12, 15, 8, 20, 7, 24] as const;
export const RIPPLE_LOOP = 2520;
