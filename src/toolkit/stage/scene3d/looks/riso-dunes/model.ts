import { BufferAttribute, BufferGeometry, type Vector3 } from "three";
import { loopSeconds } from "../../kit/clock";
import { lookLuminance } from "../../kit/material";
import { RIPPLE_WAVELENGTH, SMALL_SPACING } from "./shaders";

/** The sun's swing period, seconds of look time. */
export const RISO_SUN_PERIOD = 48;
/** Light stock inks the shade, so its sun sits upwind; dark stock inks the light, so its sun sits downwind: either way the camera-facing slopes carry the ink. */
export const RISO_SUN_AZIMUTH = { light: 226, dark: 46 } as const;
export const RISO_SUN_ELEVATION_DEG = 22;
const SUN_ELEVATION = (RISO_SUN_ELEVATION_DEG * Math.PI) / 180;
/** The floor's polar grid: rings, segments, outer radius and the ring-bunching power. */
export const RISO_GRID = { rings: 200, segments: 448, radius: 112, power: 1.45 } as const;
const SMALL_DRIFT = 1.4;
const RIPPLE_DRIFT = 0.5;

/** A flat polar grid on y = 0 whose rings bunch toward the centre (`power` > 1), so a displaced floor spends its vertices where the dunes are near. */
export function polarGrid(rings: number, segments: number, radius: number, power: number) {
  const stride = segments + 1;
  const position = new Float32Array((rings + 1) * stride * 3);
  let k = 0;
  for (let i = 0; i <= rings; i++) {
    const r = radius * (i / rings) ** power;
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      position[k++] = Math.cos(a) * r;
      position[k++] = 0;
      position[k++] = Math.sin(a) * r;
    }
  }
  const index = new Uint32Array(rings * segments * 6);
  k = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j;
      const b = a + stride;
      index.set([a, a + 1, b, a + 1, b + 1, b], k);
      k += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

/** Rings of the bare clearing: every ring inside the radius where neither plate can meet a dune (the clearing less half the misregistration and a margin), so the cheap clearing material prints it with the dune material's exact pixels. */
export function risoClearingRings(clearRadius: number, misregister: number): number {
  const bare = clearRadius - 0.5 - Math.max(0, misregister) / 2 - 0.1;
  if (bare <= 0) return 0;
  const { rings, radius, power } = RISO_GRID;
  return Math.min(rings, Math.floor(rings * (bare / radius) ** (1 / power)));
}

/** Dark stock (paper darker than the key ink) prints the lit slopes; light stock prints the shade. Read from the colours, so Theme-derived palettes keep their polarity. */
export function isDarkStock(keyHex: string, paperHex: string): boolean {
  return lookLuminance(paperHex) < lookLuminance(keyHex);
}

/** The dune, small-dune and ripple phases in [0, 1) at look time `t`: each band slides downwind at its own speed and wraps exactly on the CPU, so shader floats stay small on long projects. */
export function risoPhases(t: number, drift: number, spacing: number) {
  return {
    big: loopSeconds((t * drift) / spacing, 1),
    small: loopSeconds((t * drift * SMALL_DRIFT) / (spacing * SMALL_SPACING), 1),
    ripple: loopSeconds((t * drift * RIPPLE_DRIFT) / RIPPLE_WAVELENGTH, 1),
  };
}

/** The virtual sun's direction at look time `t`: 22 degrees up, swinging `swingDeg` either side of the stock's azimuth over 48 s. */
export function risoSun(t: number, swingDeg: number, dark: boolean, out: Vector3): Vector3 {
  const swing = Math.sin((2 * Math.PI * loopSeconds(t, RISO_SUN_PERIOD)) / RISO_SUN_PERIOD);
  const az =
    ((dark ? RISO_SUN_AZIMUTH.dark : RISO_SUN_AZIMUTH.light) + swingDeg * swing) * (Math.PI / 180);
  return out.set(
    Math.cos(SUN_ELEVATION) * Math.sin(az),
    Math.sin(SUN_ELEVATION),
    Math.cos(SUN_ELEVATION) * Math.cos(az),
  );
}
