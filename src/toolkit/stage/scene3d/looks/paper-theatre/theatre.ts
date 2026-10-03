import { createSeededRandom } from "../../../../../engine/rng";
import { loopSeconds, stageSpot } from "../../kit";
import type { Scene3dCompanionLighting } from "../../types";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

export const THEATRE_FLOOR_Y = -2;

/** One ring of card flats facing the stage: wing count, angular phase (in wings), quad height at Flat height 1 and the gap between wings (a fraction of a wing; negative overlaps). */
export interface TheatreRing {
  radius: number;
  wings: number;
  phase: number;
  height: number;
  gap: number;
}

/** Near hills, the tree row, mid hills, tall ranges and a far range of peaks. */
export const THEATRE_RINGS: readonly TheatreRing[] = [
  { radius: 11.5, wings: 8, phase: 0.13, height: 1.35, gap: 0.08 },
  { radius: 15, wings: 11, phase: 0.61, height: 2.1, gap: 0.06 },
  { radius: 19.5, wings: 12, phase: 0.37, height: 2.7, gap: 0.08 },
  { radius: 26, wings: 11, phase: 0.82, height: 4.2, gap: -0.05 },
  { radius: 33, wings: 12, phase: 0.29, height: 5.6, gap: -0.04 },
];
export const THEATRE_MAX_RINGS = THEATRE_RINGS.length;

/** Rings shown for the Rings param: the near hills and tall ranges always, then the tree row, the mid hills and the far peaks. */
export function theatreVisibleRings(count: number): number[] {
  const n = Math.min(THEATRE_MAX_RINGS, Math.max(2, Math.round(count)));
  if (n === 2) return [0, 3];
  if (n === 3) return [0, 1, 3];
  return THEATRE_RINGS.slice(0, n).map((_, k) => k);
}

/** For each ring, the nearest shown ring inside it (its shadow caster), or -1. */
export function theatreCasters<T extends { [k: number]: number }>(
  visible: readonly number[],
  out: T,
): T {
  let prev = -1;
  for (let k = 0; k < THEATRE_MAX_RINGS; k++) {
    out[k] = prev;
    if (visible.includes(k)) prev = k;
  }
  return out;
}

/** Fly-wire cloud track: radius, top of the wires, lap time at Cloud speed 1. */
export const THEATRE_CLOUDS = { count: 7, radius: 21.5, wireTop: 26, lapS: 480 } as const;

/** The paper sun or moon on its brass wire: bearing (v9 orbit azimuth) swinging over a period, distance, height and disc radius. */
export const THEATRE_SUN = {
  azimuthDeg: 219,
  swayDeg: 3.5,
  periodS: 300,
  distance: 31,
  y: 9,
  size: 1.7,
  wireTop: 70,
} as const;

/** Flats rock on whole cycles per this loop, so the rocking repeats exactly. */
export const THEATRE_ROCK_LOOP_S = 240;
/** The virtual footlight sits this far from the stage axis toward the sun, one unit above the floor. */
export const THEATRE_LAMP = { offset: 1.9, y: -1 } as const;

const FLAT_SEED = 0x9a9e7;
const FAR_SEED = 0x51a7e;

/** Card flats as quads in rest pose: position (x, height fraction 0..1, z), pivot (x, 0, z, phase), info (ring, wing, u, rock cycles per loop). Rings 0 to 3 and the clouds share one seeded stream; the far ring draws its own. */
export interface TheatreFlats {
  position: Float32Array;
  pivot: Float32Array;
  info: Float32Array;
  index: Uint16Array;
}

/** A cloud card: centre bearing, bottom height, width, card height, rock phase and cycles per loop. */
export interface TheatreCloud {
  angle: number;
  y: number;
  width: number;
  height: number;
  phase: number;
  cycles: number;
}

export interface TheatreLayout {
  flats: TheatreFlats;
  clouds: TheatreCloud[];
}

/** Bearing (radians, 0 behind the stage, positive toward +x) of a ring's wing centre. */
export function theatreWingCentre(ring: TheatreRing, wing: number): number {
  return ((wing + ring.phase + 0.5) / ring.wings) * TAU;
}

/** Every flat and cloud, in a fixed seeded order (export contract). */
export function theatreLayout(): TheatreLayout {
  const quads = THEATRE_RINGS.reduce((n, r) => n + r.wings, 0);
  const position = new Float32Array(quads * 12);
  const pivot = new Float32Array(quads * 16);
  const info = new Float32Array(quads * 16);
  const index = new Uint16Array(quads * 6);
  const rand = createSeededRandom(FLAT_SEED);
  const farRand = createSeededRandom(FAR_SEED);
  let q = 0;
  for (const [k, ring] of THEATRE_RINGS.entries()) {
    const r = k < 4 ? rand : farRand;
    const half = (Math.PI / ring.wings) * (1 - ring.gap);
    for (let i = 0; i < ring.wings; i++) {
      const tc = theatreWingCentre(ring, i);
      const ax = ring.radius * Math.sin(tc - half);
      const az = -ring.radius * Math.cos(tc - half);
      const bx = ring.radius * Math.sin(tc + half);
      const bz = -ring.radius * Math.cos(tc + half);
      const phase = r() * TAU;
      const cycles = 16 + Math.floor(r() * 15);
      const corners = [
        [ax, 0, az, 0],
        [bx, 0, bz, 1],
        [bx, 1, bz, 1],
        [ax, 1, az, 0],
      ];
      for (const [c, [x, v, z, u]] of corners.entries()) {
        const o = q * 4 + c;
        position.set([x, v, z], o * 3);
        pivot.set([(ax + bx) / 2, 0, (az + bz) / 2, phase], o * 4);
        info.set([k, i, u, cycles], o * 4);
      }
      const b = q * 4;
      index.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
      q++;
    }
  }
  const clouds: TheatreCloud[] = [];
  for (let i = 0; i < THEATRE_CLOUDS.count; i++) {
    const angle = ((i + 0.3 + rand() * 0.4) / THEATRE_CLOUDS.count) * TAU;
    const y = 4.4 + rand() * 1.4;
    const width = 3.4 * (0.8 + rand() * 0.35);
    clouds.push({
      angle,
      y,
      width,
      height: 1.6 * (width / 3.4),
      phase: rand() * TAU,
      cycles: 12 + Math.floor(rand() * 13),
    });
  }
  return { flats: { position, pivot, info, index }, clouds };
}

/** Cloud cards on the track at rest (before the lap turn): position, pivot (top centre, phase), info (4, cloud, u, cycles) and local (u, card height in cloud units). */
export function theatreCloudQuads(clouds: readonly TheatreCloud[]) {
  const position = new Float32Array(clouds.length * 12);
  const pivot = new Float32Array(clouds.length * 16);
  const info = new Float32Array(clouds.length * 16);
  const local = new Float32Array(clouds.length * 8);
  const index = new Uint16Array(clouds.length * 6);
  for (const [i, c] of clouds.entries()) {
    const cx = THEATRE_CLOUDS.radius * Math.sin(c.angle);
    const cz = -THEATRE_CLOUDS.radius * Math.cos(c.angle);
    const tx = Math.cos(c.angle);
    const tz = Math.sin(c.angle);
    const corners = [
      [-0.5, 0],
      [0.5, 0],
      [0.5, 1],
      [-0.5, 1],
    ];
    for (const [j, [cu, cv]] of corners.entries()) {
      const o = i * 4 + j;
      position.set([cx + tx * cu * c.width, c.y + cv * c.height, cz + tz * cu * c.width], o * 3);
      pivot.set([cx, c.y + c.height, cz, c.phase], o * 4);
      info.set([4, i, cu + 0.5, c.cycles], o * 4);
      local.set([cu + 0.5, (cv * c.height * 3.4) / c.width], o * 2);
    }
    const b = i * 4;
    index.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  return { position, pivot, info, local, index };
}

/** Two fly wires per cloud from its card to the grid, then the sun's brass wire: [x0, y0, z0, x1, y1, z1, kind] with kind 0 cloud, 1 sun. Cloud wires turn with the track, the sun wire with the sun. */
export function theatreWires(clouds: readonly TheatreCloud[]): number[][] {
  const out: number[][] = [];
  for (const c of clouds) {
    const cx = THEATRE_CLOUDS.radius * Math.sin(c.angle);
    const cz = -THEATRE_CLOUDS.radius * Math.cos(c.angle);
    const tx = Math.cos(c.angle);
    const tz = Math.sin(c.angle);
    for (const [along, up] of [
      [-0.22, 0.62],
      [0.25, 0.55],
    ]) {
      const x = cx + tx * c.width * along;
      const z = cz + tz * c.width * along;
      out.push([x, c.y + c.height * up, z, x, THEATRE_CLOUDS.wireTop, z, 0]);
    }
  }
  const s = THEATRE_SUN;
  out.push([0, s.y + s.size * 0.9, -s.distance, 0, s.wireTop, -s.distance, 1]);
  return out;
}

/** Look time quantised to the Stop motion rate (0 keeps it smooth), so every part moves in held steps. */
export function theatreStepTime(t: number, fps: number): number {
  const f = Math.round(fps);
  return f > 0 ? Math.floor(t * f) / f : t;
}

/** The sun's bearing (v9 orbit azimuth, degrees) at look time `t`. */
export function theatreSunAzimuth(t: number): number {
  const s = THEATRE_SUN;
  return s.azimuthDeg + s.swayDeg * Math.sin((TAU * loopSeconds(t, s.periodS)) / s.periodS);
}

/** Turn about +y (three's rotation.y) that carries a part built on the -z axis to the sun's bearing. */
export function theatreSunTurn(azimuthDeg: number): number {
  return azimuthDeg * DEG - Math.PI;
}

/** Turn about +y of the cloud track at look time `t` (one lap per THEATRE_CLOUDS.lapS at Cloud speed 1, loops exactly). */
export function theatreCloudTurn(t: number, cloudSpeed: number): number {
  const lap = THEATRE_CLOUDS.lapS;
  return (-TAU * loopSeconds(t * cloudSpeed, lap)) / lap;
}

/** The disc's elevation from the stage centre, degrees. */
export function theatreSunElevationDeg(): number {
  return Math.round(Math.atan2(THEATRE_SUN.y, THEATRE_SUN.distance) / DEG);
}

/** Matching rig: a soft warm back light from the disc's mean bearing (cool and dim under the moon), plus a faint low front fill like the footlights. */
export function theatreLighting(mode: "light" | "dark"): Scene3dCompanionLighting {
  const dark = mode === "dark";
  return {
    environment: { source: "kookaburra:dawn", intensity: dark ? 0.3 : 0.75, rotationDeg: 0 },
    sun: {
      azimuthDeg: THEATRE_SUN.azimuthDeg,
      elevationDeg: theatreSunElevationDeg(),
      intensity: dark ? 0.9 : 1.6,
      kelvin: dark ? 7600 : 3600,
      angularDeg: 4,
    },
    ambient: dark ? 0.18 : 0.45,
    lights: [
      stageSpot("bg3d-theatre-footlight", {
        azimuthDeg: 0,
        elevationDeg: 8,
        distance: 8,
        irradiance: dark ? 0.35 : 0.25,
        coneDeg: 40,
        kelvin: dark ? 3400 : 3000,
      }),
    ],
  };
}
