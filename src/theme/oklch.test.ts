import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, hexToOklch, mixOklch, oklchToBytes } from "./oklch";

/** GOLDEN pins: the OKLab matrices + sRGB transfer are export contract, pinned against the CANONICAL OKLCH reference values (Ottosson) rather than the curated gradient table, whose `oklch` annotations proved approximate (hexes are the ground truth). */

describe("hex ↔ OKLCH", () => {
  it("matches the canonical reference for pure red", () => {
    const red = hexToOklch("#ff0000");
    expect(red.l).toBeCloseTo(0.6279553606145516, 12);
    expect(red.c).toBeCloseTo(0.2576833077361567, 12);
    expect(red.h).toBeCloseTo(29.233885192342633, 9);
  });

  it("round-trips in-gamut colours to the exact byte", () => {
    for (const hex of ["#cfede6", "#0b1220", "#f3e1e4", "#062733", "#ffffff", "#000000"]) {
      expect(bytesToHex(oklchToBytes(hexToOklch(hex)))).toBe(hex);
    }
  });

  it("stays in the curated table's neighbourhood (annotations are approximate)", () => {
    // Sanity band only; proves we read the same colours the table describes.
    const teal = hexToOklch("#CFEDE6");
    expect(teal.l).toBeCloseTo(0.918, 1);
    expect(Math.abs(teal.h - 178)).toBeLessThan(5);
    const ink = hexToOklch("#0B1220");
    expect(ink.l).toBeCloseTo(0.19, 1);
    expect(Math.abs(ink.h - 260)).toBeLessThan(5);
  });

  it("clamps out-of-gamut results deterministically", () => {
    const bytes = oklchToBytes({ l: 0.95, c: 0.35, h: 145 });
    for (const b of bytes) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
      expect(Number.isFinite(b)).toBe(true);
    }
  });
});

describe("mixOklch", () => {
  it("interpolates L and C linearly and lands on the endpoints", () => {
    const a = hexToOklch("#CFEDE6");
    const b = hexToOklch("#AFD9E8");
    expect(mixOklch(a, b, 0)).toEqual(a);
    const mid = mixOklch(a, b, 0.5);
    expect(mid.l).toBeCloseTo((a.l + b.l) / 2, 12);
    expect(mid.c).toBeCloseTo((a.c + b.c) / 2, 12);
  });

  it("pins the Teal Drift endpoint midpoint (GOLDEN — our contract value)", () => {
    // The curated table annotates its mid stop as #BFE4E8; the TRUE OKLCH midpoint of
    // the endpoints is #BDE4E6 (2 LSB of annotation drift). This literal is the pin.
    const mid = oklchToBytes(mixOklch(hexToOklch("#CFEDE6"), hexToOklch("#AFD9E8"), 0.5));
    expect(bytesToHex(mid)).toBe("#bde4e6");
  });

  it("takes the SHORT hue arc, including across the 0/360 wrap", () => {
    const mid = mixOklch({ l: 0.9, c: 0.05, h: 350 }, { l: 0.9, c: 0.05, h: 10 }, 0.5);
    expect(mid.h).toBeCloseTo(0, 9);
  });

  it("achromatic endpoints adopt the other side's hue", () => {
    const mid = mixOklch({ l: 0.9, c: 0, h: 123 }, { l: 0.5, c: 0.1, h: 200 }, 0.25);
    expect(mid.h).toBeCloseTo(200, 9);
  });

  it("hexToBytes handles shorthand", () => {
    expect(hexToBytes("#fff")).toEqual([255, 255, 255]);
  });
});
