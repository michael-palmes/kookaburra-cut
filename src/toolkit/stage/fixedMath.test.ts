import { describe, expect, it } from "vitest";
import {
  FIXED_BG_DISTANCE,
  FIXED_BG_EDGE_OVERSCAN,
  FIXED_BG_NDC_CLAMP,
  FIXED_BG_RENDER_ORDER,
  fixedContainScale,
  fixedCoverCrop,
  fixedFitQuadSize,
  fixedOverscan,
  fixedParallaxOffset,
  fixedQuadSize,
} from "./fixedMath";

/** GOLDEN values: these literals pin the fixed-background placement math as export contract, so a formula or constant change must fail here first (the engine/ease.ts pinning pattern). */

// halfH at the default fov: 50 · tan(22.5°) = 50 · (√2 − 1)
const HALF_H_45 = 20.710678118654748;

describe("fixed-background constants (export contract)", () => {
  it("pins the contract constants", () => {
    expect(FIXED_BG_DISTANCE).toBe(50);
    expect(FIXED_BG_RENDER_ORDER).toBe(-100);
    expect(FIXED_BG_NDC_CLAMP).toBe(2);
    expect(FIXED_BG_EDGE_OVERSCAN).toBe(1.001);
    expect(fixedOverscan(0)).toBeCloseTo(1.001, 12);
    expect(fixedOverscan(0.05)).toBeCloseTo(1.101, 12);
    expect(fixedOverscan(0.5)).toBeCloseTo(2.001, 12);
  });
});

describe("fixedQuadSize", () => {
  it("fills the 45° frustum at distance 50 (16:9, no parallax)", () => {
    const { width, height } = fixedQuadSize(45, 16 / 9, 0);
    expect(height).toBeCloseTo(2 * HALF_H_45 * 1.001, 9); // 41.462777593...
    expect(height).toBeCloseTo(41.46277759354276, 9);
    expect(width).toBeCloseTo(73.7116046107427, 9);
  });

  it("is square at 1:1 and swaps proportionally at 9:16", () => {
    const square = fixedQuadSize(45, 1, 0);
    expect(square.width).toBeCloseTo(square.height, 12);
    const portrait = fixedQuadSize(45, 9 / 16, 0);
    expect(portrait.width).toBeCloseTo(portrait.height * (9 / 16), 9);
  });

  it("grows with fov (the project-track fov ramp resizes the quad per draw)", () => {
    const narrow = fixedQuadSize(30, 16 / 9, 0);
    const wide = fixedQuadSize(60, 16 / 9, 0);
    expect(narrow.height).toBeCloseTo(
      2 * FIXED_BG_DISTANCE * Math.tan((15 * Math.PI) / 180) * 1.001,
      9,
    );
    expect(wide.height).toBeGreaterThan(narrow.height);
  });

  it("adds the parallax travel to the overscan", () => {
    const locked = fixedQuadSize(45, 1, 0);
    const drifting = fixedQuadSize(45, 1, 0.05);
    expect(drifting.height / locked.height).toBeCloseTo(1.101 / 1.001, 12);
  });
});

describe("fixedParallaxOffset", () => {
  it("is zero when locked (p=0), regardless of anchor displacement", () => {
    expect(fixedParallaxOffset(45, 16 / 9, 0, 1, 1, true)).toEqual({ x: 0, y: 0 });
  });

  it("moves at parallax × the anchor's NDC displacement (golden)", () => {
    const { x, y } = fixedParallaxOffset(45, 1, 0.05, 1, -0.5, true);
    expect(x).toBeCloseTo(1.0355339059327375, 12); // 0.05 · 1 · halfH
    expect(y).toBeCloseTo(-0.5177669529663688, 12); // 0.05 · −0.5 · halfH
  });

  it("scales the x-axis by aspect (halfW = halfH · aspect)", () => {
    const { x } = fixedParallaxOffset(45, 16 / 9, 0.1, 0.5, 0, true);
    expect(x).toBeCloseTo(0.1 * 0.5 * HALF_H_45 * (16 / 9), 12);
  });

  it("clamps the anchor displacement to ±2 NDC (a full frame)", () => {
    const clamped = fixedParallaxOffset(45, 1, 0.05, 5, -9, true);
    expect(clamped.x).toBeCloseTo(0.05 * 2 * HALF_H_45, 12); // 2.0710678118654746
    expect(clamped.y).toBeCloseTo(-0.05 * 2 * HALF_H_45, 12);
  });

  it("holds at zero when the anchor is behind the camera (w ≤ 0)", () => {
    expect(fixedParallaxOffset(45, 1, 0.05, 1, 1, false)).toEqual({ x: 0, y: 0 });
  });
});

describe("fixedCoverCrop", () => {
  it("crops a wide image horizontally into a 16:9 frame (golden)", () => {
    // image 2:1 into 16:9 (1.777…): rx = (16/9)/2 = 0.888…, centred
    const crop = fixedCoverCrop(2, 16 / 9);
    expect(crop.u0).toBeCloseTo(0.05555555555555558, 12);
    expect(crop.u1).toBeCloseTo(0.9444444444444444, 12);
    expect(crop.v0).toBe(0);
    expect(crop.v1).toBe(1);
  });

  it("crops a wide image hard into a portrait frame", () => {
    // image 2:1 into 9:16 (0.5625): rx = 0.28125, centred
    const crop = fixedCoverCrop(2, 9 / 16);
    expect(crop.u0).toBeCloseTo(0.359375, 12);
    expect(crop.u1).toBeCloseTo(0.640625, 12);
  });

  it("crops a tall image vertically into a square frame", () => {
    const crop = fixedCoverCrop(0.5, 1);
    expect(crop.v0).toBeCloseTo(0.25, 12);
    expect(crop.v1).toBeCloseTo(0.75, 12);
    expect(crop.u0).toBe(0);
    expect(crop.u1).toBe(1);
  });

  it("uses the full window when the aspects match", () => {
    expect(fixedCoverCrop(16 / 9, 16 / 9)).toEqual({ u0: 0, v0: 0, u1: 1, v1: 1 });
  });
});

describe("fixedContainScale (letterbox, the fit inverse of the cover-crop)", () => {
  it("shrinks a wide video vertically into a portrait frame (letterbox)", () => {
    // 16:9 (1.777…) media into 9:16 (0.5625): x stays, y = frame/media
    const fit = fixedContainScale(16 / 9, 9 / 16);
    expect(fit.x).toBe(1);
    expect(fit.y).toBeCloseTo(0.31640625, 12); // (9/16)/(16/9)
  });

  it("shrinks a tall video horizontally into a 16:9 frame (pillarbox)", () => {
    const fit = fixedContainScale(9 / 16, 16 / 9);
    expect(fit.y).toBe(1);
    expect(fit.x).toBeCloseTo(0.31640625, 12); // (9/16)/(16/9)
  });

  it("is 1:1 when the aspects match (degenerates to a full fill, no bars)", () => {
    expect(fixedContainScale(16 / 9, 16 / 9)).toEqual({ x: 1, y: 1 });
  });

  it("is the reciprocal of the cover-crop window on the cropped axis", () => {
    // A 2:1 video into 16:9: cover crops U to (16/9)/2 of the width; contain shrinks Y to the same ratio.
    const crop = fixedCoverCrop(2, 16 / 9);
    const fit = fixedContainScale(2, 16 / 9);
    expect(fit.y).toBeCloseTo(crop.u1 - crop.u0, 12);
    expect(fit.x).toBe(1);
  });
});

describe("fixedFitQuadSize", () => {
  it("scales the frame size by the contain axes and the edge overscan only (no parallax term)", () => {
    const fit = fixedContainScale(16 / 9, 9 / 16); // { x: 1, y: 0.3164… }
    const { width, height } = fixedFitQuadSize(45, 9 / 16, fit);
    const baseHalfH = 2 * HALF_H_45 * 1.001;
    expect(width).toBeCloseTo(baseHalfH * (9 / 16) * fit.x, 9);
    expect(height).toBeCloseTo(baseHalfH * fit.y, 9);
  });

  it("matches the frustum-filling size (minus parallax) when contain is 1:1", () => {
    const full = fixedFitQuadSize(45, 16 / 9, { x: 1, y: 1 });
    const filled = fixedQuadSize(45, 16 / 9, 0);
    expect(full.width).toBeCloseTo(filled.width, 9);
    expect(full.height).toBeCloseTo(filled.height, 9);
  });
});
