import { describe, expect, it } from "vitest";
import type { BeatAnalysis, BeatFit } from "./beatAnalysis";
import { detectedGrid, makeBarOneGrid, setDownbeatGrid, withGridBpm } from "./musicGridEdit";
import type { AudioGridSpec } from "./project";

const fit: BeatFit = {
  bpm: 120,
  offsetMs: 250,
  beatsPerBar: 4,
  periodMs: 500,
  phaseMs: 250,
  residualMs: 0.9,
  maxDriftMs: 3,
  constantTempo: true,
};

const analysis = (over: Partial<BeatAnalysis> = {}): BeatAnalysis => ({
  version: 3,
  sha256: "sha",
  tracker: "nn",
  fallbackReason: null,
  durationMs: 60000,
  bpm: 120,
  fit,
  beats: [],
  beatInfo: [],
  downbeats: [250, 2250, 4250],
  keyMoments: [],
  envelope: { hopMs: 21.333, values: [] },
  energy: null,
  sections: [],
  breaths: [],
  stabs: [],
  hits: [],
  lyrics: null,
  ...over,
});

const authored: AudioGridSpec = {
  bpm: 120,
  offsetMs: 250,
  beatsPerBar: 4,
  source: { sha256: "sha", analysisVersion: 3, tracker: "nn", residualMs: 0.9 },
};

describe("detectedGrid", () => {
  it("takes the fit with its provenance", () => {
    expect(detectedGrid(analysis())).toEqual(authored);
  });

  it("is null without a usable fit", () => {
    expect(detectedGrid(null)).toBeNull();
    expect(detectedGrid(analysis({ fit: null }))).toBeNull();
    expect(detectedGrid(analysis({ fit: { ...fit, bpm: 400 } }))).toBeNull();
  });
});

describe("withGridBpm (the BPM row, x2 and /2)", () => {
  it("keeps bar 1, rounds to 3 dp and drops the provenance", () => {
    expect(withGridBpm(authored, 240.00049)).toEqual({ bpm: 240, offsetMs: 250, beatsPerBar: 4 });
    expect(withGridBpm(authored, 60.1234)?.bpm).toBe(60.123);
  });

  it("refuses a tempo outside 30..300", () => {
    expect(withGridBpm(authored, 301)).toBeNull();
    expect(withGridBpm(authored, 29.9)).toBeNull();
  });
});

describe("setDownbeatGrid (Set downbeat here)", () => {
  it("moves the nearest bar line to the click and keeps every bar's number", () => {
    // Bar 3 sat at 4250; clicked at 4300, so bar 3 now starts there and bar 1 at 300.
    expect(setDownbeatGrid(authored, analysis(), 4300)).toEqual({ ...authored, offsetMs: 300 });
    expect(setDownbeatGrid(authored, null, 3200)).toEqual({ ...authored, offsetMs: 1200 });
  });

  it("starts a grid from the detected tempo when there is none", () => {
    expect(setDownbeatGrid(undefined, analysis(), 4300)).toEqual({ ...authored, offsetMs: 300 });
    expect(setDownbeatGrid(undefined, analysis({ fit: null }), 4300)).toEqual({
      bpm: 120,
      beatsPerBar: 4,
      offsetMs: 300,
    });
  });

  it("can't start one without any tempo", () => {
    expect(setDownbeatGrid(undefined, null, 4300)).toBeNull();
    expect(setDownbeatGrid(undefined, analysis({ fit: null, bpm: null }), 4300)).toBeNull();
  });
});

describe("makeBarOneGrid (Make this bar 1)", () => {
  it("renumbers from the authored downbeat nearest the click", () => {
    expect(makeBarOneGrid(authored, analysis(), 4900)).toEqual({ ...authored, offsetMs: 4250 });
    expect(makeBarOneGrid(authored, null, 5400)).toEqual({ ...authored, offsetMs: 6250 });
  });

  it("uses the detected downbeats when there is no grid", () => {
    expect(makeBarOneGrid(undefined, analysis(), 2100)).toEqual({ ...authored, offsetMs: 2250 });
    expect(makeBarOneGrid(undefined, null, 2100)).toBeNull();
  });
});
