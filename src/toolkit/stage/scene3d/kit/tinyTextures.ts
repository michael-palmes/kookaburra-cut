import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
} from "three";

/** Tiny textures (F8): small byte images built synchronously (embedded bytes or seeded maths, never a fetch, DOM or canvas), uploaded as repeat-wrapped data textures with JS box-filtered mips, since GPU mip generation is driver-defined. Data is raw (no colour space): sample it as tone, not colour. */

/** A raw image: `channels` bytes per pixel, rows bottom to top as uploaded (no flip). */
export interface TinyImage {
  width: number;
  height: number;
  channels: 1 | 4;
  data: Uint8Array;
}

/** One mip level (the shape three uploads for DataTexture mipmaps). */
export interface TinyMip {
  width: number;
  height: number;
  data: Uint8Array;
}

const isPowerOfTwo = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

/** Decodes base64-embedded bytes (vendor-time image decodes, like shaders/noiseTexture.ts). */
export function decodeTinyBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The full mip chain, level 0 first, down to 1x1: each texel is the rounded mean of its 2x2 (or 2x1) parent block in integer maths, so every run and driver uploads the same bytes. Power-of-two sizes only. */
export function tinyMipChain(image: TinyImage): TinyMip[] {
  const { width, height, channels, data } = image;
  if (!isPowerOfTwo(width) || !isPowerOfTwo(height))
    throw new Error(`[scene3d kit] tiny texture must be power-of-two, got ${width}x${height}`);
  if (data.length !== width * height * channels)
    throw new Error(
      `[scene3d kit] tiny texture has ${data.length} bytes, expected ${width * height * channels}`,
    );
  const chain: TinyMip[] = [{ width, height, data }];
  let src = chain[0];
  while (src.width > 1 || src.height > 1) {
    const w = Math.max(1, src.width >> 1);
    const h = Math.max(1, src.height >> 1);
    const sx = src.width > 1 ? 2 : 1;
    const sy = src.height > 1 ? 2 : 1;
    const count = sx * sy;
    const out = new Uint8Array(w * h * channels);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < channels; c++) {
          let sum = 0;
          for (let j = 0; j < sy; j++) {
            for (let i = 0; i < sx; i++) {
              sum += src.data[((y * sy + j) * src.width + (x * sx + i)) * channels + c];
            }
          }
          out[(y * w + x) * channels + c] = Math.floor((sum + (count >> 1)) / count);
        }
      }
    }
    src = { width: w, height: h, data: out };
    chain.push(src);
  }
  return chain;
}

/** A repeat-wrapped, trilinear-filtered data texture carrying the JS mip chain. Shared textures are never disposed (like the shader noise texture). */
export function createTinyTexture(image: TinyImage): DataTexture {
  const mips = tinyMipChain(image);
  const format = image.channels === 1 ? RedFormat : RGBAFormat;
  const texture = new DataTexture(image.data, image.width, image.height, format, UnsignedByteType);
  texture.mipmaps = mips;
  texture.generateMipmaps = false;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

const cache = new Map<string, DataTexture>();

/** A shared tiny texture built on first use and cached by `key` for the run. */
export function tinyTexture(key: string, build: () => TinyImage): DataTexture {
  let texture = cache.get(key);
  if (!texture) {
    texture = createTinyTexture(build());
    cache.set(key, texture);
  }
  return texture;
}

/** The kit's GLSL `kkHash` in JS (integer maths, [0, 1) in 24-bit steps), for seeded texture and schedule generation. */
export function tinyHash(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2246822519)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177) >>> 0;
  h ^= h >>> 16;
  return (h & 0x00ffffff) / 16777216;
}

/** Value noise on a lattice that wraps every `px` by `py` cells (tileable), at a point in cell units. */
export function periodicNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const wrap = (v: number, p: number) => ((v % p) + p) % p;
  const x0 = wrap(ix, px);
  const x1 = wrap(ix + 1, px);
  const y0 = wrap(iy, py);
  const y1 = wrap(iy + 1, py);
  const a = tinyHash(x0, y0, seed);
  const b = tinyHash(x1, y0, seed);
  const c = tinyHash(x0, y1, seed);
  const d = tinyHash(x1, y1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Octaves as [cells across x, cells across y, weight]; the lattice divides the tile, so the sum tiles. */
type Octaves = readonly (readonly [number, number, number])[];

function tileableField(size: number, octaves: Octaves, seed: number): Float64Array {
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (let o = 0; o < octaves.length; o++) {
        const [cx, cy, weight] = octaves[o];
        v +=
          weight *
          periodicNoise(((x + 0.5) * cx) / size, ((y + 0.5) * cy) / size, cx, cy, seed + o);
      }
      out[y * size + x] = v;
    }
  }
  return out;
}

/** Rescales a field to mean 0.5 and a fixed mean absolute deviation (no sqrt, so every engine rounds alike), written as bytes into one channel. */
function writeNormalised(
  field: Float64Array,
  out: Uint8Array,
  channel: number,
  spread: number,
): void {
  const n = field.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += field[i];
  mean /= n;
  let mad = 0;
  for (let i = 0; i < n; i++) mad += Math.abs(field[i] - mean);
  mad = Math.max(mad / n, 1e-9);
  for (let i = 0; i < n; i++) {
    const v = 0.5 + ((field[i] - mean) * spread) / mad;
    out[i * 4 + channel] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
}

export const PAPER_GRAIN_SIZE = 128;
export const PAPER_GRAIN_SEED = 0x9a9e;

/** Watercolour paper, tileable RGBA: r tooth (2 to 8 texel pits), g fibres (long streaks), b mottle (broad cloudiness), a a second tooth decorrelated from r. Every channel has mean 0.5. */
export function paperGrainImage(
  size: number = PAPER_GRAIN_SIZE,
  seed: number = PAPER_GRAIN_SEED,
): TinyImage {
  if (!isPowerOfTwo(size) || size < 16)
    throw new Error(`[scene3d kit] paper grain size must be a power of two >= 16, got ${size}`);
  const data = new Uint8Array(size * size * 4);
  const tooth: Octaves = [
    [size / 2, size / 2, 0.5],
    [size / 4, size / 4, 0.32],
    [size / 16, size / 16, 0.18],
  ];
  const fibre: Octaves = [
    [4, size / 2, 0.45],
    [size / 2, 4, 0.2],
    [8, size / 4, 0.35],
  ];
  const mottle: Octaves = [
    [4, 4, 0.55],
    [8, 8, 0.3],
    [16, 16, 0.15],
  ];
  writeNormalised(tileableField(size, tooth, seed), data, 0, 0.16);
  writeNormalised(tileableField(size, fibre, seed + 101), data, 1, 0.16);
  writeNormalised(tileableField(size, mottle, seed + 211), data, 2, 0.16);
  writeNormalised(tileableField(size, tooth, seed + 307), data, 3, 0.16);
  return { width: size, height: size, channels: 4, data };
}

/** The shared 128 px paper grain texture (built on first use). */
export function getPaperGrainTexture(): DataTexture {
  return tinyTexture("paper-grain", () => paperGrainImage());
}
