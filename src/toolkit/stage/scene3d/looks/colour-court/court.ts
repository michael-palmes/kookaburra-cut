import { createSeededRandom } from "../../../../../engine/rng";

/** Colour court layout: freestanding plaster walls round the stage, each a vertical rectangle standing on the floor. Layout seed 1 is the approved sketch's hand layout; other seeds mirror and jitter it without letting walls cross or crowd the stage. */

export const COURT_FLOOR_Y = -2;
export const COURT_MAX_WALLS = 10;
export const COURT_WALL_THICKNESS = 0.4;
/** The wall that holds the light slot (it is always shown). */
export const COURT_SLOT_WALL = 1;
/** The slot in its wall's own units: centre along the wall, half width, bottom and top above the floor (above the text band). */
export const COURT_SLOT = { u: 0.6, halfWidth: 0.26, bottom: 5, top: 11.2 } as const;
/** The virtual sun's mean azimuth (v9 orbit convention): behind the stage on the slot wall's side, so walls stand backlit over long shadows. */
export const COURT_SUN_AZIMUTH = 135;

/** The sun's mean azimuth for a layout seed: mirrored layouts (even seeds) mirror the sun too, so the slot's blade still lands by the stage. */
export function courtSunAzimuth(seed: number): number {
  return Math.round(seed) % 2 === 0 ? 360 - COURT_SUN_AZIMUTH : COURT_SUN_AZIMUTH;
}

/** Walls stand between these distances from the stage axis (their nearest point). */
export const COURT_REACH = { near: 11, far: 28 } as const;

export interface CourtWall {
  x: number;
  z: number;
  /** Tangent angle in degrees: the wall runs along (cos a, 0, sin a). */
  angleDeg: number;
  width: number;
  height: number;
  /** Palette index: 0 Rosa, 1 Ochre, 2 Jacaranda. */
  colour: number;
  /** True when its stage-side face carries soft colour fields. */
  fields: boolean;
}

const wall = (
  x: number,
  z: number,
  angleDeg: number,
  width: number,
  height: number,
  colour: number,
  fields: boolean,
): CourtWall => ({ x, z, angleDeg, width, height, colour, fields });

/** The sketch's eight walls in the order the Walls slider drops them (last first), plus two more for the top of the range. */
export const COURT_BASE: readonly CourtWall[] = [
  wall(-1, -19, 0, 18, 10, 0, false),
  wall(9, -12.5, 60, 7, 12, 1, false),
  wall(-13, -10, -60, 10, 8, 2, true),
  wall(18, 4, 95, 12, 9, 0, true),
  wall(-4, 17, 0, 14, 9, 2, true),
  wall(-17, 8, 70, 11, 11, 1, false),
  wall(8, -26, -8, 12, 6.5, 2, false),
  wall(10, 18, -20, 11, 7, 0, false),
  wall(-17, -20, 35, 9, 7, 1, false),
  wall(21, -9, 75, 9, 8, 2, false),
];

type Seg = readonly [number, number, number, number];

function segment(w: CourtWall): Seg {
  const a = (w.angleDeg * Math.PI) / 180;
  const hx = (Math.cos(a) * w.width) / 2;
  const hz = (Math.sin(a) * w.width) / 2;
  return [w.x - hx, w.z - hz, w.x + hx, w.z + hz];
}

function segDistance(a: Seg, b: Seg): number {
  const pointSeg = (px: number, pz: number, s: Seg) => {
    const dx = s[2] - s[0];
    const dz = s[3] - s[1];
    const t = Math.max(0, Math.min(1, ((px - s[0]) * dx + (pz - s[1]) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(px - s[0] - t * dx, pz - s[1] - t * dz);
  };
  const cross = (o: [number, number], p: [number, number], q: [number, number]) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const a0: [number, number] = [a[0], a[1]];
  const a1: [number, number] = [a[2], a[3]];
  const b0: [number, number] = [b[0], b[1]];
  const b1: [number, number] = [b[2], b[3]];
  if (cross(a0, a1, b0) * cross(a0, a1, b1) < 0 && cross(b0, b1, a0) * cross(b0, b1, a1) < 0) {
    return 0;
  }
  return Math.min(
    pointSeg(a[0], a[1], b),
    pointSeg(a[2], a[3], b),
    pointSeg(b[0], b[1], a),
    pointSeg(b[2], b[3], a),
  );
}

/** Nearest distance from the stage axis to a wall's footprint line. */
export function courtWallReach(w: CourtWall): number {
  const s = segment(w);
  const dx = s[2] - s[0];
  const dz = s[3] - s[1];
  const t = Math.max(0, Math.min(1, -(s[0] * dx + s[1] * dz) / (dx * dx + dz * dz)));
  return Math.hypot(s[0] + t * dx, s[1] + t * dz);
}

/** Closest approach between two walls' footprints (0 when they cross). */
export function courtWallGap(a: CourtWall, b: CourtWall): number {
  return segDistance(segment(a), segment(b));
}

const MIN_GAP = 1;
const TRIES = 24;

/** The layout for a seed (1 to 12): seed 1 is the sketch exactly; others mirror on even seeds, rotate the palette and jitter each wall's place, turn and size, keeping every wall in reach and clear of the others. The back wall stays behind the stage and the slot wall keeps its slot. */
export function courtLayout(seed: number): CourtWall[] {
  const s = Math.max(1, Math.round(seed));
  if (s === 1) return COURT_BASE.map((w) => ({ ...w }));
  const rand = createSeededRandom(0x0c0c7 + s * 7919);
  const mirror = s % 2 === 0 ? -1 : 1;
  const shift = s % 3;
  const placed: CourtWall[] = [];
  COURT_BASE.forEach((base, i) => {
    const anchor: CourtWall = {
      ...base,
      x: base.x * mirror,
      angleDeg: base.angleDeg * mirror,
      colour: i === COURT_SLOT_WALL ? base.colour : (base.colour + shift) % 3,
    };
    const swing = i === 0 ? 4 : 14;
    let chosen = anchor;
    for (let k = 0; k < TRIES; k++) {
      const turn = ((rand() - 0.5) * 2 * swing * Math.PI) / 180;
      const pull = 1 + (rand() - 0.5) * 0.24;
      const yaw = (rand() - 0.5) * 30;
      const size = 1 + (rand() - 0.5) * 0.2;
      const lift = 1 + (rand() - 0.5) * 0.2;
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      const trial: CourtWall = {
        ...anchor,
        x: (anchor.x * c - anchor.z * sn) * pull,
        z: (anchor.x * sn + anchor.z * c) * pull,
        angleDeg: anchor.angleDeg + yaw,
        width: anchor.width * size,
        height: i === COURT_SLOT_WALL ? anchor.height : anchor.height * lift,
      };
      const reach = courtWallReach(trial);
      const clear = placed.every((p) => courtWallGap(p, trial) >= MIN_GAP);
      if (reach >= COURT_REACH.near && reach <= COURT_REACH.far && clear) {
        chosen = trial;
        break;
      }
    }
    placed.push(chosen);
  });
  return placed;
}
