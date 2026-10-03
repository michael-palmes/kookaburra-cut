import type { Vector4 } from "three";
import { loopSeconds, seededPlacements, smoothstep } from "../../kit";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Rig constants shared by the component, its shaders and tests. */
export const BLOOMS = {
  /** Capacity: the Blooms slider maximum. Uniform arrays and geometry are sized for it. */
  max: 24,
  rigY: 16,
  floorY: -2.3,
  outerPetals: 14,
  innerPetals: 10,
  seed: 0x5e11,
  petalSeed: 0x5e12,
  phase0: 0.12,
  /** Sway on the cables (x, z amplitude) and its rough period in seconds. */
  sway: [0.22, 0.12] as const,
  swaySeconds: 7.3,
  flutterSeconds: 3.2,
  /** The outer ring starts half its step past straight back, so its back pair sits either side of the stage axis. */
  azimuthOffsetDeg: 180,
  /** Share of the blooms on the outer ring; the rest form the flank tier. */
  outerShare: 0.6,
  /** The flank tier hangs on an inner ring at this share of the radius, dealt round the four quadrants off the stage axis and spread over this arc (degrees from the axis), so a front camera sees blooms either side of the content at any count. */
  innerRadius: 0.7,
  flankArcDeg: [36, 55] as const,
  /** Outer slots within this angle of the stage axis (degrees, front or back) open above the headline. Slot angles are multiples of 180 / slots, and no ring of 4 to 14 slots lands within 1.5 degrees of it. */
  axisConeDeg: 34.3,
  /** Every other bloom opens low beside the content at this share of the open height; flank blooms alternate with the middle share. */
  sideHeight: 0.12,
  midHeight: 0.22,
  /** Low blooms park this share of the drop above their open height, so they never cross the headline. */
  lowDrop: 0.3,
  /** Portrait frames wrap the headline higher, so blooms there open this much higher and this share smaller to clear it. */
  portraitLift: 0.5,
  portraitShrink: 0.14,
  /** Phases step round the rings by the coprime stride nearest this fraction of the count (golden angle), so open blooms spread evenly. */
  strideFraction: 0.382,
} as const;

export const PETALS_PER_BLOOM = BLOOMS.outerPetals + BLOOMS.innerPetals;

export interface BloomAnchor {
  x: number;
  z: number;
  /** Open height as a share of the open height param, with a little per-bloom jitter. */
  lift: number;
  /** Opens above the headline and parks above the frame; low blooms park just over their open height. */
  high: boolean;
  /** Sway phase, radians. */
  sway: number;
  /** Cycle phase in [0, 1). */
  phase: number;
  /** Per-bloom size factor, 0.9 to 1.1. */
  size: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** The coprime step nearest the golden fraction of `count`, so stepping phases round the rings visits every bloom once and keeps open blooms spread out. */
export function bloomStride(count: number): number {
  let best = 1;
  for (let s = 2; s < count; s++) {
    if (gcd(s, count) !== 1) continue;
    const target = count * BLOOMS.strideFraction;
    if (best === 1 || Math.abs(s - target) < Math.abs(best - target)) best = s;
  }
  return best;
}

/** Whole turns of a periodic motion per cycle, nearest to `seconds` each, so the look loops exactly at the cycle. */
export function turnsPerCycle(cycle: number, seconds: number): number {
  return Math.max(1, Math.round(cycle / seconds));
}

const jitters = seededPlacements(BLOOMS.seed, BLOOMS.max, (rand) => ({
  az: (rand() - 0.5) * 3,
  r: (rand() - 0.5) * 1.2,
  sway: rand() * TAU,
  size: 0.9 + rand() * 0.2,
  hang: 1 + (rand() - 0.5) * 0.06,
}));

/** How far a frame of `aspect` counts as portrait: 0 at 1.2 and wider, 1 at 0.6 and narrower. */
export function bloomPortrait(aspect: number): number {
  return 1 - smoothstep(0.6, 1.2, aspect);
}

/** Whether an outer slot at azimuth `az` (radians) sits near the stage axis, front or back, and so opens above the headline. */
export function bloomHigh(az: number): boolean {
  return Math.asin(Math.min(1, Math.abs(Math.sin(az)))) / DEG < BLOOMS.axisConeDeg;
}

/** Flank slot `k` of `count`: dealt back left, back right, front left, front right, then spread over the arc within its quadrant. Returns the azimuth in degrees and the open height share. */
export function flankSlot(k: number, count: number): [number, number] {
  const quadrant = k % 4;
  const i = Math.floor(k / 4);
  const inQuadrant = Math.floor((count - quadrant + 3) / 4);
  const [from, to] = BLOOMS.flankArcDeg;
  const off = from + ((to - from) * (i + 0.5)) / inQuadrant;
  const az = [180 - off, 180 + off, off, 360 - off][quadrant];
  return [az, i % 2 ? BLOOMS.midHeight : BLOOMS.sideHeight];
}

/** Blooms on two tiers: the outer ring evenly round the rig (high near the stage axis, low elsewhere) and the flank tier low in the quadrants either side of the content. Jitter is seeded by index, and phases step by azimuth so blooms open in turn. */
export function bloomAnchors(count: number, radius: number): BloomAnchor[] {
  const n = Math.max(1, Math.min(BLOOMS.max, Math.round(count)));
  const outer = Math.max(1, Math.round(n * BLOOMS.outerShare));
  const out: BloomAnchor[] = [];
  const turn: number[] = [];
  for (let j = 0; j < n; j++) {
    const inner = j >= outer;
    const jit = jitters[j];
    let slotDeg = BLOOMS.azimuthOffsetDeg + (360 * (j + 0.5)) / outer;
    let share = 1;
    if (inner) [slotDeg, share] = flankSlot(j - outer, n - outer);
    const slot = slotDeg * DEG;
    const high = !inner && bloomHigh(slot);
    if (!inner && !high) share = BLOOMS.sideHeight;
    turn.push((((slotDeg - BLOOMS.azimuthOffsetDeg) % 360) + 360) % 360);
    const az = slot + jit.az * DEG;
    const r = (radius + jit.r) * (inner ? BLOOMS.innerRadius : 1);
    out.push({
      x: Math.sin(az) * r,
      z: Math.cos(az) * r,
      lift: share * jit.hang,
      high,
      sway: jit.sway,
      phase: 0,
      size: jit.size,
    });
  }
  const stride = bloomStride(n);
  const order = out.map((_, j) => j).sort((a, b) => turn[a] - turn[b] || a - b);
  order.forEach((j, rank) => {
    out[j].phase = (BLOOMS.phase0 + ((stride * rank) % n) / n) % 1;
  });
  return out;
}

/** How far a bloom at cycle phase u in [0, 1) has dropped from its parked height (0 to 1). */
export const bloomDrop = (u: number) => smoothstep(0, 0.2, u) - smoothstep(0.46, 0.66, u);

/** How open a bloom is at cycle phase u: it opens as it lands and closes once the rise has begun, so a hanging bud never reaches below the open rim. */
export const bloomOpen = (u: number) => smoothstep(0.08, 0.2, u) - smoothstep(0.48, 0.58, u);

/** Writes each bloom's swayed core position and openness (x, y, z, open) for look time `t`: high blooms park at `openHeight + drop`, low ones a share of the drop over their open height. Unused slots park closed at the rig. */
export function writeBloomPoses(
  out: Vector4[],
  anchors: readonly BloomAnchor[],
  t: number,
  cycle: number,
  openHeight: number,
  drop: number,
): void {
  const local = loopSeconds(t, cycle);
  const swayTurns = turnsPerCycle(cycle, BLOOMS.swaySeconds);
  for (let j = 0; j < out.length; j++) {
    const a = anchors[j];
    if (!a) {
      out[j].set(0, BLOOMS.rigY, 0, 0);
      continue;
    }
    const u = loopSeconds(local / cycle + a.phase, 1);
    const sw = (TAU * swayTurns * local) / cycle + a.sway;
    const low = a.lift * openHeight;
    const park = a.high ? openHeight + drop : low + drop * BLOOMS.lowDrop;
    out[j].set(
      a.x + BLOOMS.sway[0] * Math.sin(sw),
      low + (park - low) * (1 - bloomDrop(u)),
      a.z + BLOOMS.sway[1] * Math.cos(sw),
      bloomOpen(u),
    );
  }
}

/** Petal flutter phase (radians) for look time `t`, a whole number of flutters per cycle. */
export function flutterPhase(t: number, cycle: number): number {
  const turns = turnsPerCycle(cycle, BLOOMS.flutterSeconds);
  return TAU * loopSeconds((loopSeconds(t, cycle) * turns) / cycle, 1);
}
