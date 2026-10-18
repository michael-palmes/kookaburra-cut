import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BeatAnalysis } from "../../engine/beatAnalysis";
import type { ProjectAudio } from "../../engine/project";
import { BeatGridGroup, BeatGridRows, detectedGridLabel, MusicDrillIn } from "./MusicDrillIn";

const analysis: BeatAnalysis = {
  version: 2,
  sha256: "sha",
  tracker: "nn",
  fallbackReason: null,
  durationMs: 60000,
  bpm: 128,
  fit: {
    bpm: 128,
    offsetMs: 312.5,
    beatsPerBar: 4,
    periodMs: 468.75,
    phaseMs: 312.5,
    residualMs: 0.94,
    maxDriftMs: 22,
    constantTempo: false,
  },
  beats: [],
  beatInfo: [],
  downbeats: [],
  keyMoments: [],
  envelope: { hopMs: 21.333, values: [] },
  energy: null,
  sections: [],
  breaths: [],
  stabs: [],
  lyrics: null,
};

const audio = (over: Partial<ProjectAudio> = {}): ProjectAudio => ({
  file: "assets/track.mp3",
  abs: "/Users/x/track.mp3",
  durationMs: 60000,
  sampleRate: 48000,
  ...over,
});

describe("Music drill Beat grid group", () => {
  it("joins the drill once a track is loaded", () => {
    const html = renderToStaticMarkup(
      <MusicDrillIn
        audio={audio()}
        onBack={vi.fn()}
        onChooseTrack={vi.fn()}
        onRemoveTrack={vi.fn()}
        onPatch={vi.fn()}
        onPreview={vi.fn()}
      />,
    );
    expect(html).toContain(">Beat grid<");
  });

  const rows = (a: ProjectAudio, status: "ready" | "analysing" = "ready") =>
    renderToStaticMarkup(
      <BeatGridRows audio={a} status={status} analysis={analysis} onPatch={vi.fn()} />,
    );

  it("without a grid, offers the detected one and explains why a grid matters", () => {
    const html = rows(audio());
    expect(html).toContain("Use detected grid");
    expect(html).toContain("128.000 BPM, 0.9 ms off");
    expect(html).toContain("need a grid");
    expect(html).not.toContain("Clear grid");
    expect(html).not.toContain(">BPM<");
    expect(html).toContain("drifts by up to 22 ms");
  });

  it("reads the analysis from the beat store", () => {
    const html = renderToStaticMarkup(<BeatGridGroup audio={audio()} onPatch={vi.fn()} />);
    expect(html).toMatch(
      /Use detected grid<\/span><span class="action-row-value"[^>]*>No steady tempo found/,
    );
  });

  it("with a grid, shows tempo to 3 dp, x2 and /2, meter, bar 1 and Clear, each with a leading icon", () => {
    const html = rows(audio({ grid: { bpm: 135.11, offsetMs: 101.7, beatsPerBar: 3 } }));
    expect(html).toContain("135.110");
    expect(html).toContain("0.102s");
    const svg = String.raw`<svg[^>]*>(?:(?!</svg>)[\s\S])*</svg>`;
    for (const label of ["BPM", "Beats per bar", "Bar 1 at"]) {
      expect(html).toMatch(new RegExp(`inspector-slider-row-icon">${svg}</span>${label}<`));
    }
    for (const label of ["Use detected grid", "Clear grid"]) {
      expect(html).toMatch(
        new RegExp(`action-row-icon">${svg}</span><span class="action-row-label">${label}<`),
      );
    }
    for (const [aria, text] of [
      ["Double the tempo", "×2"],
      ["Halve the tempo", "÷2"],
    ]) {
      expect(html).toMatch(new RegExp(`aria-label="${aria}">${svg}${text}<`));
    }
  });

  it("disables x2 past 300 BPM and /2 under 30", () => {
    expect(rows(audio({ grid: { bpm: 200, offsetMs: 0 } }))).toMatch(
      /aria-label="Double the tempo" disabled=""/,
    );
    expect(rows(audio({ grid: { bpm: 50, offsetMs: 0 } }))).toMatch(
      /aria-label="Halve the tempo" disabled=""/,
    );
  });

  it("labels the detected grid by analysis state", () => {
    expect(detectedGridLabel("analysing", null)).toBe("Analysing…");
    expect(detectedGridLabel("error", null)).toBe("Analysis failed");
    expect(detectedGridLabel("ready", { ...analysis, fit: null })).toBe("No steady tempo found");
  });
});
