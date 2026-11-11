import { describe, expect, it } from "vitest";
import { LENS_COC_MAX, LENS_MM_PER_UNIT, lensCoc, lensUniforms } from "./lensDof";

/** projection[5] for a vertical fov in degrees. */
const projY = (fovDeg: number) => 1 / Math.tan((fovDeg * Math.PI) / 360);

describe("lensUniforms", () => {
  it("derives the focal length from the sensor and fov", () => {
    // A full-frame sensor (24 mm tall) at a 39.6 degree vertical fov is a 33 mm lens.
    const u = lensUniforms(
      { fStop: 4, focalMm: null, sensorMm: 24, focus: 10, blur: 1 },
      projY(39.6),
    );
    expect(u.focalMm).toBeCloseTo(33.3, 1);
    expect(u.sensorMm).toBe(24);
  });

  it("a named focal length sets the sensor the fov implies", () => {
    const u = lensUniforms({ fStop: 4, focalMm: 50, sensorMm: 24, focus: 10, blur: 1 }, projY(28));
    expect(u.focalMm).toBe(50);
    expect(u.sensorMm).toBeCloseTo(2 * 50 * Math.tan((14 * Math.PI) / 180), 9);
  });

  it("matches the thin-lens CoC at infinity", () => {
    // 50 mm f/2 focused at 2 m on a 24 mm sensor: c = (f/N) f / (s - f) = 25 * 50 / 1950 mm.
    const focus = 2000 / LENS_MM_PER_UNIT;
    const u = lensUniforms({ fStop: 2, focalMm: 50, sensorMm: 24, focus, blur: 1 }, 50 / 12);
    expect(u.cocInf * u.sensorMm).toBeCloseTo((25 * 50) / 1950, 9);
  });

  it("halving the aperture halves the blur; blur scales it to a pinhole", () => {
    const base = { fStop: 4, focalMm: null, sensorMm: 24, focus: 1.85, blur: 1 };
    const a = lensUniforms(base, projY(28)).cocInf;
    expect(lensUniforms({ ...base, fStop: 8 }, projY(28)).cocInf).toBeCloseTo(a / 2, 12);
    expect(lensUniforms({ ...base, blur: 0.25 }, projY(28)).cocInf).toBeCloseTo(a / 4, 12);
    expect(lensUniforms({ ...base, blur: 0 }, projY(28)).cocInf).toBe(0);
  });

  it("focus inside the focal length saturates rather than flipping sign", () => {
    const u = lensUniforms(
      { fStop: 4, focalMm: 100, sensorMm: 24, focus: 0.5, blur: 1 },
      projY(28),
    );
    expect(u.cocInf).toBeGreaterThan(0);
    expect(Number.isFinite(u.cocInf)).toBe(true);
  });
});

describe("lensCoc", () => {
  const u = lensUniforms(
    { fStop: 16, focalMm: null, sensorMm: 24, focus: 1.85, blur: 1 },
    projY(28),
  );

  it("is zero on the focus plane, negative in front, positive behind", () => {
    expect(lensCoc(u, 1.85)).toBe(0);
    expect(lensCoc(u, 1.6)).toBeLessThan(0);
    expect(lensCoc(u, 2.2)).toBeGreaterThan(0);
  });

  it("grows toward the ceiling and never past it", () => {
    expect(lensCoc(u, 2.0)).toBeLessThan(lensCoc(u, 3));
    expect(lensCoc(u, 1e6)).toBe(Math.min(LENS_COC_MAX, u.cocInf));
    expect(lensCoc(u, 0.01)).toBe(-LENS_COC_MAX);
  });

  it("keeps a phone-sized macro subject plausibly shallow", () => {
    // Unveil's Glimpses frame: about 10 cm from the screen, 28 degree fov. At f/16 a point 5 mm behind focus blurs a few pixels at 1080p.
    const px = lensCoc(u, 1.85 + 5 / LENS_MM_PER_UNIT) * 1080;
    expect(px).toBeGreaterThan(2);
    expect(px).toBeLessThan(8);
  });
});
