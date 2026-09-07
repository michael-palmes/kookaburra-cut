import { describe, expect, it } from "vitest";
import type { BeatAnalysis } from "./beatAnalysis";
import { effectiveKeyMoments, projectBeatGrid } from "./beatState";

const analysis: BeatAnalysis = {
  version: 1,
  durationMs: 10_000,
  bpm: 120,
  beats: [],
  keyMoments: [
    { tMs: 1000, strength: 0.9 },
    { tMs: 4000, strength: 0.5 },
  ],
  envelope: { hopMs: 21.333, values: [] },
};

describe("effectiveKeyMoments", () => {
  it("uses detection when no overlay exists", () => {
    expect(effectiveKeyMoments(analysis, undefined)).toEqual(analysis.keyMoments);
  });

  it("replaces detection wholesale, borrowing nearby strengths", () => {
    const out = effectiveKeyMoments(analysis, { version: 1, keyMoments: [1010, 7000] });
    expect(out).toEqual([
      { tMs: 1010, strength: 0.9 },
      { tMs: 7000, strength: 0.8 },
    ]);
  });

  it("stands alone when analysis is still pending", () => {
    expect(effectiveKeyMoments(null, { version: 1, keyMoments: [100] })).toEqual([
      { tMs: 100, strength: 0.8 },
    ]);
    expect(effectiveKeyMoments(null, undefined)).toEqual([]);
  });

  it("shifts detected times into project time and clips to the timeline", () => {
    expect(effectiveKeyMoments(analysis, undefined, 1500, 3000)).toEqual([
      { tMs: 2500, strength: 0.5 },
    ]);
    expect(effectiveKeyMoments(analysis, undefined, 1500, 2000)).toEqual([]);
  });
});

describe("projectBeatGrid", () => {
  it("shifts and clips the grid", () => {
    const withBeats = { ...analysis, beats: [0, 500, 1000, 1500, 9000] };
    expect(projectBeatGrid(withBeats, 500, 5000)).toEqual([0, 500, 1000]);
    expect(projectBeatGrid(null)).toEqual([]);
  });
});
