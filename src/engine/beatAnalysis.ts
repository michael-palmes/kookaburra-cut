/** Song analysis as the native analyser writes it (`src-tauri/src/song/`, cached as `<sha>-v3.json`): ffmpeg decode, beat-this or the DSP fit, refined against the track's own onsets. Editor and agent guidance only: the export path never reads any of this. This module validates the payload and shapes it for the lanes; anything off is null and the caller shows the error chip. */

export const BEAT_ANALYSIS_VERSION = 3;

export type BeatTracker = "nn" | "dsp";

export interface BeatKeyMoment {
  tMs: number;
  strength: number;
}

/** The fitted grid. `offsetMs` is track ms of bar 1 beat 1 (ffmpeg decode); `constantTempo` is false when the beats wander more than one frame at 30 fps (33 ms) off one line. */
export interface BeatFit {
  bpm: number;
  offsetMs: number;
  beatsPerBar: number;
  periodMs: number;
  phaseMs: number;
  residualMs: number;
  maxDriftMs: number;
  constantTempo: boolean;
}

/** One beat: track ms, 1-based bar (0 = pickup) and beat, tracker confidence 0..1. */
export interface BeatInfo {
  ms: number;
  bar: number;
  beat: number;
  conf: number;
}

export interface SongSection {
  fromBar: number;
  /** Exclusive: the next section's first bar. */
  toBar: number;
  novelty: number;
}

export interface SongBreath {
  fromMs: number;
  toMs: number;
  kind: "silence" | "dip";
}

/** ebur128 every `hopMs`: value i closes the window ending at (i + 1) × hopMs. */
export interface SongEnergy {
  hopMs: number;
  momentaryLufs: number[];
  shortTermLufs: number[];
  integratedLufs: number | null;
  rangeLu: number | null;
}

/** One strong onset of the full band: track ms, strength 0..1 (the band's 99th-percentile peak is 1). */
export interface SongHit {
  ms: number;
  strength: number;
}

export interface SongLyrics {
  source: string;
  lang: string | null;
  text: string;
}

export interface BeatAnalysis {
  version: number;
  sha256: string;
  tracker: BeatTracker;
  /** Why the model did not run, when the DSP fit stood in for it. */
  fallbackReason: string | null;
  durationMs: number;
  /** The fitted tempo (3 dp); null when nothing periodic stands out. */
  bpm: number | null;
  fit: BeatFit | null;
  /** Track ms of every beat: the lanes' grid. */
  beats: number[];
  beatInfo: BeatInfo[];
  /** Track ms of each bar's first beat. */
  downbeats: number[];
  keyMoments: BeatKeyMoment[];
  envelope: { hopMs: number; values: number[] };
  energy: SongEnergy | null;
  sections: SongSection[];
  breaths: SongBreath[];
  /** Hits per bar position in 16ths (16 in 4/4), the busiest slot 1. */
  stabs: number[];
  /** The full band's strong onsets, in time order: the lane's ticks. */
  hits: SongHit[];
  lyrics: SongLyrics | null;
}

type Obj = Record<string, unknown>;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numbers(v: unknown): number[] | null {
  return Array.isArray(v) && v.every(isFiniteNumber) ? v : null;
}

function parseFit(v: unknown): BeatFit | null | undefined {
  if (v === null) return null;
  if (!isObj(v)) return undefined;
  const keys = [
    "bpm",
    "offsetMs",
    "beatsPerBar",
    "periodMs",
    "phaseMs",
    "residualMs",
    "maxDriftMs",
  ];
  if (!keys.every((k) => isFiniteNumber(v[k])) || typeof v.constantTempo !== "boolean") {
    return undefined;
  }
  if ((v.periodMs as number) <= 0 || (v.beatsPerBar as number) < 1) return undefined;
  return {
    bpm: v.bpm as number,
    offsetMs: v.offsetMs as number,
    beatsPerBar: v.beatsPerBar as number,
    periodMs: v.periodMs as number,
    phaseMs: v.phaseMs as number,
    residualMs: v.residualMs as number,
    maxDriftMs: v.maxDriftMs as number,
    constantTempo: v.constantTempo,
  };
}

function parseBeat(v: unknown): BeatInfo | null {
  if (!isObj(v)) return null;
  const { ms, bar, beat, conf } = v;
  if (!isFiniteNumber(ms) || !isFiniteNumber(bar) || !isFiniteNumber(beat)) return null;
  return { ms, bar, beat, conf: isFiniteNumber(conf) ? conf : 0 };
}

function parseEnergy(v: unknown): SongEnergy | null {
  if (!isObj(v) || !isFiniteNumber(v.hopMs) || v.hopMs <= 0) return null;
  const momentary = numbers(v.momentaryLufs);
  const shortTerm = numbers(v.shortTermLufs);
  if (!momentary || !shortTerm) return null;
  return {
    hopMs: v.hopMs,
    momentaryLufs: momentary,
    shortTermLufs: shortTerm,
    integratedLufs: isFiniteNumber(v.integratedLufs) ? v.integratedLufs : null,
    rangeLu: isFiniteNumber(v.rangeLu) ? v.rangeLu : null,
  };
}

function parseSections(v: unknown): SongSection[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (s): s is SongSection =>
        isObj(s) &&
        isFiniteNumber(s.fromBar) &&
        isFiniteNumber(s.toBar) &&
        isFiniteNumber(s.novelty) &&
        s.fromBar < s.toBar,
    )
    .map((s) => ({ fromBar: s.fromBar, toBar: s.toBar, novelty: s.novelty }));
}

function parseBreaths(v: unknown): SongBreath[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (b): b is SongBreath =>
        isObj(b) &&
        isFiniteNumber(b.fromMs) &&
        isFiniteNumber(b.toMs) &&
        (b.kind === "silence" || b.kind === "dip"),
    )
    .map((b) => ({ fromMs: b.fromMs, toMs: b.toMs, kind: b.kind }));
}

function parseHits(v: unknown): SongHit[] {
  const full = isObj(v) ? v.full : null;
  if (!Array.isArray(full)) return [];
  return full
    .filter(
      (h): h is [number, number] =>
        Array.isArray(h) && isFiniteNumber(h[0]) && isFiniteNumber(h[1]),
    )
    .map(([ms, strength]) => ({ ms, strength }));
}

function parseLyrics(v: unknown): SongLyrics | null {
  if (!isObj(v) || typeof v.source !== "string" || typeof v.text !== "string") return null;
  return { source: v.source, lang: typeof v.lang === "string" ? v.lang : null, text: v.text };
}

/** Validate a song analysis (the `song_analysis` result, or its cached JSON text). A wrong version or a bad core field (duration, beats, key moments, envelope, fit) is null; the descriptive extras degrade to empty. */
export function parseBeatAnalysis(input: unknown): BeatAnalysis | null {
  let v: unknown = input;
  if (typeof input === "string") {
    try {
      v = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isObj(v) || v.version !== BEAT_ANALYSIS_VERSION || !isFiniteNumber(v.durationMs)) {
    return null;
  }
  if (v.tracker !== "nn" && v.tracker !== "dsp") return null;
  const fit = parseFit(v.fit);
  if (fit === undefined) return null;
  if (!Array.isArray(v.beats)) return null;
  const beatInfo = v.beats.map(parseBeat);
  if (!beatInfo.every((b): b is BeatInfo => b !== null)) return null;
  const moments = v.keyMoments;
  if (
    !Array.isArray(moments) ||
    !moments.every((m) => isObj(m) && isFiniteNumber(m.tMs) && isFiniteNumber(m.strength))
  ) {
    return null;
  }
  const env = v.envelope;
  if (!isObj(env) || !isFiniteNumber(env.hopMs) || env.hopMs <= 0) return null;
  const values = numbers(env.values);
  if (!values) return null;
  const stabs = isObj(v.stabs) ? numbers(v.stabs.per16th) : null;
  return {
    version: v.version,
    sha256: typeof v.sha256 === "string" ? v.sha256 : "",
    tracker: v.tracker,
    fallbackReason: typeof v.fallbackReason === "string" ? v.fallbackReason : null,
    durationMs: v.durationMs,
    bpm: fit?.bpm ?? null,
    fit,
    beats: beatInfo.map((b) => b.ms),
    beatInfo,
    downbeats: beatInfo.filter((b) => b.beat === 1).map((b) => b.ms),
    keyMoments: (moments as BeatKeyMoment[]).map((m) => ({ tMs: m.tMs, strength: m.strength })),
    envelope: { hopMs: env.hopMs, values },
    energy: parseEnergy(v.energy),
    sections: parseSections(v.sections),
    breaths: parseBreaths(v.breaths),
    stabs: stabs ?? [],
    hits: parseHits(v.hits),
    lyrics: parseLyrics(v.lyrics),
  };
}
