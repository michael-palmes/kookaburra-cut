import type { BeatAnalysis } from "./beatAnalysis";
import type { AudioGridSpec } from "./project";

/** The authored-grid edits behind the Music drill's Beat grid group and the beat lane's menu, pure so the UI only picks one and writes it. Times are track ms (`offsetMs` is bar 1 beat 1 in the decoded file); every result is a whole `audio.grid` or null when the edit can't apply. */

export const GRID_BPM_MIN = 30;
export const GRID_BPM_MAX = 300;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

const barMsOf = (bpm: number, beatsPerBar: number) => (beatsPerBar * 60000) / bpm;

/** The analysis's fitted grid as an authored one, its provenance recorded; null when nothing periodic was found or the fit falls outside what a grid accepts. */
export function detectedGrid(analysis: BeatAnalysis | null): AudioGridSpec | null {
  const fit = analysis?.fit;
  if (!analysis || !fit) return null;
  if (!(fit.bpm >= GRID_BPM_MIN && fit.bpm <= GRID_BPM_MAX)) return null;
  const beatsPerBar =
    Number.isInteger(fit.beatsPerBar) && fit.beatsPerBar >= 1 && fit.beatsPerBar <= 16
      ? fit.beatsPerBar
      : 4;
  return {
    bpm: round3(fit.bpm),
    offsetMs: round3(fit.offsetMs),
    beatsPerBar,
    source: {
      sha256: analysis.sha256,
      analysisVersion: analysis.version,
      tracker: analysis.tracker,
      residualMs: fit.residualMs,
    },
  };
}

/** A new tempo keeps bar 1 where it is; the provenance goes, since the grid no longer matches what was analysed. */
export function withGridBpm(grid: AudioGridSpec, bpm: number): AudioGridSpec | null {
  if (!(bpm >= GRID_BPM_MIN && bpm <= GRID_BPM_MAX)) return null;
  const { source: _source, ...rest } = grid;
  return { ...rest, bpm: round3(bpm) };
}

/** The tempo the analysis or the authored grid would start from (the fit, else the raw estimate). */
function startingGrid(grid: AudioGridSpec | undefined, analysis: BeatAnalysis | null) {
  if (grid) return { bpm: grid.bpm, offsetMs: grid.offsetMs, beatsPerBar: grid.beatsPerBar ?? 4 };
  const detected = detectedGrid(analysis);
  if (detected) return { ...detected, beatsPerBar: detected.beatsPerBar ?? 4 };
  const bpm = analysis?.bpm;
  if (typeof bpm !== "number" || !(bpm >= GRID_BPM_MIN && bpm <= GRID_BPM_MAX)) return null;
  return { bpm, offsetMs: analysis?.downbeats[0] ?? 0, beatsPerBar: 4 };
}

/** "Set downbeat here": the nearest bar line moves to `trackMs` and every bar keeps its number (phase only). Without a grid it starts one from the detected tempo with that phase. */
export function setDownbeatGrid(
  grid: AudioGridSpec | undefined,
  analysis: BeatAnalysis | null,
  trackMs: number,
): AudioGridSpec | null {
  const base = startingGrid(grid, analysis);
  if (!base) return null;
  const barMs = barMsOf(base.bpm, base.beatsPerBar);
  const k = Math.round((trackMs - base.offsetMs) / barMs);
  return {
    ...(grid ?? detectedGrid(analysis) ?? {}),
    bpm: round3(base.bpm),
    beatsPerBar: base.beatsPerBar,
    offsetMs: round3(trackMs - k * barMs),
  };
}

/** "Make this bar 1": the downbeat nearest `trackMs` (the grid's, else the analysis's) becomes bar 1 beat 1. */
export function makeBarOneGrid(
  grid: AudioGridSpec | undefined,
  analysis: BeatAnalysis | null,
  trackMs: number,
): AudioGridSpec | null {
  const base = startingGrid(grid, analysis);
  if (!base) return null;
  let downbeat: number;
  if (!grid && analysis?.downbeats.length) {
    downbeat = analysis.downbeats.reduce((best, t) =>
      Math.abs(t - trackMs) < Math.abs(best - trackMs) ? t : best,
    );
  } else {
    const barMs = barMsOf(base.bpm, base.beatsPerBar);
    downbeat = base.offsetMs + Math.round((trackMs - base.offsetMs) / barMs) * barMs;
  }
  return {
    ...(grid ?? detectedGrid(analysis) ?? {}),
    bpm: round3(base.bpm),
    beatsPerBar: base.beatsPerBar,
    offsetMs: round3(downbeat),
  };
}
