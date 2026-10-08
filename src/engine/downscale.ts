/** Box-filter downscale for preview captures: every output pixel is the exact area-weighted mean of the source pixels it covers, so thin lines stay continuous at tile size (a single canvas `drawImage` shrink sampled them into dashes). Plain JS arithmetic on read-back bytes, so the same input gives byte-identical output on every run, with no platform resampler involved. */

interface BoxTaps {
  /** First source index each output index covers. */
  first: Int32Array;
  /** How many source indices it covers. */
  count: Int32Array;
  /** Where its weights start in `weights`. */
  offset: Int32Array;
  /** Each covered source index's share of the output, summing to 1 per output index. */
  weights: Float64Array;
}

function boxTaps(srcSize: number, dstSize: number): BoxTaps {
  const first = new Int32Array(dstSize);
  const count = new Int32Array(dstSize);
  const offset = new Int32Array(dstSize);
  const weights: number[] = [];
  for (let o = 0; o < dstSize; o++) {
    const lo = (o * srcSize) / dstSize;
    const hi = ((o + 1) * srcSize) / dstSize;
    const i0 = Math.floor(lo);
    const i1 = Math.min(srcSize, Math.ceil(hi));
    first[o] = i0;
    count[o] = i1 - i0;
    offset[o] = weights.length;
    for (let i = i0; i < i1; i++) {
      weights.push((Math.min(i + 1, hi) - Math.max(i, lo)) / (hi - lo));
    }
  }
  return { first, count, offset, weights: Float64Array.from(weights) };
}

/** Downscales a WebGL readback (premultiplied RGBA; `flipY` reads GL's bottom-up rows) to opaque RGBA for `ImageData`. Alpha is ignored exactly as the export's rgba to yuv420p encode ignores it: premultiplied colour is the frame over black, so a tile shows what an export shows and a zero-alpha pixel can never divide its colour away. Separable: rows first, then columns. `out` and `scratch` (at least `downscaleScratchLength`) are reused when given, every byte overwritten. */
export function downscaleRgba(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  flipY = false,
  out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(dstWidth * dstHeight * 4),
  scratch?: Float64Array,
): Uint8ClampedArray<ArrayBuffer> {
  const xs = boxTaps(srcWidth, dstWidth);
  const ys = boxTaps(srcHeight, dstHeight);
  const rows = scratch ?? new Float64Array(downscaleScratchLength(srcHeight, dstWidth));
  for (let y = 0; y < srcHeight; y++) {
    const srcRow = (flipY ? srcHeight - 1 - y : y) * srcWidth;
    for (let x = 0; x < dstWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < xs.count[x]; k++) {
        const w = xs.weights[xs.offset[x] + k];
        const p = (srcRow + xs.first[x] + k) * 4;
        r += src[p] * w;
        g += src[p + 1] * w;
        b += src[p + 2] * w;
      }
      const q = (y * dstWidth + x) * 3;
      rows[q] = r;
      rows[q + 1] = g;
      rows[q + 2] = b;
    }
  }
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < ys.count[y]; k++) {
        const w = ys.weights[ys.offset[y] + k];
        const p = ((ys.first[y] + k) * dstWidth + x) * 3;
        r += rows[p] * w;
        g += rows[p + 1] * w;
        b += rows[p + 2] * w;
      }
      // Uint8ClampedArray stores round-half-even and clamps, so the conversion is exact too.
      const q = (y * dstWidth + x) * 4;
      out[q] = r;
      out[q + 1] = g;
      out[q + 2] = b;
      out[q + 3] = 255;
    }
  }
  return out;
}

/** The row pass's float buffer length: about 199 MB of Float64 for a 4K-tall source, so a run allocates it once. */
export function downscaleScratchLength(srcHeight: number, dstWidth: number): number {
  return dstWidth * srcHeight * 3;
}

/** A still page from a readback: top-down opaque RGBA at the page size. A same-size page is a row-flip copy (byte-equal to the box filter at 1:1), anything smaller the box filter; the one flip site of the stills export. */
export function pageFromReadback(
  readback: Uint8Array,
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number,
  out: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(pageWidth * pageHeight * 4),
  scratch?: Float64Array,
): Uint8ClampedArray<ArrayBuffer> {
  if (pageWidth !== width || pageHeight !== height) {
    return downscaleRgba(readback, width, height, pageWidth, pageHeight, true, out, scratch);
  }
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * row;
    out.set(readback.subarray(src, src + row), y * row);
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}
