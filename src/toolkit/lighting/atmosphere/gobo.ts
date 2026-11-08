import { ClampToEdgeWrapping, DataTexture, LinearFilter, NoColorSpace, RGBAFormat } from "three";
import { createSeededRandom } from "../../../engine/rng";

/** A procedural light cookie: what the light passes through on its way in. */
export type GoboPattern = "slats" | "blinds" | "window" | "dapple";

export interface GoboSpec {
  pattern: GoboPattern;
  /** Bars (slats, blinds), panes across (window) or blobs across (dapple). */
  count: number;
  /** Lit fraction of each period, 0..1. */
  duty: number;
  /** Edge width as a fraction of one period. */
  softness: number;
  /** Rotation of the pattern in the light's view, degrees. */
  angleDeg: number;
  seed: number;
}

export const GOBO_DEFAULTS: GoboSpec = {
  pattern: "slats",
  count: 9,
  duty: 0.45,
  softness: 0.18,
  angleDeg: 0,
  seed: 1,
};

/** Raster size: export contract once shipped. */
export const GOBO_SIZE = 512;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Lit intervals across one axis in [0, 1]: seeded widths and gaps around an even period. */
function slatIntervals(spec: GoboSpec, regular: boolean): [number, number][] {
  const rand = createSeededRandom(spec.seed);
  const n = Math.max(1, Math.round(spec.count));
  const period = 1 / n;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const jitter = regular ? 0 : (rand() - 0.5) * 0.5;
    const duty = regular ? spec.duty : Math.min(0.9, Math.max(0.12, spec.duty * (0.55 + rand())));
    const centre = (i + 0.5 + jitter) * period;
    out.push([centre - (duty * period) / 2, centre + (duty * period) / 2]);
  }
  return out;
}

function bandValue(s: number, intervals: [number, number][], edge: number): number {
  let v = 0;
  for (const [a, b] of intervals)
    v += smooth(a - edge, a + edge, s) - smooth(b - edge, b + edge, s);
  return Math.min(1, Math.max(0, v));
}

function valueNoise(rand: () => number, cells: number): (x: number, y: number) => number {
  const grid = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return (x, y) => {
    const gx = x * cells;
    const gy = y * cells;
    const ix = Math.min(cells - 1, Math.floor(gx));
    const iy = Math.min(cells - 1, Math.floor(gy));
    const fx = gx - ix;
    const fy = gy - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const at = (cx: number, cy: number) => grid[cy * (cells + 1) + cx];
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * ux;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * ux;
    return top + (bottom - top) * uy;
  };
}

/** The cookie's transmission at uv (0..1 across the light's view), a pure function of the spec. */
export function goboSampler(spec: GoboSpec): (u: number, v: number) => number {
  const a = (spec.angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const rotate = (u: number, v: number): [number, number] => {
    const x = u - 0.5;
    const y = v - 0.5;
    return [0.5 + x * ca - y * sa, 0.5 + x * sa + y * ca];
  };
  const n = Math.max(1, Math.round(spec.count));
  const edge = Math.max(1e-4, (spec.softness / n) * 0.5);
  switch (spec.pattern) {
    case "slats":
    case "blinds": {
      const intervals = slatIntervals(spec, spec.pattern === "blinds");
      return (u, v) => bandValue(rotate(u, v)[0], intervals, edge);
    }
    case "window": {
      const rows = Math.max(1, Math.round(n * 1.5));
      const mullion = (1 - spec.duty) / 2;
      return (u, v) => {
        const [x, y] = rotate(u, v);
        const fx = (x * n) % 1;
        const fy = (y * rows) % 1;
        const frame = smooth(0.08 - edge, 0.08 + edge, x) * smooth(0.08 - edge, 0.08 + edge, 1 - x);
        const across = smooth(mullion - edge * n, mullion + edge * n, Math.min(fx, 1 - fx));
        const down = smooth(mullion - edge * rows, mullion + edge * rows, Math.min(fy, 1 - fy));
        return frame * across * down;
      };
    }
    case "dapple": {
      const rand = createSeededRandom(spec.seed);
      const coarse = valueNoise(rand, n);
      const fine = valueNoise(rand, n * 3);
      const threshold = 1 - spec.duty;
      const width = Math.max(0.01, spec.softness * 0.5);
      return (u, v) => {
        const [x, y] = rotate(u, v);
        const f = 0.7 * coarse(x, y) + 0.3 * fine(x, y);
        return smooth(threshold - width, threshold + width, f);
      };
    }
  }
}

/** RGBA8 rows, bottom row first (texture v up). */
export function rasterGobo(spec: GoboSpec, size = GOBO_SIZE): Uint8Array {
  const sample = goboSampler(spec);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = Math.round(sample((x + 0.5) / size, (y + 0.5) / size) * 255);
      const i = (y * size + x) * 4;
      out[i] = value;
      out[i + 1] = value;
      out[i + 2] = value;
      out[i + 3] = 255;
    }
  }
  return out;
}

const cache = new Map<string, DataTexture>();

/** One texture per spec, shared by the light (surface pools) and the beam (the shafts in the air). */
export function goboTexture(spec: GoboSpec): DataTexture {
  const key = JSON.stringify(spec);
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = new DataTexture(rasterGobo(spec), GOBO_SIZE, GOBO_SIZE, RGBAFormat);
  tex.colorSpace = NoColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}
