import { describe, expect, it } from "vitest";
import {
  analyseBeats,
  BEAT_SAMPLE_RATE,
  onsetStrength,
  parseBeatAnalysis,
  rmsEnvelope,
  spaceKeyMoments,
} from "./beatAnalysis";

function clickTrack(intervalMs: number, durationMs: number): Float32Array {
  const samples = new Float32Array(Math.round((durationMs / 1000) * BEAT_SAMPLE_RATE));
  for (let t = intervalMs; t < durationMs; t += intervalMs) {
    const start = Math.round((t / 1000) * BEAT_SAMPLE_RATE);
    for (let j = 0; j < 512 && start + j < samples.length; j++) {
      samples[start + j] = 1 - j / 512;
    }
  }
  return samples;
}

function sine(amplitude: number, durationMs: number): Float32Array {
  const samples = new Float32Array(Math.round((durationMs / 1000) * BEAT_SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / BEAT_SAMPLE_RATE);
  }
  return samples;
}

describe("rmsEnvelope / onsetStrength", () => {
  it("normalises a constant signal to all ones", () => {
    const env = rmsEnvelope(new Float32Array(4096).fill(0.5));
    expect(env).toHaveLength(4);
    for (const v of env) expect(v).toBeCloseTo(1, 5);
  });

  it("keeps only rises", () => {
    expect(onsetStrength([0, 0.2, 1, 0.4])).toEqual([0, 0.2, 0.8, 0]);
  });
});

describe("analyseBeats on a click track", () => {
  const analysis = analyseBeats(clickTrack(500, 8000), BEAT_SAMPLE_RATE);

  it("finds the tempo near 120 BPM", () => {
    expect(analysis.bpm).not.toBeNull();
    expect(analysis.bpm ?? 0).toBeGreaterThan(115);
    expect(analysis.bpm ?? 0).toBeLessThan(125);
  });

  it("aligns the beat grid to the clicks", () => {
    for (const clickMs of [1000, 1500, 2000, 2500]) {
      const nearest = analysis.beats.reduce(
        (best, b) => Math.min(best, Math.abs(b - clickMs)),
        Number.POSITIVE_INFINITY,
      );
      expect(nearest).toBeLessThan(40);
    }
  });

  it("reports duration and a bounded envelope", () => {
    expect(analysis.durationMs).toBe(8000);
    for (const v of analysis.envelope.values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("analyseBeats on an energy step", () => {
  const quiet = sine(0.05, 4000);
  const loud = sine(0.8, 4000);
  const joined = new Float32Array(quiet.length + loud.length);
  joined.set(quiet);
  joined.set(loud, quiet.length);
  const analysis = analyseBeats(joined, BEAT_SAMPLE_RATE);

  it("marks a key moment at the step", () => {
    expect(analysis.keyMoments.length).toBeGreaterThan(0);
    const strongest = [...analysis.keyMoments].sort((m, n) => n.strength - m.strength)[0];
    expect(strongest.tMs).toBeGreaterThan(3500);
    expect(strongest.tMs).toBeLessThan(4500);
  });

  it("normalises strengths to 0..1", () => {
    for (const m of analysis.keyMoments) {
      expect(m.strength).toBeGreaterThan(0);
      expect(m.strength).toBeLessThanOrEqual(1);
    }
  });
});

describe("analyseBeats on silence", () => {
  const analysis = analyseBeats(new Float32Array(BEAT_SAMPLE_RATE * 2), BEAT_SAMPLE_RATE);

  it("degrades to an empty result", () => {
    expect(analysis.bpm).toBeNull();
    expect(analysis.beats).toEqual([]);
    expect(analysis.keyMoments).toEqual([]);
  });
});

describe("parseBeatAnalysis", () => {
  const analysis = analyseBeats(clickTrack(500, 4000), BEAT_SAMPLE_RATE);

  it("round-trips its own JSON", () => {
    expect(parseBeatAnalysis(JSON.stringify(analysis))).toEqual(analysis);
  });

  it("rejects junk, bad shapes and version bumps", () => {
    expect(parseBeatAnalysis("not json")).toBeNull();
    expect(parseBeatAnalysis(JSON.stringify({ ...analysis, version: 99 }))).toBeNull();
    expect(parseBeatAnalysis(JSON.stringify({ ...analysis, beats: ["x"] }))).toBeNull();
    expect(
      parseBeatAnalysis(JSON.stringify({ ...analysis, envelope: { hopMs: 0, values: [] } })),
    ).toBeNull();
  });
});

describe("spaceKeyMoments", () => {
  it("keeps the strongest of a cluster and returns time order", () => {
    const spaced = spaceKeyMoments([
      { tMs: 0, strength: 0.5 },
      { tMs: 500, strength: 1 },
      { tMs: 2100, strength: 0.3 },
    ]);
    expect(spaced.map((m) => m.tMs)).toEqual([500, 2100]);
  });
});
