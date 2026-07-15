import { describe, expect, it } from "vitest";
import { msFromTrackX, playheadFraction, sceneCellSpans } from "./scrubMath";

describe("msFromTrackX (the scrub mapping pin)", () => {
  it("is proportional and snapped to the 16ms step (range-input parity)", () => {
    expect(msFromTrackX(0, 400, 8000)).toBe(0);
    expect(msFromTrackX(400, 400, 8000)).toBe(8000);
    expect(msFromTrackX(200, 400, 8000)).toBe(4000);
    // 100/400 of 8000 = 2000 → already on the grid; 101px = 2020 → snaps to 2016.
    expect(msFromTrackX(101, 400, 8000)).toBe(2016);
  });

  it("clamps outside the track and never exceeds the duration", () => {
    expect(msFromTrackX(-50, 400, 8000)).toBe(0);
    expect(msFromTrackX(999, 400, 8000)).toBe(8000);
    // Snapping at the far end can't round past the duration.
    expect(msFromTrackX(400, 400, 8005)).toBe(8005);
  });

  it("degrades to 0 on empty tracks/durations", () => {
    expect(msFromTrackX(10, 0, 8000)).toBe(0);
    expect(msFromTrackX(10, 400, 0)).toBe(0);
  });
});

describe("playheadFraction", () => {
  it("clamps to [0,1]", () => {
    expect(playheadFraction(-5, 100)).toBe(0);
    expect(playheadFraction(50, 100)).toBe(0.5);
    expect(playheadFraction(150, 100)).toBe(1);
    expect(playheadFraction(10, 0)).toBe(0);
  });
});

describe("sceneCellSpans (cells tile the track on start boundaries)", () => {
  it("weights by start-to-next-start so transitions never over-count", () => {
    // Three scenes with a 600ms crossfade into each: starts 0 / 2400 / 4800, total 7400.
    const slots = [
      { startMs: 0, durationMs: 3000 },
      { startMs: 2400, durationMs: 3000 },
      { startMs: 4800, durationMs: 2600 },
    ];
    const spans = sceneCellSpans(slots, 7400);
    expect(spans.map((s) => s.weight)).toEqual([2400, 2400, 2600]);
    expect(spans.reduce((sum, s) => sum + s.weight, 0)).toBe(7400);
  });

  it("a single scene owns the whole track", () => {
    expect(sceneCellSpans([{ startMs: 0, durationMs: 3000 }], 3000)).toEqual([
      { index: 0, weight: 3000 },
    ]);
  });
});
