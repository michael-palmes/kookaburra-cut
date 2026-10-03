import { createSeededRandom, type SeededRandom } from "../../../../../engine/rng";
import { type InkParam, type InkStrand, inkPolyline } from "../../kit/inkRibbon";
import { splatBoilStep } from "../../kit/strokeSplats";

/** Shadow lace layout: seeded L-system silhouettes (gums, fern rosettes, reed clumps) in two rings round the stage, and boughs hanging in from beyond them. Each plant is a set of F2 ink strands in its own flat card facing the stage; a point's vec4 is (across, up, width, sway weight) and a strand's data is (ring angle, radius, pivot y, 8 x frequency + phase). Placements are EXPORT CONTRACT: one seeded stream, near ring, far ring, then boughs, each in density order. */

const TAU = Math.PI * 2;
const GOLDEN = 0.6180339887498949;

export const GROUND_Y = -2;
/** Plant counts at Density 1; the pool holds DENSITY_MAX times as many, and a density shows a prefix. */
export const PLANTS = { near: 26, far: 30, boughs: 8 } as const;
export const DENSITY_MAX = 1.6;
/** Ring angle (0 straight ahead of the default camera, positive to its right) inside which plants stay low: ferns in the near ring, shortened gums in the far ring. Covers the device and the 9:16 frame. */
export const QUIET_HALF_ANGLE = 0.42;
/** Boughs keep this far from straight ahead, clear of the headline. */
export const BOUGH_GAP = 0.62;
export const BOUGH_TOP = 11.5;
/** Hummock bands at each ring's foot: radius, ring and noise seed. */
export const HUMMOCKS = [
  { radius: 22.5, ring: "far", seed: 29 },
  { radius: 14, ring: "near", seed: 11 },
] as const;
/** Sway loops every SWAY_LOOP look seconds: every frequency is a whole number of cycles in it. */
export const SWAY_LOOP = 60;
const SEED = 0x1ace5;

export type LaceRing = "near" | "far" | "boughs";

export interface LacePlant {
  ring: LaceRing;
  th: number;
  r: number;
  pivotY: number;
  height: number;
  phase: number;
  /** Whole sway cycles per SWAY_LOOP. */
  freq: number;
  strands: InkStrand[];
}

/** Wraps an angle into (-pi, pi]. */
export function wrapAngle(a: number): number {
  const w = (((a + Math.PI) % TAU) + TAU) % TAU;
  return w - Math.PI;
}

export const isQuiet = (th: number): boolean => Math.abs(wrapAngle(th)) < QUIET_HALF_ANGLE;

interface Pt {
  u: number;
  v: number;
  w: number;
}

class PlantBuilder {
  readonly strands: InkStrand[] = [];
  constructor(
    readonly plant: Omit<LacePlant, "strands">,
    readonly rand: SeededRandom,
  ) {}

  ribbon(pts: readonly Pt[]): void {
    const { pivotY, height, th, r, phase, freq } = this.plant;
    const params: InkParam[] = pts.map((p) => {
      const weight = Math.min(1, Math.max(0, Math.abs(p.v - (pivotY - GROUND_Y)) / height)) ** 1.4;
      return [round(p.u), round(p.v), round(p.w), round(weight)];
    });
    this.strands.push(inkPolyline(params, [round(th), round(r), pivotY, freq * 8 + round(phase)]));
  }

  leaf(u: number, v: number, ang: number, len: number, w: number): void {
    const su = Math.sin(ang);
    const cv = Math.cos(ang);
    this.ribbon([
      { u, v, w: 0 },
      { u: u + su * len * 0.45, v: v + cv * len * 0.45, w },
      { u: u + su * len, v: v + cv * len, w: 0 },
    ]);
  }

  tree(
    u0: number,
    v0: number,
    ang0: number,
    len0: number,
    w0: number,
    levels: number,
    droop: number,
  ) {
    const rand = this.rand;
    const branch = (u: number, v: number, ang: number, len: number, w: number, lvl: number) => {
      const pts: Pt[] = [{ u, v, w }];
      let cu = u;
      let cv = v;
      let a = ang;
      for (let i = 1; i <= 3; i++) {
        a += (rand() - 0.5) * 0.25 + droop * 0.06 * Math.sign(Math.sin(ang) || 1);
        cu += (Math.sin(a) * len) / 3;
        cv += (Math.cos(a) * len) / 3;
        pts.push({ u: cu, v: cv, w: w * (1 - (0.35 * i) / 3) });
      }
      this.ribbon(pts);
      if (lvl >= levels) {
        const leaves = 8 + Math.floor(rand() * 6);
        for (let j = 0; j < leaves; j++) {
          const la = Math.PI + (rand() - 0.5) * 1.6 + Math.sin(a) * 0.4 * droop;
          const pu = cu + (rand() - 0.5) * len * 0.5;
          const pv = cv + (rand() - 0.5) * len * 0.3;
          this.leaf(pu, pv, la, 0.28 + rand() * 0.16, 0.075 + rand() * 0.035);
        }
        return;
      }
      const kids = rand() < 0.3 ? 3 : 2;
      for (let k = 0; k < kids; k++) {
        const spread = (k / (kids - 1) - 0.5) * (0.9 + rand() * 0.5);
        branch(cu, cv, a + spread, len * (0.66 + rand() * 0.14), w * 0.62, lvl + 1);
      }
    };
    branch(u0, v0, ang0, len0, w0, 1);
  }

  fern(u0: number): void {
    const rand = this.rand;
    const fronds = 5 + Math.floor(rand() * 3);
    for (let f = 0; f < fronds; f++) {
      const a0 = (f / (fronds - 1) - 0.5) * 2.3;
      const len = (0.9 + rand() * 0.5) * (1 - Math.abs(a0) * 0.18);
      const pts: (Pt & { a: number })[] = [];
      for (let i = 0; i <= 8; i++) {
        const s = i / 8;
        const a = a0 * (0.4 + s * 0.9);
        const prev = pts[i - 1] ?? { u: u0, v: 0 };
        pts.push({
          u: prev.u + (i === 0 ? 0 : (Math.sin(a) * len) / 8),
          v: prev.v + (i === 0 ? 0 : (Math.cos(a) * len) / 8),
          w: 0.035 * (1 - s * 0.7),
          a,
        });
      }
      this.ribbon(pts);
      for (let i = 1; i < 8; i++) {
        const p = pts[i];
        const pl = 0.2 * (1 - i / 8) + 0.05;
        for (const side of [-1, 1]) this.leaf(p.u, p.v, p.a + side * 1.15, pl, 0.06);
      }
    }
  }

  reeds(u0: number): void {
    const rand = this.rand;
    const n = 4 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const u = u0 + (rand() - 0.5) * 0.7;
      const h = 1 + rand() * 1.1;
      const bend = (rand() - 0.5) * 0.5;
      const pts: Pt[] = [];
      for (let s = 0; s <= 4; s++) {
        const f = s / 4;
        pts.push({ u: u + bend * f * f * h, v: f * h, w: 0.06 * (1 - f * 0.85) });
      }
      this.ribbon(pts);
      if (rand() < 0.4) {
        const top = pts[3];
        this.ribbon([
          { u: top.u, v: top.v - 0.05, w: 0.02 },
          { u: top.u + bend * 0.05, v: top.v + 0.12, w: 0.09 },
          { u: top.u + bend * 0.1, v: top.v + 0.32, w: 0 },
        ]);
      }
    }
  }
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/** The plant pool at DENSITY_MAX: ring positions follow a golden-ratio sequence, so the first n of a ring stay evenly spread at any density. */
export function placeLace(): LacePlant[] {
  const rand = createSeededRandom(SEED);
  const out: LacePlant[] = [];
  const make = (ring: LaceRing, th: number, r: number, height: number, pivotY = GROUND_Y) =>
    new PlantBuilder(
      { ring, th, r, height, pivotY, phase: rand() * TAU, freq: 6 + Math.floor(rand() * 5) },
      rand,
    );
  const add = (b: PlantBuilder) => out.push({ ...b.plant, strands: b.strands });
  const nearCount = Math.round(PLANTS.near * DENSITY_MAX);
  for (let i = 0; i < nearCount; i++) {
    const th = TAU * ((i * GOLDEN + 0.13 + (rand() - 0.5) * 0.02) % 1);
    const r = 12.5 + rand() * 2;
    const kind = isQuiet(th) ? 2 : i % 4;
    if (kind === 0) {
      const h = 2.6 + rand() * 1.2;
      const b = make("near", th, r, h);
      b.tree(0, 0, (rand() - 0.5) * 0.25, h * 0.42, 0.13, 4, 1);
      add(b);
    } else if (kind === 2) {
      const b = make("near", th, r, 1.3);
      b.fern(0);
      add(b);
    } else {
      const b = make("near", th, r, 2);
      b.reeds(0);
      add(b);
    }
  }
  const farCount = Math.round(PLANTS.far * DENSITY_MAX);
  for (let i = 0; i < farCount; i++) {
    const th = TAU * ((i * GOLDEN + 0.41 + (rand() - 0.5) * 0.02) % 1);
    const r = 20 + rand() * 4;
    if (i % 3 !== 2) {
      const h = (3.8 + rand() * 2.2) * (isQuiet(th) ? 0.6 : 1);
      const b = make("far", th, r, h);
      b.tree(0, 0, (rand() - 0.5) * 0.3, h * 0.4, 0.2, 4, 1);
      add(b);
    } else {
      const b = make("far", th, r, 2.2);
      b.reeds(0);
      add(b);
    }
  }
  const boughCount = Math.round(PLANTS.boughs * DENSITY_MAX);
  for (let i = 0; i < boughCount; i++) {
    const th = BOUGH_GAP + (TAU - 2 * BOUGH_GAP) * ((0.5 + i * GOLDEN) % 1);
    const b = make("boughs", th, 15.5 + rand() * 2, 8, BOUGH_TOP);
    const dir = wrapAngle(th) < 0 ? 1 : -1;
    b.tree(
      dir * -1.5,
      BOUGH_TOP - GROUND_Y,
      Math.PI - dir * (0.9 + rand() * 0.35),
      3.2,
      0.2,
      4,
      2.2,
    );
    add(b);
  }
  return out;
}

/** Strands of one ring in pool order, with the strand count after each plant (so a density shows a whole-plant prefix). */
export function laceRing(
  plants: readonly LacePlant[],
  ring: LaceRing,
): { strands: InkStrand[]; plantEnds: number[] } {
  const strands: InkStrand[] = [];
  const plantEnds: number[] = [];
  for (const p of plants) {
    if (p.ring !== ring) continue;
    strands.push(...p.strands);
    plantEnds.push(strands.length);
  }
  return { strands, plantEnds };
}

/** How many plants of a ring a Density value shows. */
export function lacePlantCount(ring: LaceRing, density: number): number {
  const max = Math.round(PLANTS[ring] * DENSITY_MAX);
  return Math.max(0, Math.min(max, Math.round(PLANTS[ring] * density)));
}

/** Stop-motion sway clock: the frame clock stepped at `stepFps` (exact on export frames), scaled by the look speed and looped at SWAY_LOOP. */
export function laceStepSeconds(globalMs: number, stepFps: number, speed: number): number {
  const fps = Math.max(1, Math.round(stepFps));
  const t = (splatBoilStep(globalMs, fps) / fps) * speed;
  const r = t % SWAY_LOOP;
  return r < 0 ? r + SWAY_LOOP : r;
}

/** The lamp's elevation on the shell (degrees): low on the horizon behind the lace. */
export const LAMP_ELEVATION_DEG = 5.7;

/** Unit direction from the stage to the lamp; azimuth 0 is straight ahead of the default camera, positive to its right. */
export function lampDirection(azimuthDeg: number): [number, number, number] {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (LAMP_ELEVATION_DEG * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/** The lamp's bearing in the v9 orbit convention (0 toward the default camera), for a companion sun at the lamp. */
export function lampOrbitAzimuth(azimuthDeg: number): number {
  return wrapAngle(Math.PI - (azimuthDeg * Math.PI) / 180) * (180 / Math.PI);
}
