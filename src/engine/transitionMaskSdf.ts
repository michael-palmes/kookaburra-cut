/** The image-mask transition's signed distance field, built once per mask image at preload: coverage from the image (alpha when any pixel is translucent, else Rec. 709 luma of the stored bytes; 0.5 is the edge), an exact Euclidean distance transform (Felzenszwalb-Huttenlocher, seeded with sub-pixel edge offsets the TinySDF way) on both sides of the edge, normalised to mask units (the field's longest side = 1) and packed as IEEE half floats for an R16F texture. Also the CPU-side reveal schedule the shader reads as uniforms. Pure (no IO, no GPU, no clock), so the field bytes are golden-hashed in tests and part of the export contract. */

/** Longest side of the stored field; a larger image is box-downsampled first. */
export const MASK_FIELD_MAX_SIDE = 1024;

const INF = 1e20;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Per-pixel coverage in 0..1, rows top-down like the source: alpha when any pixel is translucent, else luma (light = inside). */
export function maskCoverage(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  let translucent = false;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 255) {
      translucent = true;
      break;
    }
  }
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = translucent
      ? rgba[o + 3] / 255
      : (0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]) / 255;
  }
  return out;
}

/** Box-downsamples coverage by the smallest integer factor that fits `maxSide`; edge blocks average only the pixels they hold. */
export function fitCoverage(
  coverage: Float32Array,
  width: number,
  height: number,
  maxSide = MASK_FIELD_MAX_SIDE,
): { coverage: Float32Array; width: number; height: number } {
  const k = Math.ceil(Math.max(width, height) / maxSide);
  if (k <= 1) return { coverage, width, height };
  const w = Math.ceil(width / k);
  const h = Math.ceil(height / k);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let sy = y * k; sy < Math.min(height, (y + 1) * k); sy++) {
        for (let sx = x * k; sx < Math.min(width, (x + 1) * k); sx++) {
          sum += coverage[sy * width + sx];
          count++;
        }
      }
      out[y * w + x] = sum / count;
    }
  }
  return { coverage: out, width: w, height: h };
}

/** One 1D pass of the exact squared distance transform over `f` (stride `step` from `offset`), using shared scratch. */
function edt1d(
  grid: Float64Array,
  offset: number,
  step: number,
  n: number,
  f: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  for (let q = 0; q < n; q++) f[q] = grid[offset + q * step];
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  let k = 0;
  for (let q = 1; q < n; q++) {
    let s: number;
    for (;;) {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (2 * (q - r));
      if (s > z[k] || k === 0) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    grid[offset + q * step] = (q - r) * (q - r) + f[r];
  }
}

/** Exact squared Euclidean distance transform in place: each cell becomes min over cells p of |c - p|² + grid[p] (columns, then rows). */
export function edt(grid: Float64Array, width: number, height: number): void {
  const n = Math.max(width, height);
  const f = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
}

/** Signed distance in pixels (negative inside), rows as given; partial-coverage pixels seed both transforms with their sub-pixel offset from the 0.5 edge. */
export function signedDistance(
  coverage: Float32Array,
  width: number,
  height: number,
): Float64Array {
  const n = width * height;
  const outer = new Float64Array(n);
  const inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = coverage[i];
    if (a >= 1) {
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  edt(outer, width, height);
  edt(inner, width, height);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
  return out;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE 754 binary16 bits for `value` (via float32), round to nearest even. */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 112;
  const mant = x & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    const full = mant | 0x800000;
    const shift = 14 - exp;
    let half = full >>> shift;
    const rem = full & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && half & 1)) half++;
    return sign | half;
  }
  let half = (exp << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  return sign | half;
}

/** The float value of binary16 bits. */
export function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >>> 10) & 0x1f;
  const mant = bits & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

/** A mask's field as the shader samples it. */
export interface TransitionMaskField {
  width: number;
  height: number;
  /** Half floats in mask units, row 0 the image's BOTTOM row (GL texture order); positive outside the shape. */
  data: Uint16Array;
  /** The field's half extents in mask units (the longer one is 0.5). */
  half: [number, number];
  /** Minus the field at the centre: the inscribed radius about the anchor, negative when the centre lies outside the shape. */
  inset: number;
}

/** Bilinear sample of the stored field at texel-space (tx, ty), clamped like ClampToEdge. */
function sampleField(field: TransitionMaskField, tx: number, ty: number): number {
  const { width: w, height: h, data } = field;
  const x = clamp(tx, 0, w - 1);
  const y = clamp(ty, 0, h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => fromHalf(data[yy * w + xx]);
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Builds the field for a decoded RGBA image (rows top-down); throws when no pixel reaches the 0.5 edge, since an empty mask can only ever show the outgoing scene. */
export function buildTransitionMaskField(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  maxSide = MASK_FIELD_MAX_SIDE,
): TransitionMaskField {
  if (width < 1 || height < 1) throw new Error("the mask image is empty (0 pixels)");
  const fitted = fitCoverage(maskCoverage(rgba, width, height), width, height, maxSide);
  const { width: w, height: h, coverage } = fitted;
  let inside = false;
  for (let i = 0; i < coverage.length; i++) {
    if (coverage[i] >= 0.5) {
      inside = true;
      break;
    }
  }
  if (!inside) {
    throw new Error(
      "the mask image has no shape: no pixel is at least half opaque (or half bright when it has no transparency)",
    );
  }
  const sd = signedDistance(coverage, w, h);
  const side = Math.max(w, h);
  const data = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) data[y * w + x] = toHalf(clamp(sd[src + x] / side, -2, 2));
  }
  const field: TransitionMaskField = {
    width: w,
    height: h,
    data,
    half: [w / side / 2, h / side / 2],
    inset: 0,
  };
  field.inset = -sampleField(field, w / 2 - 0.5, h / 2 - 0.5);
  return field;
}

/** Share of the final cover the dilation supplies; the rest comes from scale. */
export const MASK_DILATE_SHARE = 0.4;
/** Overshoot past the far corner at progress 1, so the last frames close smoothly. */
export const MASK_MARGIN = 0.04;
/** Inset floor (mask units) for the scale schedule, so a shape with a shallow or outside centre stays a sane size and dilation covers the rest. */
export const MASK_INSET_FLOOR = 0.08;

/** One frame's reveal uniforms, all in frame-height units. */
export interface MaskReveal {
  /** Mask longest side on screen. */
  scale: number;
  /** Outward dilation of the scaled shape. */
  dilate: number;
  /** One output pixel (the edge's antialiasing width). */
  pixel: number;
}

/** The reveal schedule: scale grows linearly and dilation cubically from 0, and at progress 1 the bound `field(u) <= |u| - inset` (the shader's min) puts every frame pixel at least a pixel inside the shape, so the cover completes before the seam. */
export function maskReveal(
  progress: number,
  aspect: number,
  center: [number, number],
  heightPx: number,
  inset: number,
): MaskReveal {
  const pixel = 1 / Math.max(1, heightPx);
  const corner = Math.hypot(
    Math.max(center[0], 1 - center[0]) * aspect,
    Math.max(center[1], 1 - center[1]),
  );
  const target = corner * (1 + MASK_MARGIN) + pixel;
  const scaleMax = ((1 - MASK_DILATE_SHARE) * target) / Math.max(inset, MASK_INSET_FLOOR);
  const dilateMax = target - scaleMax * inset;
  const e = clamp(progress, 0, 1);
  return { scale: scaleMax * e, dilate: dilateMax * e * e * e, pixel };
}
