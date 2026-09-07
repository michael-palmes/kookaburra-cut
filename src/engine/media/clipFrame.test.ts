import { describe, expect, it } from "vitest";
import { clipFrameIndex, clipPlaneSize } from "./clipFrame";

describe("clipFrameIndex — pure frame selection (hold first/last)", () => {
  const fps = 60;
  const frameCount = 700;

  it("holds the first frame before the clip starts", () => {
    expect(clipFrameIndex(-500, 0, fps, frameCount)).toBe(0);
    expect(clipFrameIndex(0, 1000, fps, frameCount)).toBe(0); // startMs after now
  });

  it("returns frame 0 exactly at the start", () => {
    expect(clipFrameIndex(1000, 1000, fps, frameCount)).toBe(0);
  });

  it("floors elapsed time × fps to a frame index", () => {
    expect(clipFrameIndex(1000, 0, fps, frameCount)).toBe(60); // 1.0s × 60
    expect(clipFrameIndex(500, 0, fps, frameCount)).toBe(30); // 0.5s × 60
    expect(clipFrameIndex(1016, 0, fps, frameCount)).toBe(60); // 1.016s × 60 = 60.96 → 60
  });

  it("respects startMs offset", () => {
    expect(clipFrameIndex(2000, 1000, fps, frameCount)).toBe(60); // (2000−1000)ms × 60
  });

  it("holds the last frame past the end of the footage", () => {
    expect(clipFrameIndex(1_000_000, 0, fps, frameCount)).toBe(frameCount - 1);
  });

  it("is safe with no frames", () => {
    expect(clipFrameIndex(1234, 0, fps, 0)).toBe(0);
  });
});

describe("clipFrameIndex — loop mode (v12 · M4 video background fills)", () => {
  const fps = 60;
  const frameCount = 90; // a 1.5s clip

  it("wraps past the end of the footage (the export-contract modulo)", () => {
    expect(clipFrameIndex(1500, 0, fps, frameCount, true)).toBe(0); // exactly one loop
    expect(clipFrameIndex(1516, 0, fps, frameCount, true)).toBe(0); // 90.96 → 90 → wraps to 0
    expect(clipFrameIndex(2000, 0, fps, frameCount, true)).toBe(30); // 120 % 90
    expect(clipFrameIndex(4516, 0, fps, frameCount, true)).toBe(0); // three loops in
  });

  it("matches the clamp path inside the first pass", () => {
    for (const ms of [0, 250, 745, 1483]) {
      expect(clipFrameIndex(ms, 0, fps, frameCount, true)).toBe(
        clipFrameIndex(ms, 0, fps, frameCount),
      );
    }
  });

  it("wraps negative time mathematically (never a negative index)", () => {
    expect(clipFrameIndex(-100, 0, fps, frameCount, true)).toBe(84); // −6 → 84
  });

  it("defaults OFF — the frozen hold behaviour is untouched", () => {
    expect(clipFrameIndex(1_000_000, 0, fps, frameCount)).toBe(frameCount - 1);
  });

  it("is safe with no frames", () => {
    expect(clipFrameIndex(1234, 0, fps, 0, true)).toBe(0);
  });
});

describe("clipPlaneSize — fit math", () => {
  const frame = { width: 16, height: 9 }; // 16:9-ish frame aspect ≈ 1.778

  it("returns zero until the clip geometry is known", () => {
    expect(clipPlaneSize("contain", frame, { width: 0, height: 0 })).toEqual({
      width: 0,
      height: 0,
    });
  });

  it("contain fits a square clip within the frame height", () => {
    expect(clipPlaneSize("contain", frame, { width: 100, height: 100 })).toEqual({
      width: 9,
      height: 9,
    });
  });

  it("cover fills the frame width with a square clip (overflow height)", () => {
    expect(clipPlaneSize("cover", frame, { width: 100, height: 100 })).toEqual({
      width: 16,
      height: 16,
    });
  });

  it("contain letterboxes a clip wider than the frame", () => {
    expect(clipPlaneSize("contain", frame, { width: 200, height: 50 })).toEqual({
      width: 16,
      height: 4,
    });
  });

  it("cover fills the frame height with a clip wider than the frame", () => {
    expect(clipPlaneSize("cover", frame, { width: 200, height: 50 })).toEqual({
      width: 36,
      height: 9,
    });
  });
});
