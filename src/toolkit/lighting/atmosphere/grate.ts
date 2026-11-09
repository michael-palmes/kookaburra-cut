import { ClampToEdgeWrapping, DataTexture, LinearFilter, NoColorSpace, RGBAFormat } from "three";
import { createSeededRandom } from "../../../engine/rng";

type V3 = [number, number, number];
type Range = [number, number];

/** Bars running parallel to the line from the light to the lens, so every shadow plane holds the lens: each camera ray stays inside one shaft and the rays fan crisply from the source. A flat gobo across the beam only reads edge on near its axis. */
export interface GrateSpec {
  /** The point every shadow plane passes through: the camera's position. */
  lens: V3;
  /** How far the row of bars sits off the lens line, towards the aim. */
  offset: number;
  /** The bars' span along the lens line, from the light. */
  along: Range;
  /** The row's width across. */
  width: number;
  /** Each bar's width is picked in this range. */
  slat: Range;
  gap: Range;
  /** Now and then a wider gap, with probability `p`. */
  wideGap?: { p: number; range: Range };
  seed: number;
  /** Explicit bars across the row, in place of the seeded layout: place the rays by hand. */
  bars?: Range[];
  /** The light's radius: each bar's shadow edge blurs across this much of the row, as a real source's does. */
  soft?: number;
}

/** The spot's pose, matching its shadow camera: the cookie is sampled through the light's shadow matrix. */
export interface SpotFrame {
  position: V3;
  target: V3;
  /** Half the cone, radians. */
  halfAngle: number;
}

/** Raster size: export contract once shipped. Large, because the bars converge on the lens. */
export const GRATE_SIZE = 2048;
const MAX_BARS = 4096;
const MIN_STEP = 1e-4;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The bars across the row as sorted [start, end] intervals, a pure function of the spec. */
export function grateBars(spec: GrateSpec): Range[] {
  const rand = createSeededRandom(spec.seed);
  const pick = ([a, b]: Range) => Math.max(MIN_STEP, a + (b - a) * rand());
  const half = spec.width / 2;
  const bars: Range[] = [];
  let x = -half + rand() * Math.max(0, spec.gap[1]);
  while (x < half && bars.length < MAX_BARS) {
    const end = Math.min(x + pick(spec.slat), half);
    bars.push([x, end]);
    const wide = spec.wideGap && rand() < spec.wideGap.p;
    x = end + (wide && spec.wideGap ? pick(spec.wideGap.range) : pick(spec.gap));
  }
  return bars;
}

/** How much of [a, b] the bars cover. */
function covered(bars: Range[], a: number, b: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (bars[m][1] <= a) lo = m + 1;
    else hi = m;
  }
  let sum = 0;
  for (let i = lo; i < bars.length && bars[i][0] < b; i++) {
    sum += Math.min(b, bars[i][1]) - Math.max(a, bars[i][0]);
  }
  return sum;
}

/** three's lookAt basis for a camera at `eye` facing `target` with world up, as the light's shadow camera builds it. */
function shadowBasis(eye: V3, target: V3) {
  let z = sub(eye, target);
  if (dot(z, z) === 0) z = [0, 0, 1];
  z = norm(z);
  let x = cross([0, 1, 0], z);
  if (dot(x, x) === 0) {
    z = norm([z[0], z[1], z[2] + 0.0001]);
    x = cross([0, 1, 0], z);
  }
  x = norm(x);
  return { x, y: cross(z, x), z };
}

/** Where a ray leaving the light along `d` crosses the row of bars (a position across it), or NaN when it passes beside them. Constant over each plane through the lens line, which is the whole point. */
export function grateCrossing(spec: GrateSpec, frame: SpotFrame): (d: V3) => number {
  const u = norm(sub(spec.lens, frame.position));
  const aim = norm(sub(frame.target, frame.position));
  const w = norm(sub(aim, [u[0] * dot(aim, u), u[1] * dot(aim, u), u[2] * dot(aim, u)]));
  const v = cross(u, w);
  const [t0, t1] = spec.along;
  return (d) => {
    const dw = dot(d, w);
    if (dw <= 1e-9) return Number.NaN;
    const s = spec.offset / dw;
    const t = s * dot(d, u);
    if (t < t0 || t > t1) return Number.NaN;
    return s * dot(d, v);
  };
}

/** RGBA8 rows, bottom row first, in the light's shadow-camera view: what the light passes through the bars. */
export function rasterGrate(spec: GrateSpec, frame: SpotFrame, size = GRATE_SIZE): Uint8Array {
  const bars = spec.bars ? [...spec.bars].sort((a, b) => a[0] - b[0]) : grateBars(spec);
  const soft = 2 * Math.max(0, spec.soft ?? 0);
  const crossing = grateCrossing(spec, frame);
  const cam = shadowBasis(frame.position, frame.target);
  const tanH = Math.tan(frame.halfAngle);
  const half = spec.width / 2;

  const across = (sx: number, sy: number) => {
    const vx = (2 * sx - 1) * tanH;
    const vy = (2 * sy - 1) * tanH;
    return crossing([
      cam.x[0] * vx + cam.y[0] * vy - cam.z[0],
      cam.x[1] * vx + cam.y[1] * vy - cam.z[1],
      cam.x[2] * vx + cam.y[2] * vy - cam.z[2],
    ]);
  };

  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = across((i + 0.5) / size, (j + 0.5) / size);
      let lit = 1;
      if (!Number.isNaN(x)) {
        const xs = across((i + 1.5) / size, (j + 0.5) / size);
        const xt = across((i + 0.5) / size, (j + 1.5) / size);
        const fw = Math.max(
          1e-9,
          soft +
            (Number.isNaN(xs) ? 0 : Math.abs(xs - x)) +
            (Number.isNaN(xt) ? 0 : Math.abs(xt - x)),
        );
        if (x + fw / 2 > -half && x - fw / 2 < half) {
          lit = 1 - Math.min(1, covered(bars, x - fw / 2, x + fw / 2) / fw);
        }
      }
      const value = Math.round(lit * 255);
      const k = (j * size + i) * 4;
      out[k] = value;
      out[k + 1] = value;
      out[k + 2] = value;
      out[k + 3] = 255;
    }
  }
  return out;
}

const cache = new Map<string, DataTexture>();

/** One cookie per grate and pose, shared by the light (surface pools) and the beam (the shafts in the air). */
export function grateTexture(spec: GrateSpec, frame: SpotFrame, size = GRATE_SIZE): DataTexture {
  const key = JSON.stringify([spec, frame, size]);
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = createGrateTexture(spec, frame, size);
  cache.set(key, tex);
  return tex;
}

/** An uncached cookie the caller owns and disposes: an edited light bakes a new one per change. */
export function createGrateTexture(
  spec: GrateSpec,
  frame: SpotFrame,
  size = GRATE_SIZE,
): DataTexture {
  const tex = new DataTexture(rasterGrate(spec, frame, size), size, size, RGBAFormat);
  tex.colorSpace = NoColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
