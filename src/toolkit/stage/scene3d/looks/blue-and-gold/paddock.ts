import { createSeededRandom } from "../../../../../engine/rng";
import { smoothstep } from "../../kit/math";
import { orderSplatsFarToNear, type StrokeSplat } from "../../kit/strokeSplats";

/** Blue and gold layout: the daub field, the ridge and the painter's sun. Placements are EXPORT CONTRACT (one seeded stream, fixed draw order). */

export const RIDGE_RADIUS = 60;

/** Daubs fill an annulus at ground level; `pool` covers the densest slider value and the shader thins by rank. */
export const DAUB_FIELD = {
  inner: 6.5,
  outer: 42,
  count: 14000,
  maxDensity: 1.5,
  y: -1.98,
  seed: 0x9e1d,
} as const;

/** The painter's sun as an orbit (v9 convention): upper left of the default view, a little in front of the stage. */
export const PAINTER_SUN_ORBIT = { azimuthDeg: -48, elevationDeg: 48 } as const;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const az = (PAINTER_SUN_ORBIT.azimuthDeg * Math.PI) / 180;
const el = (PAINTER_SUN_ORBIT.elevationDeg * Math.PI) / 180;

/** Unit direction toward the painter's sun, rounded so the GLSL literal is stable. */
export const PAINTER_SUN: readonly [number, number, number] = [
  round4(Math.cos(el) * Math.sin(az)),
  round4(Math.sin(el)),
  round4(Math.cos(el) * Math.cos(az)),
];

/** The daub pool in draw order: area-uniform radii thinned toward the clearing edge and the far field, low tilts (8 to 18 degrees) leaning either way, mostly across the view, 30% straw. */
export function placeDaubs(): StrokeSplat[] {
  const { inner, outer, count, maxDensity, y, seed } = DAUB_FIELD;
  const pool = Math.round(count * maxDensity);
  const rand = createSeededRandom(seed);
  const out: StrokeSplat[] = [];
  for (let guard = 0; out.length < pool && guard < pool * 8; guard++) {
    const r = Math.sqrt(inner * inner + rand() * (outer * outer - inner * inner));
    const keep =
      (0.3 + 0.7 * (1 - smoothstep(12, outer, r))) * smoothstep(inner, inner + 3, r) * 0.85 +
      0.15 * smoothstep(inner, inner + 1.5, r);
    if (rand() > keep) continue;
    const a = rand() * Math.PI * 2;
    const length = (0.8 + rand() * 0.5) * (1 + r / 30);
    const width = length * (0.36 + rand() * 0.1);
    const yaw = rand() < 0.85 ? (rand() - 0.5) * 0.7 : rand() * Math.PI;
    const tilt = 0.14 + rand() * 0.18;
    const lean = rand() < 0.5 ? -1 : 1;
    const shape = Math.floor(rand() * 4);
    const tone = rand() < 0.3 ? 1 : 0;
    out.push({
      id: out.length,
      x: Math.cos(a) * r,
      y,
      z: Math.sin(a) * r,
      yaw,
      tilt: tilt * lean,
      length,
      width,
      shape,
      tone,
      rank: rand(),
    });
  }
  return orderSplatsFarToNear(out);
}
