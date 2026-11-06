import { loopSeconds } from "../../kit/clock";

/** Gallery staging in world units: the oak floor, the hanging wall the bays sit in (works hang just in front of `wallZ`), the clerestory band above the piers, and the ceiling. Bays centre on x = k * bay width, so one always sits behind the stage; piers stand between them. */
export const GALLERY = {
  floorY: -4,
  wallZ: -7.5,
  sillY: 5.4,
  headY: 7.2,
  ceilingY: 8.1,
  /** The clerestory glass sits this far behind the wall face. */
  reveal: 0.7,
  /** The far wall behind the default camera; floor and ceiling run to it. */
  frontZ: 30,
  /** The corridor runs x -150..150, so it has hazed into the backing before its ends from any camera in orbit reach. */
  halfLength: 150,
  pierWidth: 1.2,
  /** The shadow-gap skirting and the brass bead above it. */
  skirting: 0.1,
  bead: 0.03,
} as const;

/** The picture light in its own frame (origin on the wall at the lamp height, z out from the wall): a brass can on an arm, its open end aimed down at the bay. */
export const LAMP = {
  canRadius: 0.19,
  canLength: 0.28,
  /** Can centre distance from the wall. */
  reach: 0.45,
  /** Unit direction the open end faces: straight down, so its lens shows from below. */
  aim: [0, -1, 0] as const,
  armRadius: 0.02,
  /** The arm leaves the wall plate this far above the can. */
  armRise: 0.2,
  plate: [0.14, 0.26, 0.04] as const,
} as const;

/** The content volume every part keeps clear of. */
export const CONTENT_BOX = { x: 4, y: 2, zMin: -6, zMax: 9 } as const;

/** Slider bounds the layout and the instance capacities are built for. */
export const BAY_RANGE = { min: 6, max: 14 } as const;
export const PIER_DEPTH_RANGE = { min: 0.2, max: 1.2 } as const;
export const LAMP_HEIGHT_RANGE = { min: 1.5, max: 4.5 } as const;

/** Bays from -n to n fill the corridor, so lamps and piers stop short of its ends. */
function bayReach(pitch: number): number {
  return Math.floor((GALLERY.halfLength - (pitch + GALLERY.pierWidth) / 2) / pitch);
}

/** Bay centres along the hanging wall, ascending x. */
export function bayCentres(pitch: number): number[] {
  const n = bayReach(pitch);
  return Array.from({ length: 2 * n + 1 }, (_, i) => (i - n) * pitch);
}

/** Pier centres: one either side of every bay. */
export function pierCentres(pitch: number): number[] {
  const n = bayReach(pitch);
  return Array.from({ length: 2 * n + 2 }, (_, i) => (i - n - 0.5) * pitch);
}

export const MAX_LAMPS = bayCentres(BAY_RANGE.min).length;
export const MAX_PIERS = pierCentres(BAY_RANGE.min).length;

/** How far the can reaches below and out from its lamp height, from its centre, half length and radius along the aim. */
export function lampExtent(): { below: number; out: number } {
  const [, ay, az] = LAMP.aim;
  const half = LAMP.canLength / 2;
  const across = Math.sqrt(1 - ay * ay);
  return {
    below: half * -ay + LAMP.canRadius * across,
    out: LAMP.reach + half * Math.abs(az) + LAMP.canRadius * Math.sqrt(1 - az * az),
  };
}

/** The clear plaster a bay offers for hanging: between its piers, from the brass bead up to just under its picture light. */
export function bayClearArea(pitch: number, lampHeight: number) {
  return {
    halfWidth: (pitch - GALLERY.pierWidth) / 2,
    bottom: GALLERY.floorY + GALLERY.skirting + GALLERY.bead,
    top: lampHeight - lampExtent().below,
  };
}

/** Passing cloud: three waves travelling along the wall, whole turns per loop so the drift closes exactly (wavelengths in world units). */
export const CLOUD_WAVES = [
  { length: 41, turns: 3 },
  { length: 23, turns: -5 },
  { length: 13, turns: 7 },
] as const;
export const CLOUD_LOOP = 240;

/** Each wave's phase in turns at look time `t`, written into the target without allocating. */
export function writeCloudPhases(
  target: { set(x: number, y: number, z: number): unknown },
  t: number,
): void {
  const u = loopSeconds(t, CLOUD_LOOP) / CLOUD_LOOP;
  const [a, b, c] = CLOUD_WAVES;
  target.set((a.turns * u) % 1, (b.turns * u) % 1, (c.turns * u) % 1);
}

/** Leaf sway in the clerestory: one slow loop, in turns. */
export const SWAY_LOOP = 30;

export function swayPhase(t: number): number {
  return loopSeconds(t, SWAY_LOOP) / SWAY_LOOP;
}
