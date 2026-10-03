import { createSeededRandom } from "../../../../../engine/rng";
import { type GoboSunPath, goboCompanionSun, loopSeconds, smoothstep } from "../../kit";
import type { Scene3dCompanionLighting } from "../../types";

const TAU = Math.PI * 2;

export const TERRACE_FLOOR_Y = -2;
/** Authored unit: card width, back page height, ring phase (in units), house variants and slots per variant, most units. */
export const TERRACE = {
  width: 5.6,
  page: 3.1,
  phase: 0.21,
  variants: 4,
  slots: 5,
  maxUnits: 20,
} as const;
/** Each unit keeps this share of its arc, so neighbours never touch. */
export const TERRACE_ARC_FILL = 0.9;

/** House types: 1 stepped terrace (two boxes), 2 arcade (arched facade), 3 gabled. 0 is an empty slot. */
export type TerraceHouseType = 0 | 1 | 2 | 3;

/** One house in card coordinates (x along the unit, S toward the stage from the fold, A up the back page): its span, facade depth and height, the stepped upper box (inset `d1`, height `a2`) and the gable rise. */
export interface TerraceHouse {
  x0: number;
  x1: number;
  depth: number;
  height: number;
  inset: number;
  upper: number;
  gable: number;
  type: TerraceHouseType;
}

const EMPTY: TerraceHouse = {
  x0: 0,
  x1: 0,
  depth: 0,
  height: 0,
  inset: 0,
  upper: 0,
  gable: 0,
  type: 0,
};

/** The house table (variants x slots, row-major) and each unit's variant, from one seeded stream (the approved sketch's, so the first 12 units match it). Export contract. */
export function terraceStreet(): { houses: TerraceHouse[]; unitVariant: number[] } {
  const rand = createSeededRandom(0x7e44ace);
  const houses: TerraceHouse[] = [];
  const half = TERRACE.width / 2;
  for (let v = 0; v < TERRACE.variants; v++) {
    let x = -half + 0.3;
    for (let h = 0; h < TERRACE.slots; h++) {
      const w = 1 + rand() * 0.55;
      const type = (1 + Math.floor(rand() * 3)) as TerraceHouseType;
      if (x + w > half - 0.3) {
        houses.push(EMPTY);
        continue;
      }
      if (type === 1) {
        const d1 = 0.55 + rand() * 0.5;
        const d2 = 0.55 + rand() * 0.45;
        const a1 = 0.65 + rand() * 0.45;
        const a2 = 0.6 + rand() * 0.5;
        houses.push({
          ...EMPTY,
          x0: x,
          x1: x + w,
          depth: d1 + d2,
          height: a1,
          inset: d1,
          upper: a2,
          type,
        });
      } else {
        const height = 1.1 + rand() * 1.05;
        const depth = 0.9 + rand() * 0.9;
        const gable = type === 3 ? 0.45 + rand() * 0.25 : 0;
        houses.push({ ...EMPTY, x0: x, x1: x + w, depth, height, gable, type });
      }
      x += w + 0.08 + rand() * 0.16;
    }
  }
  const unitVariant = Array.from(
    { length: TERRACE.maxUnits },
    (_, i) => (i * 3 + Math.floor(rand() * 2)) % TERRACE.variants,
  );
  return { houses, unitVariant };
}

/** Packs the house table into the shader's two vec4 arrays: A (x0, x1, depth, height), B (inset, upper, gable, type). */
export function terraceHouseUniforms(houses: readonly TerraceHouse[]): {
  a: number[][];
  b: number[][];
} {
  return {
    a: houses.map((h) => [h.x0, h.x1, h.depth, h.height]),
    b: houses.map((h) => [h.inset, h.upper, h.gable, h.type]),
  };
}

/** Every unit's pieces as upright card quads: position (x, S, A), meta (unit, role: 0 back page, 1 facade, 2 roof; house slot, variant) and face (u, v along the quad, then two extents the fragment needs for creases and cut-outs). */
export function terraceGeometry(houses: readonly TerraceHouse[], unitVariant: readonly number[]) {
  const pos: number[] = [];
  const meta: number[] = [];
  const face: number[] = [];
  const index: number[] = [];
  const quad = (
    corners: [number, number, number][],
    m: [number, number, number, number],
    ext: [number, number],
  ) => {
    const base = pos.length / 3;
    const uv = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (const [i, c] of corners.entries()) {
      pos.push(...c);
      meta.push(...m);
      face.push(uv[i][0], uv[i][1], ext[0], ext[1]);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const half = TERRACE.width / 2;
  for (let ui = 0; ui < TERRACE.maxUnits; ui++) {
    const v = unitVariant[ui];
    quad(
      [
        [-half, 0, 0],
        [half, 0, 0],
        [half, 0, TERRACE.page],
        [-half, 0, TERRACE.page],
      ],
      [ui, 0, -1, v],
      [TERRACE.page, 0],
    );
    for (let h = 0; h < TERRACE.slots; h++) {
      const k = v * TERRACE.slots + h;
      const house = houses[k];
      if (house.type === 0) continue;
      const { x0, x1, depth: s0, height: a1, gable: g } = house;
      quad(
        [
          [x0, s0, 0],
          [x1, s0, 0],
          [x1, s0, a1 + g],
          [x0, s0, a1 + g],
        ],
        [ui, 1, k, v],
        [a1 + g, a1],
      );
      if (house.type === 1) {
        const d1 = house.inset;
        const a2 = house.upper;
        quad(
          [
            [x0, s0, a1],
            [x1, s0, a1],
            [x1, s0 - d1, a1],
            [x0, s0 - d1, a1],
          ],
          [ui, 2, k, v],
          [d1, 0],
        );
        quad(
          [
            [x0, s0 - d1, a1],
            [x1, s0 - d1, a1],
            [x1, s0 - d1, a1 + a2],
            [x0, s0 - d1, a1 + a2],
          ],
          [ui, 1, k, v],
          [a2, a2],
        );
        quad(
          [
            [x0, s0 - d1, a1 + a2],
            [x1, s0 - d1, a1 + a2],
            [x1, 0, a1 + a2],
            [x0, 0, a1 + a2],
          ],
          [ui, 2, k, v],
          [s0 - d1, 0],
        );
      } else {
        quad(
          [
            [x0, s0, a1],
            [x1, s0, a1],
            [x1, 0, a1],
            [x0, 0, a1],
          ],
          [ui, 2, k, v],
          [s0, 0],
        );
      }
    }
  }
  return {
    position: new Float32Array(pos),
    meta: new Float32Array(meta),
    face: new Float32Array(face),
    index: new Uint16Array(index),
  };
}

/** Unit `ui`'s centre bearing (radians, 0 behind the stage, positive toward +x) for `units` round the ring. */
export function terraceUnitTheta(ui: number, units: number): number {
  return ((ui + 0.5 + TERRACE.phase) / units) * TAU;
}

/** Card width scale so `units` units of TERRACE.width fit the ring with gaps. */
export function terraceWidthScale(radius: number, units: number): number {
  return Math.min(1, (((TAU * radius) / units) * TERRACE_ARC_FILL) / TERRACE.width);
}

export interface TerraceFoldParams {
  units: number;
  wavePeriod: number;
  crests: number;
  openHold: number;
}

/** Wave phase at look time `t` (radians), looping exactly per wave period. */
export function terraceWavePhase(t: number, wavePeriod: number): number {
  return (TAU * loopSeconds(t, wavePeriod)) / wavePeriod;
}

/** Mirrors GLSL `trFold`: the fold angle (radians, 0 standing, pi/2 flat) of the unit centred at bearing `theta`. Crests travel round the ring; each unit holds open `openHold` of the cycle and lies flat about a tenth of it. */
export function terraceFold(theta: number, phase: number, p: TerraceFoldParams): number {
  const crests = Math.round(p.crests);
  const top = Math.cos(Math.PI * Math.min(0.95, Math.max(0.02, p.openHold)));
  const open = smoothstep(-0.95, top, Math.cos(crests * theta - phase));
  return (1 - open) * (Math.PI / 2);
}

/** The virtual sun's path for a Sun azimuth (v9 orbit degrees): elevation 24, swaying 15 degrees either way over 240 s. */
export function terraceSun(azimuthDeg: number): GoboSunPath {
  return { azimuthDeg, elevationDeg: 24, swayDeg: 15, periodS: 240 };
}

/** Matching rig: a soft warm sun from the virtual sun's mean bearing, so devices shade like the cards. */
export function terraceLighting(
  mode: "light" | "dark",
  azimuthDeg: number,
): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: {
      source: dark ? "kookaburra:night-city" : "kookaburra:ferndale-studio",
      intensity: dark ? 0.35 : 0.8,
      rotationDeg: 0,
    },
    sun: goboCompanionSun(terraceSun(azimuthDeg), {
      intensity: dark ? 1.2 : 1.8,
      kelvin: dark ? 4200 : 4600,
      angularDeg: 3,
    }),
    ambient: dark ? 0.2 : 0.45,
  };
}
