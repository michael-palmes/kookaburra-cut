/** Floor height; the drum stands from here to DRUM_TOP, where the dome springs. */
export const ROTUNDA_FLOOR_Y = -2;
export const DRUM_TOP = 20;
export const OCULUS_RADIUS = 4;
/** Bay width the drum's pilasters and niches are drawn at: 28 bays round the sketch's 22-unit drum. */
export const DRUM_BAY = (2 * Math.PI * 22) / 28;
/** The sun disc's lowest edge never drops below this height, so it stays above the headline band. */
export const DISC_FLOOR_Y = 8;
/** Elevation swing below the max: the sketch's 32 to 52 degrees. */
export const ELEVATION_SWING = 20;
export const AZIMUTH_SWING = 80;
/** The disc's soft edge reaches this multiple of its size. */
export const DISC_EDGE = 1.2;

const DEG = Math.PI / 180;

export function oculusHeight(radius: number): number {
  return DRUM_TOP + radius;
}

/** Whole bays round the drum, kept even so niches alternate across the seam. */
export function drumBays(radius: number): number {
  return Math.max(8, 2 * Math.round((Math.PI * radius) / DRUM_BAY));
}

/** Lowest point of the disc's soft edge when the beam leaves the oculus at `elevationDeg`: the beam meets the drum wall `radius` out, and its round cross-section stretches by 1 / cos(elevation) down the wall. */
export function discLowestY(radius: number, discSize: number, elevationDeg: number): number {
  const e = elevationDeg * DEG;
  return oculusHeight(radius) - radius * Math.tan(e) - (discSize * DISC_EDGE) / Math.cos(e);
}

/** The max elevation actually used: the slider value, lowered where a steep beam would set the disc's edge below DISC_FLOOR_Y. */
export function cappedMaxElevation(radius: number, discSize: number, maxElevation: number): number {
  if (discLowestY(radius, discSize, maxElevation) >= DISC_FLOOR_Y) return maxElevation;
  let lo = ELEVATION_SWING;
  let hi = maxElevation;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (discLowestY(radius, discSize, mid) >= DISC_FLOOR_Y) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The sun's azimuth at look time `t` (v9 orbit convention: 0 is +z, in front of the stage, so the beam falls on the back wall), swinging once per `2 * traverse` seconds. Callers wrap `t` to that loop. */
export function rotundaSunAzimuth(t: number, traverse: number): number {
  return -AZIMUTH_SWING * Math.sin((Math.PI * t) / traverse);
}

/** The sun's elevation at look time `t`: highest (the disc lowest) each time it crosses the back, every `traverse` seconds. */
export function rotundaSunElevation(t: number, traverse: number, maxElevation: number): number {
  const half = ELEVATION_SWING / 2;
  return maxElevation - half + half * Math.cos((2 * Math.PI * t) / traverse);
}

/** Writes the beam's travel direction (oculus toward the disc, the negated sun direction) without allocating. */
export function writeRotundaBeam(
  target: { set(x: number, y: number, z: number): unknown },
  azimuthDeg: number,
  elevationDeg: number,
): void {
  const a = azimuthDeg * DEG;
  const e = elevationDeg * DEG;
  target.set(-Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e));
}
