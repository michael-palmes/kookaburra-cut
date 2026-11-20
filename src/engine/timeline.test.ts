import { describe, expect, it } from "vitest";
import { FPS } from "./format";
import { steppedLocalMap, steppedTimeMs } from "./timeline";

const at = (frame: number, fps = FPS) => (frame * 1000) / fps;

/** How many consecutive run frames show each held time, over `frames` run frames from frame 0. */
function cadence(startMs: number, stepFps: number, runFps: number, frames: number): number[] {
  const runs: number[] = [];
  let last: number | null = null;
  for (let f = 0; f < frames; f++) {
    const held = steppedTimeMs(at(f, runFps), startMs, stepFps);
    if (held === last) runs[runs.length - 1]++;
    else runs.push(1);
    last = held;
  }
  return runs;
}

describe("steppedTimeMs", () => {
  it("runs every frame without a usable rate", () => {
    for (const fps of [FPS, 120, 0, 0.4, -12, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(steppedTimeMs(1234.5, 1000, fps)).toBe(1234.5);
    }
  });

  it("holds 12 fps for exactly five frames, each showing its step's first frame bit for bit", () => {
    for (let f = 0; f < 600; f++) {
      const first = f - (f % 5);
      expect(steppedTimeMs(at(f), 0, 12)).toBe(at(first));
    }
  });

  it("never shows a pose ahead of the frame", () => {
    for (const start of [0, 1234, 1250, 468.75, 33.4]) {
      for (let f = Math.ceil((start * FPS) / 1000); f < 400; f++) {
        expect(steppedTimeMs(at(f), start, 12)).toBeLessThanOrEqual(at(f));
      }
    }
  });

  it("counts steps from the scene's first frame, on or off the frame grid", () => {
    // 1234 ms falls inside frame 74, so the scene's first frame is 75 (1250 ms).
    expect(steppedTimeMs(at(75), 1234, 12)).toBe(at(75));
    expect(steppedTimeMs(at(79), 1234, 12)).toBe(at(75));
    expect(steppedTimeMs(at(80), 1234, 12)).toBe(at(80));
    // On the grid the first frame is the start itself.
    expect(steppedTimeMs(at(77), 1250, 12)).toBe(1250);
  });

  it("absorbs float error in the clock, stepping from the integer frame index", () => {
    for (let f = 0; f < 5000; f++) {
      const jittered = at(f) * (1 + 1e-12);
      expect(steppedTimeMs(jittered, 0, 12)).toBe(steppedTimeMs(at(f), 0, 12));
    }
  });

  it("keeps an even cadence where the rate divides 60 and alternates where it doesn't", () => {
    expect(new Set(cadence(0, 12, 60, 300))).toEqual(new Set([5]));
    expect(new Set(cadence(0, 10, 60, 300))).toEqual(new Set([6]));
    // 8 fps is 7.5 frames a step: 8 then 7.
    expect(cadence(0, 8, 60, 60)).toEqual([8, 7, 8, 7, 8, 7, 8, 7]);
  });

  it("alternates 3 and 2 output frames for 12 fps on a 30 fps export", () => {
    expect(cadence(0, 12, 30, 20)).toEqual([3, 2, 3, 2, 3, 2, 3, 2]);
    // 10 and 15 fps divide both rates evenly.
    expect(new Set(cadence(0, 10, 30, 60))).toEqual(new Set([3]));
    expect(new Set(cadence(0, 15, 30, 60))).toEqual(new Set([2]));
  });

  it("maps a planner's raw scene time to the frame a stepped consumer binds", () => {
    expect(steppedLocalMap(undefined, 1250)).toBeNull();
    const map = steppedLocalMap(12, 1250);
    // Scene-local frames 0..4 hold frame 0, 5..9 hold frame 5, as the render does.
    for (let f = 0; f < 20; f++) {
      expect(map?.(at(75 + f) - 1250)).toBeCloseTo(steppedTimeMs(at(75 + f), 1250, 12) - 1250, 9);
      expect(map?.(at(75 + f) - 1250)).toBeCloseTo(at(f - (f % 5)), 9);
    }
  });
});
