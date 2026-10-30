import { describe, expect, it } from "vitest";
import { BEAT_ANALYSIS_VERSION, parseBeatAnalysis } from "./beatAnalysis";

/** A v3 document shaped like the native analyser's output. */
function songAnalysis(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    sha256: "ab".repeat(32),
    decoder: { name: "ffmpeg", version: "8.1.2", sampleRate: 48000, channels: 1 },
    tracker: "nn",
    model: { name: "beat_this_small", sha256: "cd".repeat(32) },
    fallbackReason: null,
    durationMs: 4000,
    fit: {
      bpm: 120.002,
      offsetMs: 1000.25,
      beatsPerBar: 4,
      periodMs: 499.99,
      phaseMs: 0.27,
      residualMs: 0.91,
      maxDriftMs: 1.2,
      constantTempo: true,
    },
    beats: [
      { ms: 0.27, bar: 0, beat: 3, conf: 0.4 },
      { ms: 500.26, bar: 0, beat: 4, conf: 0.6 },
      { ms: 1000.25, bar: 1, beat: 1, conf: 0.99 },
      { ms: 1500.24, bar: 1, beat: 2, conf: 0.97 },
    ],
    energy: {
      hopMs: 100,
      momentaryLufs: [-120.7, -14.2],
      shortTermLufs: [-120.7, -16],
      integratedLufs: -14.5,
      rangeLu: 3.1,
    },
    sections: [{ fromBar: 1, toBar: 9, novelty: 0 }],
    breaths: [{ fromMs: 3000, toMs: 3300, kind: "silence" }],
    stabs: { per16th: [1, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    hits: {
      full: [
        [1000.2, 0.9],
        [1500.1, 0.4],
      ],
      low: [[1000.2, 1]],
      mid: [],
      high: [],
    },
    lyrics: null,
    keyMoments: [{ tMs: 1000, strength: 0.9 }],
    envelope: { hopMs: 21.333, values: [0, 0.5, 1] },
    ...overrides,
  };
}

describe("parseBeatAnalysis", () => {
  it("reads a v3 document into the lane's shapes", () => {
    const parsed = parseBeatAnalysis(songAnalysis());
    expect(BEAT_ANALYSIS_VERSION).toBe(3);
    expect(parsed?.hits).toEqual([
      { ms: 1000.2, strength: 0.9 },
      { ms: 1500.1, strength: 0.4 },
    ]);
    expect(parsed).not.toBeNull();
    expect(parsed?.bpm).toBe(120.002);
    expect(parsed?.fit?.periodMs).toBe(499.99);
    expect(parsed?.fit?.constantTempo).toBe(true);
    expect(parsed?.beats).toEqual([0.27, 500.26, 1000.25, 1500.24]);
    expect(parsed?.downbeats).toEqual([1000.25]);
    expect(parsed?.beatInfo[2]).toEqual({ ms: 1000.25, bar: 1, beat: 1, conf: 0.99 });
    expect(parsed?.tracker).toBe("nn");
    expect(parsed?.energy?.integratedLufs).toBe(-14.5);
    expect(parsed?.sections).toHaveLength(1);
    expect(parsed?.breaths[0].kind).toBe("silence");
    expect(parsed?.stabs).toHaveLength(16);
    expect(parsed?.keyMoments).toEqual([{ tMs: 1000, strength: 0.9 }]);
    expect(parsed?.envelope.hopMs).toBe(21.333);
  });

  it("accepts the cached JSON text as well as the command's object", () => {
    const doc = songAnalysis();
    expect(parseBeatAnalysis(JSON.stringify(doc))).toEqual(parseBeatAnalysis(doc));
    expect(parseBeatAnalysis("not json")).toBeNull();
  });

  it("rejects the unrefined v1 payload and any other version", () => {
    const v1 = {
      version: 1,
      durationMs: 4000,
      bpm: 120,
      beats: [500, 1000],
      keyMoments: [],
      envelope: { hopMs: 21.333, values: [] },
    };
    expect(parseBeatAnalysis(v1)).toBeNull();
    expect(parseBeatAnalysis(songAnalysis({ version: 4 }))).toBeNull();
    expect(parseBeatAnalysis(null)).toBeNull();
    expect(parseBeatAnalysis([songAnalysis()])).toBeNull();
  });

  it("rejects bad core fields", () => {
    expect(parseBeatAnalysis(songAnalysis({ beats: [500] }))).toBeNull();
    expect(parseBeatAnalysis(songAnalysis({ beats: [{ ms: "x", bar: 1, beat: 1 }] }))).toBeNull();
    expect(parseBeatAnalysis(songAnalysis({ tracker: "madmom" }))).toBeNull();
    expect(parseBeatAnalysis(songAnalysis({ fit: { bpm: 120 } }))).toBeNull();
    expect(parseBeatAnalysis(songAnalysis({ envelope: { hopMs: 0, values: [] } }))).toBeNull();
    expect(parseBeatAnalysis(songAnalysis({ keyMoments: [{ tMs: 1 }] }))).toBeNull();
  });

  it("degrades without a grid or the descriptive extras", () => {
    const parsed = parseBeatAnalysis(
      songAnalysis({
        tracker: "dsp",
        fallbackReason: "the beat-this model is unavailable",
        fit: null,
        beats: [],
        energy: null,
        sections: "x",
        breaths: [{ fromMs: 1, toMs: 2, kind: "gasp" }],
        stabs: null,
        lyrics: { source: "tag:lyrics-eng", lang: "eng", text: "placeholder" },
      }),
    );
    expect(parsed?.bpm).toBeNull();
    expect(parsed?.fit).toBeNull();
    expect(parsed?.beats).toEqual([]);
    expect(parsed?.fallbackReason).toBe("the beat-this model is unavailable");
    expect(parsed?.energy).toBeNull();
    expect(parsed?.sections).toEqual([]);
    expect(parsed?.breaths).toEqual([]);
    expect(parsed?.stabs).toEqual([]);
    expect(parsed?.lyrics).toEqual({ source: "tag:lyrics-eng", lang: "eng", text: "placeholder" });
  });
});
