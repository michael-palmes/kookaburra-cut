import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildTransitionMaskField,
  edt,
  fitCoverage,
  fromHalf,
  MASK_INSET_FLOOR,
  maskCoverage,
  maskReveal,
  signedDistance,
  type TransitionMaskField,
  toHalf,
} from "./transitionMaskSdf";

/** RGBA bytes (rows top-down) from a 4x4-supersampled inside test, white on transparency. */
function rasterise(
  width: number,
  height: number,
  inside: (x: number, y: number) => boolean,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
        }
      }
      const o = (y * width + x) * 4;
      rgba.fill(255, o, o + 3);
      rgba[o + 3] = Math.round((hits / 16) * 255);
    }
  }
  return rgba;
}

function starTest(size: number): (x: number, y: number) => boolean {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const r = (i % 2 === 0 ? 0.46 : 0.23) * size;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push([size / 2 + r * Math.cos(a), size / 2 + r * Math.sin(a)]);
  }
  return (x, y) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
}

function fieldHash(field: TransitionMaskField): string {
  const h = createHash("sha256");
  h.update(Buffer.from(field.data.buffer, field.data.byteOffset, field.data.byteLength));
  h.update(`${field.width}x${field.height}|${field.half.join(",")}|${field.inset}`);
  return h.digest("hex");
}

/** Deterministic LCG for the brute-force grids. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("toHalf / fromHalf", () => {
  it("encodes known values and rounds to nearest even", () => {
    expect(toHalf(0)).toBe(0);
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(2 ** -24)).toBe(1);
    // 1 + 2^-11 sits exactly between two halves and ties to the even one (1.0).
    expect(toHalf(1 + 2 ** -11)).toBe(0x3c00);
    expect(toHalf(1 + 3 * 2 ** -11)).toBe(0x3c02);
  });

  it("round-trips within half an ulp", () => {
    for (const v of [0.1, -0.37, 0.001, 1.3, -1.999, 3e-6]) {
      const back = fromHalf(toHalf(v));
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -11 + 2 ** -25);
    }
  });
});

describe("edt", () => {
  it("matches the brute-force squared distance exactly", () => {
    const rand = lcg(7);
    for (const [w, h] of [
      [17, 13],
      [1, 9],
      [9, 1],
      [32, 32],
    ]) {
      const seeds = Array.from({ length: w * h }, () => rand() < 0.08);
      seeds[Math.floor(rand() * w * h)] = true;
      const grid = new Float64Array(seeds.map((s) => (s ? 0 : 1e20)));
      edt(grid, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let best = Number.POSITIVE_INFINITY;
          for (let i = 0; i < w * h; i++) {
            if (!seeds[i]) continue;
            const dx = x - (i % w);
            const dy = y - Math.floor(i / w);
            best = Math.min(best, dx * dx + dy * dy);
          }
          expect(grid[y * w + x]).toBe(best);
        }
      }
    }
  });
});

describe("signedDistance", () => {
  it("tracks an antialiased disc's true distance to within a fraction of a pixel near the edge", () => {
    const w = 64;
    const h = 64;
    const r = 20.3;
    const rgba = rasterise(w, h, (x, y) => (x - 32) ** 2 + (y - 32) ** 2 < r * r);
    const sd = signedDistance(maskCoverage(rgba, w, h), w, h);
    let worst = 0;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const truth = Math.hypot(x + 0.5 - 32, y + 0.5 - 32) - r;
        if (Math.abs(truth) >= 3) continue;
        const e = Math.abs(sd[y * w + x] - truth);
        worst = Math.max(worst, e);
        sum += e;
        n++;
      }
    }
    expect(worst).toBeLessThan(0.6);
    expect(sum / n).toBeLessThan(0.2);
  });
});

describe("maskCoverage", () => {
  it("reads alpha when any pixel is translucent", () => {
    const rgba = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 0]);
    expect([...maskCoverage(rgba, 2, 1)]).toEqual([1, 0]);
  });

  it("reads Rec. 709 luma when the image is opaque", () => {
    const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 0, 255]);
    const cov = maskCoverage(rgba, 3, 1);
    expect(cov[0]).toBeCloseTo(1, 6);
    expect(cov[1]).toBe(0);
    expect(cov[2]).toBeCloseTo(0.7152, 6);
  });
});

describe("fitCoverage", () => {
  it("keeps a small mask as is and box-downsamples a large one", () => {
    const small = new Float32Array(4).fill(1);
    expect(fitCoverage(small, 2, 2, 4).coverage).toBe(small);
    const big = new Float32Array(5 * 3).map((_, i) => (i % 5 < 4 ? 1 : 0));
    const fit = fitCoverage(big, 5, 3, 2);
    expect([fit.width, fit.height]).toEqual([2, 1]);
    expect(fit.coverage[0]).toBe(1);
    expect(fit.coverage[1]).toBeCloseTo(0.5, 6);
  });
});

describe("buildTransitionMaskField", () => {
  it("stores rows bottom-up, half extents from the aspect and the centre's inset", () => {
    const w = 40;
    const h = 20;
    const rgba = rasterise(w, h, (_x, y) => y < 6.25);
    const field = buildTransitionMaskField(rgba, w, h);
    expect(field.half).toEqual([0.5, 0.25]);
    expect(fromHalf(field.data[(h - 1) * w + 20])).toBeLessThan(0);
    expect(fromHalf(field.data[20])).toBeGreaterThan(0);
    expect(Math.abs(field.inset + (10 - 6.25) / 40)).toBeLessThan(0.5 / 40);
  });

  it("the star's inset is its inner radius", () => {
    const size = 96;
    const field = buildTransitionMaskField(rasterise(size, size, starTest(size)), size, size);
    expect(field.inset).toBeGreaterThan(0.2);
    expect(field.inset).toBeLessThan(0.24);
  });

  it("downsamples to the cap", () => {
    const field = buildTransitionMaskField(rasterise(60, 30, starTest(30)), 60, 30, 16);
    expect([field.width, field.height]).toEqual([15, 8]);
  });

  it("refuses an empty mask", () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    expect(() => buildTransitionMaskField(rgba, 4, 4)).toThrow(/no shape/);
    const dim = new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 3 ? 255 : 40));
    expect(() => buildTransitionMaskField(dim, 4, 4)).toThrow(/no shape/);
  });

  // Golden field bytes: the SDF is export contract, so any change to coverage, the transform, normalisation or half packing moves these.
  it("golden: an antialiased disc", () => {
    const rgba = rasterise(64, 48, (x, y) => (x - 30) ** 2 + (y - 25) ** 2 < 17.5 ** 2);
    expect(fieldHash(buildTransitionMaskField(rgba, 64, 48))).toBe(
      "424738bebd5997a8eb031d3f6a02ce3869835d0ad4c4b4ff5e08150c534063fa",
    );
  });

  it("golden: the fixture's five-point star", () => {
    const size = 96;
    expect(
      fieldHash(buildTransitionMaskField(rasterise(size, size, starTest(size)), size, size)),
    ).toBe("04d8c4bcab08d5404a51383fa2d4320952a78ce0e2e1b90187b144434526720d");
  });

  it("golden: an opaque luma mask", () => {
    const w = 32;
    const h = 32;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const y = Math.floor(i / w);
      const v = Math.abs(x - 15.5) + Math.abs(y - 15.5) < 11 ? 230 : 20;
      rgba.set([v, v, v, 255], i * 4);
    }
    expect(fieldHash(buildTransitionMaskField(rgba, w, h))).toBe(
      "0a7420a78c5a7b311b701c8bd0186fa5fea61db343674fa2bce8eb0ba9afddc9",
    );
  });
});

describe("maskReveal", () => {
  const cases: { aspect: number; center: [number, number]; inset: number; heightPx: number }[] = [
    { aspect: 16 / 9, center: [0.5, 0.5], inset: 0.23, heightPx: 2160 },
    { aspect: 9 / 16, center: [0.5, 0.5], inset: 0.23, heightPx: 1920 },
    { aspect: 1, center: [0.2, 0.8], inset: 0.5, heightPx: 1080 },
    { aspect: 16 / 9, center: [0.5, 0.5], inset: 0.02, heightPx: 1080 },
    { aspect: 4 / 5, center: [0.5, 0.5], inset: -0.3, heightPx: 1350 },
  ];

  it("starts from nothing", () => {
    for (const c of cases) {
      const r = maskReveal(0, c.aspect, c.center, c.heightPx, c.inset);
      expect(r.scale).toBe(0);
      expect(r.dilate).toBe(0);
    }
  });

  it("covers every frame point by more than a pixel at progress 1", () => {
    for (const c of cases) {
      const r = maskReveal(1, c.aspect, c.center, c.heightPx, c.inset);
      expect(r.pixel).toBeCloseTo(1 / c.heightPx, 12);
      for (const [cx, cy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const q = Math.hypot((cx - c.center[0]) * c.aspect, cy - c.center[1]);
        // The shader caps the field at |u| - inset, so s * field(q / s) <= |q| - s * inset.
        const worst = q - r.scale * c.inset - r.dilate;
        expect(worst).toBeLessThan(-r.pixel);
      }
    }
  });

  it("grows monotonically, scale linear and dilation late", () => {
    const c = cases[0];
    let prev = maskReveal(0, c.aspect, c.center, c.heightPx, c.inset);
    for (let i = 1; i <= 20; i++) {
      const r = maskReveal(i / 20, c.aspect, c.center, c.heightPx, c.inset);
      expect(r.scale).toBeGreaterThan(prev.scale);
      expect(r.dilate).toBeGreaterThan(prev.dilate);
      prev = r;
    }
    const half = maskReveal(0.5, c.aspect, c.center, c.heightPx, c.inset);
    const full = maskReveal(1, c.aspect, c.center, c.heightPx, c.inset);
    expect(half.scale).toBeCloseTo(full.scale / 2, 12);
    expect(half.dilate).toBeCloseTo(full.dilate / 8, 12);
  });

  it("floors the scale schedule for a shallow centre", () => {
    const shallow = maskReveal(1, 1, [0.5, 0.5], 1080, 0.001);
    const floored = maskReveal(1, 1, [0.5, 0.5], 1080, MASK_INSET_FLOOR);
    expect(shallow.scale).toBeCloseTo(floored.scale, 12);
    expect(shallow.dilate).toBeGreaterThan(floored.dilate);
  });
});
