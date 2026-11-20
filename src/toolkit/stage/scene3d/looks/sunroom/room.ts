import { loopSeconds } from "../../kit/clock";
import { goboSunDirection } from "../../kit/gobo";

/** Sunroom layout: a plaster room round the stage (back wall, two side walls, floor, open front and top) lit through a virtual venetian blind. The blind is a window plane far sunward of the room, sized from the frame the default camera sees at the back wall, so its light lands as one projection: a patch on the wall that runs on across the floor toward the sun. */

type Vec3 = [number, number, number];

/** Just under the content floor (y -2), so a device standing at -2 keeps its contact shadow, which hangs 0.02 under its base. */
export const SUNROOM_FLOOR_Y = -2.05;
export const SUNROOM_WALL_HEIGHT = 16;
/** Side walls and floor run this far forward of the stage. */
export const SUNROOM_FRONT_Z = 16;
/** Seconds per full sun sway at speed 1. */
export const SUNROOM_DAY_S = 120;
/** How far sunward of the wall patch the blind sits: past every floor point a camera near the stage sees, so the floor in front of the stage catches the light too. */
export const SUNROOM_THROW = 40;
/** The penumbra reads as if the blind hung this far from the wall patch. */
export const SUNROOM_PENUMBRA_REACH = 12;
/** Elevation swing per degree of azimuth drift: the sun sinks as it swings, so the pool slides on a diagonal. */
const DRIFT_SINK = 0.3;

const DEFAULT_CAMERA_Z = 5;
const HALF_FOV_TAN = Math.tan((22.5 * Math.PI) / 180);
/** Widest export aspect: side walls clear its view. */
const WIDE_ASPECT = 16 / 9;
const DEG = Math.PI / 180;

export interface SunroomSunPath {
  azimuthDeg: number;
  elevationDeg: number;
  driftDeg: number;
  periodS: number;
}

/** The sun at look time `t`: azimuth swings `driftDeg` either side of the mean and the elevation sinks with it, wrapped per period so long projects stay exact. */
export function sunroomSunAngles(path: SunroomSunPath, t: number): [number, number] {
  if (path.driftDeg === 0 || !(path.periodS > 0)) return [path.azimuthDeg, path.elevationDeg];
  const swing = Math.sin((2 * Math.PI * loopSeconds(t, path.periodS)) / path.periodS);
  return [
    path.azimuthDeg + path.driftDeg * swing,
    path.elevationDeg - DRIFT_SINK * path.driftDeg * swing,
  ];
}

/** Writes the unit vector toward the sun at look time `t` without allocating. */
export function writeSunroomSun(
  target: { set(x: number, y: number, z: number): unknown },
  path: SunroomSunPath,
  t: number,
): void {
  const [az, el] = sunroomSunAngles(path, t);
  const a = az * DEG;
  const e = el * DEG;
  target.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

export interface SunroomRoom {
  /** Back wall plane at z = -wallZ. */
  wallZ: number;
  /** Side walls at x = +-sideX. */
  sideX: number;
}

/** The room for a wall distance: side walls just outside the default camera's view of the back wall. */
export function sunroomRoom(wallDistance: number): SunroomRoom {
  const reach = wallDistance + DEFAULT_CAMERA_Z;
  return { wallZ: wallDistance, sideX: HALF_FOV_TAN * WIDE_ASPECT * reach + 3 };
}

export interface SunroomWindowParams {
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  wallDistance: number;
  /** Patch centre across the back wall, -1 (left frame edge) to 1 (right). */
  patch: number;
  /** Frame width over height; the patch scales with the frame. */
  aspect?: number;
}

/** The blind: a rectangle in its own plane (centre, horizontal axis `u`, normal, half extents), with slats along `u`. */
export interface SunroomWindow {
  centre: Vec3;
  u: Vec3;
  normal: Vec3;
  halfWidth: number;
  halfHeight: number;
}

/** Places the blind so the mean sun lays its light on the back wall as a patch about two thirds of the frame wide, from near the top of the default frame down past the floor, the part below the floor line landing on the floor toward the sun. The blind turns half way toward the sun, so its slats land as gently sloped bars on the wall and diagonals on the floor. */
export function sunroomWindow(p: SunroomWindowParams): SunroomWindow {
  const { wallZ } = sunroomRoom(p.wallDistance);
  const reach = p.wallDistance + DEFAULT_CAMERA_Z;
  const halfFrame = HALF_FOV_TAN * (p.aspect ?? WIDE_ASPECT) * reach;
  const frameTop = HALF_FOV_TAN * reach;
  const az = p.sunAzimuthDeg * DEG;
  const el = p.sunElevationDeg * DEG;
  const sun = goboSunDirection(p.sunAzimuthDeg, p.sunElevationDeg);
  const yaw = -0.5 * az;
  const u: Vec3 = [Math.cos(yaw), 0, Math.sin(yaw)];
  const normal: Vec3 = [-Math.sin(yaw), 0, Math.cos(yaw)];
  // A unit along u lands this wide on the wall plane.
  const stretch = Math.cos(yaw) - Math.tan(az) * Math.sin(yaw);
  const patchWidth = 1.3 * halfFrame;
  const top = SUNROOM_FLOOR_Y + 0.9 * (frameTop - SUNROOM_FLOOR_Y);
  const floorReach = Math.min((wallZ + 6) / Math.max(Math.cos(az), 0.35), 24);
  const bottom = SUNROOM_FLOOR_Y - floorReach * Math.tan(el);
  const anchor: Vec3 = [p.patch * halfFrame, (top + bottom) / 2, -wallZ];
  return {
    centre: [
      anchor[0] + SUNROOM_THROW * sun[0],
      anchor[1] + SUNROOM_THROW * sun[1],
      anchor[2] + SUNROOM_THROW * sun[2],
    ],
    u,
    normal,
    halfWidth: patchWidth / 2 / stretch,
    halfHeight: (top - bottom) / 2,
  };
}

/** Where a receiver's sun ray crosses the blind's plane, in blind coordinates (along `u`, up), and how far it travelled; null when it runs parallel or away. Mirrors the shader's trace. */
export function traceSunroomWindow(
  p: Readonly<Vec3>,
  sun: Readonly<Vec3>,
  w: SunroomWindow,
): { u: number; v: number; dist: number } | null {
  const d = sun[0] * w.normal[0] + sun[1] * w.normal[1] + sun[2] * w.normal[2];
  if (Math.abs(d) <= 1e-5) return null;
  const s =
    ((w.centre[0] - p[0]) * w.normal[0] +
      (w.centre[1] - p[1]) * w.normal[1] +
      (w.centre[2] - p[2]) * w.normal[2]) /
    d;
  if (s < 0) return null;
  const q = [
    p[0] + s * sun[0] - w.centre[0],
    p[1] + s * sun[1] - w.centre[1],
    p[2] + s * sun[2] - w.centre[2],
  ];
  return { u: q[0] * w.u[0] + q[2] * w.u[2], v: q[1], dist: s };
}

/** Mirrors GLSL `srSlatG`: the second integral of the slat field, an open gap of width `g` centred in each unit pitch. */
function slatIntegral(x: number, g: number): number {
  const n = Math.floor(x);
  const f = x - n;
  const a = 0.5 - 0.5 * g;
  const r = Math.min(Math.max(f - a, 0), g);
  const cf = 0.5 * r * r + g * Math.max(f - a - g, 0);
  return 0.5 * g * n * (n - 1) + n * (0.5 * g * g + a * g) + n * g * f + cf;
}

/** Mirrors GLSL `srSlats`: slat light at `x` pitches, tent-filtered over half width `h` pitches. */
export function sunroomSlats(x: number, h: number, g: number): number {
  const xl = x - Math.floor(x);
  const hh = Math.max(h, 0.01);
  const v =
    (slatIntegral(xl + hh, g) - 2 * slatIntegral(xl, g) + slatIntegral(xl - hh, g)) / (hh * hh);
  return Math.min(Math.max(v, 0), 1);
}
