import { describe, expect, it } from "vitest";
import { remapScreenUv, screenUvMap } from "../../engine/screenFit";
import { lensRect, regionLift, regionSampling, type ScreenUvRect } from "./screenRegionMath";

describe("regionSampling", () => {
  const maps = [
    { label: "an exact fit", map: screenUvMap(0.46, 0.46, false, 0) },
    { label: "a cover-cropped video (flipped)", map: screenUvMap(16 / 9, 0.46, true, 0) },
    { label: "a tall still", map: screenUvMap(0.3, 0.46, false, 0) },
    { label: "a turned video", map: screenUvMap(16 / 9, 0.46, true, 1) },
    { label: "a still turned twice", map: screenUvMap(0.75, 1.43, false, 2) },
    { label: "a video turned three times", map: screenUvMap(2.1, 0.46, true, 3) },
  ];
  const rects: ScreenUvRect[] = [
    [0, 0, 1, 1],
    [0.1, 0.4, 0.9, 0.52],
    [0.62, 0.05, 0.95, 0.2],
  ];

  for (const { label, map } of maps) {
    it(`samples exactly what the display shows under it for ${label}`, () => {
      for (const [u0, v0, u1, v1] of rects) {
        const sampling = regionSampling(map, [u0, v0, u1, v1]);
        for (const [s, t] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
          [0.3, 0.7],
          [0.5, 0.5],
        ]) {
          // The card's s runs right and t up; the display's v runs down.
          const expected = remapScreenUv(u0 + s * (u1 - u0), v1 - t * (v1 - v0), map);
          expect(sampling.origin[0] + s * sampling.s[0] + t * sampling.t[0]).toBeCloseTo(
            expected[0],
            12,
          );
          expect(sampling.origin[1] + s * sampling.s[1] + t * sampling.t[1]).toBeCloseTo(
            expected[1],
            12,
          );
        }
      }
    });
  }
});

describe("lensRect", () => {
  it("shows a patch radius / zoom across, in the display's own units", () => {
    const [u0, v0, u1, v1] = lensRect([0.5, 0.3], 0.3, 2, { width: 1.2, height: 2.4 });
    expect((u1 - u0) * 1.2).toBeCloseTo(0.3, 12);
    expect((v1 - v0) * 2.4).toBeCloseTo(0.3, 12);
    expect((u0 + u1) / 2).toBeCloseTo(0.5, 12);
    expect((v0 + v1) / 2).toBeCloseTo(0.3, 12);
  });

  it("treats a zoom of zero or less as no magnification", () => {
    expect(lensRect([0.5, 0.5], 0.3, 0, { width: 1, height: 1 })).toEqual(
      lensRect([0.5, 0.5], 0.3, 1, { width: 1, height: 1 }),
    );
  });
});

describe("regionLift", () => {
  it("rises from the glass over its duration and holds up", () => {
    expect(regionLift(0, { at: 500 })).toBe(0);
    expect(regionLift(500, { at: 500 })).toBe(0);
    expect(regionLift(800, { at: 500, ease: "linear" })).toBeCloseTo(0.5, 12);
    expect(regionLift(1100, { at: 500 })).toBe(1);
    expect(regionLift(9000, { at: 500 })).toBe(1);
  });

  it("settles back onto the glass from outAt", () => {
    const timing = { at: 0, durationMs: 400, outAt: 2000, outDurationMs: 200, ease: "linear" };
    expect(regionLift(1500, timing)).toBe(1);
    expect(regionLift(2100, timing)).toBeCloseTo(0.5, 12);
    expect(regionLift(2200, timing)).toBe(0);
  });

  it("steps when a duration is zero", () => {
    expect(regionLift(99, { at: 100, durationMs: 0 })).toBe(0);
    expect(regionLift(100, { at: 100, durationMs: 0 })).toBe(1);
  });
});
