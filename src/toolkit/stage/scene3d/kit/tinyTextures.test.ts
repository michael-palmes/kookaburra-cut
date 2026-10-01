import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
} from "three";
import { describe, expect, it, vi } from "vitest";
import {
  createTinyTexture,
  decodeTinyBytes,
  getPaperGrainTexture,
  PAPER_GRAIN_SIZE,
  paperGrainImage,
  periodicNoise,
  type TinyImage,
  tinyHash,
  tinyMipChain,
  tinyTexture,
} from "./tinyTextures";

const fnv1a = (data: Uint8Array) => {
  let h = 0x811c9dc5;
  for (const b of data) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};

const image = (width: number, height: number, channels: 1 | 4, fill: (i: number) => number) => ({
  width,
  height,
  channels,
  data: Uint8Array.from({ length: width * height * channels }, (_, i) => fill(i)),
});

describe("tinyMipChain", () => {
  it("halves down to 1x1, rounding each 2x2 mean in integer maths", () => {
    const chain = tinyMipChain(image(4, 4, 1, (i) => [0, 1, 2, 3][i % 4] + (i >> 2) * 10));
    expect(chain.map((m) => `${m.width}x${m.height}`)).toEqual(["4x4", "2x2", "1x1"]);
    // Top-left block: 0, 1, 10, 11 -> 22 / 4 = 5.5 -> 6.
    expect(chain[1].data[0]).toBe(6);
    expect(chain[2].data).toHaveLength(1);
  });

  it("keeps channels apart and handles non-square power-of-two images", () => {
    const chain = tinyMipChain(image(8, 2, 4, (i) => (i % 4) * 50));
    expect(chain.map((m) => `${m.width}x${m.height}`)).toEqual(["8x2", "4x1", "2x1", "1x1"]);
    expect(Array.from(chain.at(-1)?.data ?? [])).toEqual([0, 50, 100, 150]);
  });

  it("rejects sizes it cannot box-filter exactly", () => {
    expect(() => tinyMipChain(image(6, 4, 1, () => 0))).toThrow(/power-of-two/);
    expect(() =>
      tinyMipChain({ width: 4, height: 4, channels: 4, data: new Uint8Array(3) }),
    ).toThrow(/bytes/);
  });
});

describe("createTinyTexture", () => {
  it("uploads repeat-wrapped raw data with the JS mips and no GPU mip generation", () => {
    const rgba = createTinyTexture(image(16, 16, 4, (i) => i & 255));
    expect(rgba.format).toBe(RGBAFormat);
    expect(rgba.wrapS).toBe(RepeatWrapping);
    expect(rgba.wrapT).toBe(RepeatWrapping);
    expect(rgba.minFilter).toBe(LinearMipmapLinearFilter);
    expect(rgba.magFilter).toBe(LinearFilter);
    expect(rgba.generateMipmaps).toBe(false);
    expect(rgba.colorSpace).toBe(NoColorSpace);
    expect(rgba.flipY).toBe(false);
    expect(rgba.mipmaps).toHaveLength(5);
    const red = createTinyTexture(image(8, 8, 1, () => 7));
    expect(red.format).toBe(RedFormat);
    expect(red.unpackAlignment).toBe(1);
  });

  it("builds each keyed texture once, on first use", () => {
    const build = vi.fn((): TinyImage => image(2, 2, 1, () => 1));
    const a = tinyTexture("test-once", build);
    expect(tinyTexture("test-once", build)).toBe(a);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("decodes embedded base64 bytes", () => {
    expect(Array.from(decodeTinyBytes("AAEC/w=="))).toEqual([0, 1, 2, 255]);
  });
});

describe("tinyHash", () => {
  it("matches the GLSL kkHash golden values", () => {
    expect(tinyHash(0, 0, 0)).toBe(0);
    // Independently computed from the GLSL in 32-bit unsigned maths.
    expect(tinyHash(1, 0, 0)).toBe(0.07986199855804443);
    expect(tinyHash(17, 3, 0)).toBe(0.24220293760299683);
    expect(tinyHash(-5, 2, 1)).toBe(0.16776317358016968);
    for (let i = 0; i < 64; i++) {
      const h = tinyHash(i, i * 3, 7);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it("wraps periodic noise on its lattice", () => {
    expect(periodicNoise(0.3, 0.7, 4, 4, 9)).toBeCloseTo(periodicNoise(4.3, 8.7, 4, 4, 9), 12);
  });
});

describe("paper grain", () => {
  const paper = paperGrainImage();

  it("is a deterministic 128 px RGBA tile (golden bytes: a change re-textures every look using it)", () => {
    expect(paper.width).toBe(PAPER_GRAIN_SIZE);
    expect(paper.channels).toBe(4);
    expect(fnv1a(paper.data)).toBe("40902633");
  });

  it("centres every channel on mid grey with real spread", () => {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      let lo = 255;
      let hi = 0;
      for (let i = c; i < paper.data.length; i += 4) {
        sum += paper.data[i];
        lo = Math.min(lo, paper.data[i]);
        hi = Math.max(hi, paper.data[i]);
      }
      const mean = sum / (paper.data.length / 4);
      expect(Math.abs(mean - 127.5), `channel ${c}`).toBeLessThan(4);
      expect(hi - lo, `channel ${c}`).toBeGreaterThan(120);
    }
  });

  it("tiles without a seam: the wrap step is no bigger than an ordinary neighbour step", () => {
    const n = PAPER_GRAIN_SIZE;
    const at = (x: number, y: number) => paper.data[(y * n + x) * 4];
    let inner = 0;
    let wrap = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n - 1; x++) inner += Math.abs(at(x + 1, y) - at(x, y));
      wrap += Math.abs(at(0, y) - at(n - 1, y));
    }
    expect(wrap / n).toBeLessThan((inner / (n * (n - 1))) * 1.5);
  });

  it("is shared and lazily built", () => {
    expect(getPaperGrainTexture()).toBe(getPaperGrainTexture());
    expect(getPaperGrainTexture().mipmaps).toHaveLength(8);
  });
});
