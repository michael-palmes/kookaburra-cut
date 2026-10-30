import { describe, expect, it } from "vitest";
import { ease } from "../../engine/ease";
import type { BeatGrid } from "../music/useBeatGrid";
import { beatsInWindow, counterProgress } from "./counterProgress";

describe("counterProgress", () => {
  it("runs the legacy linear expression when no timing option is set", () => {
    for (const t of [-100, 0, 250, 999, 1000, 4000]) {
      expect(counterProgress({ durationMs: 1000 }, t)).toBe(Math.min(1, Math.max(0, t / 1000)));
    }
    expect(counterProgress({ durationMs: 0 }, -5)).toBe(1);
  });

  it("starts at startMs", () => {
    expect(counterProgress({ durationMs: 1000, startMs: 500 }, 400)).toBe(0);
    expect(counterProgress({ durationMs: 1000, startMs: 500 }, 1000)).toBe(0.5);
    expect(counterProgress({ durationMs: 1000, startMs: 500 }, 1500)).toBe(1);
  });

  it("shapes the count with an ease", () => {
    expect(counterProgress({ durationMs: 1000, ease: "outCubic" }, 300)).toBe(
      ease("outCubic", 0.3),
    );
  });

  it("counts in equal jumps with steps, landing on the end", () => {
    const at = (t: number) => counterProgress({ durationMs: 1000, steps: 4 }, t);
    expect([0, 240, 250, 499, 500, 999, 1000].map(at)).toEqual([0, 0, 0.25, 0.25, 0.5, 0.75, 1]);
  });
});

describe("counterProgress stepsAt", () => {
  const at = [100, 300, 700, 1000];

  it("jumps one equal share at each time, whatever the window says", () => {
    const timing = { durationMs: 99, stepsAt: at };
    expect(counterProgress(timing, 99)).toBe(0);
    expect(counterProgress(timing, 100)).toBe(0.25);
    expect(counterProgress(timing, 699)).toBe(0.5);
    expect(counterProgress(timing, 1000)).toBe(1);
  });

  it("takes the times in any order", () => {
    expect(counterProgress({ durationMs: 1, stepsAt: [700, 100] }, 200)).toBe(0.5);
  });

  it("bends the values, not the times, with an ease, and still lands on 1", () => {
    const timing = { durationMs: 1, stepsAt: at, ease: "outCubic" as const };
    expect(counterProgress(timing, 99)).toBe(0);
    expect(counterProgress(timing, 300)).toBeCloseTo(ease("outCubic", 0.5));
    expect(counterProgress(timing, 1000)).toBe(1);
  });

  it("treats an empty list as unset", () => {
    expect(counterProgress({ durationMs: 1000, stepsAt: [] }, 500)).toBe(0.5);
  });
});

describe("steps semantics", () => {
  it("holds until the eased progress crosses 1/n, and lands exactly at the end", () => {
    const timing = { durationMs: 1000, steps: 4 };
    expect(counterProgress(timing, 0)).toBe(0);
    expect(counterProgress(timing, 249)).toBe(0);
    expect(counterProgress(timing, 250)).toBe(0.25);
    expect(counterProgress(timing, 999)).toBe(0.75);
    expect(counterProgress(timing, 1000)).toBe(1);
  });

  it("moves the jumps with the ease", () => {
    const linear = counterProgress({ durationMs: 1000, steps: 4 }, 300);
    const eased = counterProgress({ durationMs: 1000, steps: 4, ease: "outCubic" }, 300);
    expect(eased).toBeGreaterThan(linear);
  });
});

describe("beatsInWindow", () => {
  const beatMs = 500;
  const grid = {
    beatsPerBar: 4,
    beatMs,
    bar: (bar: number, beat = 1) => ((bar - 1) * 4 + (beat - 1)) * beatMs,
    position: (ms: number) => {
      const beats = ms / beatMs;
      const whole = Math.floor(beats);
      return {
        bar: Math.floor(whole / 4) + 1,
        beat: (whole % 4) + 1,
        sixteenth: Math.floor((beats - whole) * 4) + 1,
        beatPhase: beats - whole,
        barPhase: 0,
      };
    },
  } as unknown as BeatGrid;

  it("lists every beat from the start to the end, both included", () => {
    expect(beatsInWindow(grid, 1000, 1000)).toEqual([1000, 1500, 2000]);
  });

  it("starts on the next beat when the window opens between them, across a bar", () => {
    expect(beatsInWindow(grid, 1700, 400)).toEqual([2000]);
  });

  it("finds nothing in a window shorter than a beat", () => {
    expect(beatsInWindow(grid, 1600, 100)).toEqual([]);
  });
});
