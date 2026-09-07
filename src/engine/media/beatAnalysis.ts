/** Pure beat/key-moment analysis over decoded PCM. Editor guidance only: the export path never reads any of this. Best effort by design; the manifest marker overlay is the correction path. All functions are deterministic over their inputs so vitest covers them with synthetic signals. */

export const BEAT_ANALYSIS_VERSION = 1;
/** Decode rate is pinned so results do not depend on the output device. */
export const BEAT_SAMPLE_RATE = 48_000;
/** Samples per waveform-display hop (~21.3ms at 48k). */
export const ENVELOPE_HOP = 1024;
/** Finer hop for onset/tempo work: a coarse hop quantises beat periods badly. */
export const ONSET_HOP = 256;

const MIN_BPM = 60;
const MAX_BPM = 180;
/** Key moments closer together than this collapse to the strongest. */
export const KEY_MOMENT_MIN_GAP_MS = 1500;

export interface BeatKeyMoment {
  tMs: number;
  strength: number;
}

export interface BeatAnalysis {
  version: number;
  durationMs: number;
  bpm: number | null;
  beats: number[];
  keyMoments: BeatKeyMoment[];
  envelope: { hopMs: number; values: number[] };
}

/** Peak-normalised RMS envelope, one value per hop, 0..1. */
export function rmsEnvelope(samples: Float32Array, hop = ENVELOPE_HOP): number[] {
  const hops = Math.floor(samples.length / hop);
  const env = new Array<number>(hops);
  let max = 0;
  for (let i = 0; i < hops; i++) {
    let sum = 0;
    const base = i * hop;
    for (let j = 0; j < hop; j++) {
      const s = samples[base + j];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / hop);
    env[i] = rms;
    if (rms > max) max = rms;
  }
  if (max > 0) for (let i = 0; i < hops; i++) env[i] /= max;
  return env;
}

/** Half-wave rectified rise of the envelope: energy arriving, the onset signal. */
export function onsetStrength(envelope: number[]): number[] {
  const out = new Array<number>(envelope.length).fill(0);
  for (let i = 1; i < envelope.length; i++) {
    out[i] = Math.max(0, envelope[i] - envelope[i - 1]);
  }
  return out;
}

/** Triangular smoothing so near-hop-boundary onsets still correlate across periods. */
export function smooth3(values: number[]): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const prev = values[i - 1] ?? values[i];
    const next = values[i + 1] ?? values[i];
    out[i] = 0.25 * prev + 0.5 * values[i] + 0.25 * next;
  }
  return out;
}

/** Indices that are local maxima above a sliding mean threshold. */
export function pickOnsetPeaks(strength: number[], windowHops: number, bias = 1.5): number[] {
  const peaks: number[] = [];
  for (let i = 1; i < strength.length - 1; i++) {
    const s = strength[i];
    if (s <= 0 || s < strength[i - 1] || s <= strength[i + 1]) continue;
    const lo = Math.max(0, i - windowHops);
    const hi = Math.min(strength.length, i + windowHops);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += strength[j];
    const mean = sum / (hi - lo);
    if (s > mean * bias + 0.005) peaks.push(i);
  }
  return peaks;
}

/** Dominant tempo via autocorrelation of onset strength with a log-Gaussian prior near 120 BPM, parabolic-refined; null when nothing periodic stands out. */
export function estimateTempo(strength: number[], hopMs: number): number | null {
  const minLag = Math.max(2, Math.floor(60_000 / (MAX_BPM * hopMs)));
  const maxLag = Math.min(strength.length - 1, Math.ceil(60_000 / (MIN_BPM * hopMs)));
  if (maxLag <= minLag) return null;
  let energy = 0;
  for (const s of strength) energy += s * s;
  if (energy <= 0) return null;
  const acfLen = Math.min(strength.length - 1, maxLag * 2);
  const acf = new Array<number>(acfLen + 1).fill(0);
  for (let lag = minLag; lag <= acfLen; lag++) {
    let sum = 0;
    for (let i = lag; i < strength.length; i++) sum += strength[i] * strength[i - lag];
    acf[lag] = sum / energy;
  }
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const doubled = lag * 2 <= acfLen ? acf[lag * 2] : 0;
    const prior = Math.exp(-0.5 * Math.log2((lag * hopMs) / 500) ** 2);
    const score = (acf[lag] + 0.5 * doubled) * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestScore < 0.05) return null;
  let lag = bestLag;
  const a = acf[bestLag - 1] ?? 0;
  const b = acf[bestLag];
  const c = acf[bestLag + 1] ?? 0;
  const denom = a - 2 * b + c;
  if (denom < 0) lag += (0.5 * (a - c)) / denom;
  return 60_000 / (lag * hopMs);
}

/** Regular beat grid phase-aligned to where onsets actually land. */
export function alignBeatGrid(
  strength: number[],
  hopMs: number,
  bpm: number,
  durationMs: number,
): number[] {
  const periodMs = 60_000 / bpm;
  const step = hopMs / 2;
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = 0; offset < periodMs; offset += step) {
    let score = 0;
    for (let t = offset; t < durationMs; t += periodMs) {
      const hop = Math.round(t / hopMs);
      if (hop < strength.length) score += strength[hop];
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  const beats: number[] = [];
  for (let t = bestOffset; t < durationMs; t += periodMs) beats.push(Math.round(t));
  return beats;
}

/** Section-change signal: absolute difference of mean energy across adjacent ~2s windows. */
export function noveltyCurve(envelope: number[], hopMs: number, windowMs = 2000): number[] {
  const w = Math.max(1, Math.round(windowMs / hopMs));
  const out = new Array<number>(envelope.length).fill(0);
  if (envelope.length < w * 2) return out;
  const prefix = new Array<number>(envelope.length + 1).fill(0);
  for (let i = 0; i < envelope.length; i++) prefix[i + 1] = prefix[i] + envelope[i];
  for (let i = w; i <= envelope.length - w; i++) {
    const before = (prefix[i] - prefix[i - w]) / w;
    const after = (prefix[i + w] - prefix[i]) / w;
    out[i] = Math.abs(after - before);
  }
  return out;
}

function localMaxima(curve: number[], threshold: number, minGapHops: number): number[] {
  const picked: number[] = [];
  for (let i = 1; i < curve.length - 1; i++) {
    if (curve[i] < threshold || curve[i] < curve[i - 1] || curve[i] <= curve[i + 1]) continue;
    if (picked.length > 0 && i - picked[picked.length - 1] < minGapHops) {
      if (curve[i] > curve[picked[picked.length - 1]]) picked[picked.length - 1] = i;
      continue;
    }
    picked.push(i);
  }
  return picked;
}

/** Greedy strongest-first spacing filter, returned in time order. */
export function spaceKeyMoments(
  moments: BeatKeyMoment[],
  minGapMs = KEY_MOMENT_MIN_GAP_MS,
): BeatKeyMoment[] {
  const byStrength = [...moments].sort((m, n) => n.strength - m.strength);
  const kept: BeatKeyMoment[] = [];
  for (const m of byStrength) {
    if (kept.every((k) => Math.abs(k.tMs - m.tMs) >= minGapMs)) kept.push(m);
  }
  return kept.sort((m, n) => m.tMs - n.tMs);
}

/** Key moments: strong onsets plus energy-shift novelty peaks, spaced and strength-normalised. */
export function detectKeyMoments(
  envelope: number[],
  strength: number[],
  hopMs: number,
): BeatKeyMoment[] {
  const candidates: BeatKeyMoment[] = [];
  const peaks = pickOnsetPeaks(strength, Math.max(2, Math.round(500 / hopMs)));
  let maxOnset = 0;
  for (const p of peaks) maxOnset = Math.max(maxOnset, strength[p]);
  if (maxOnset > 0) {
    for (const p of peaks) {
      const rel = strength[p] / maxOnset;
      if (rel >= 0.5) candidates.push({ tMs: Math.round(p * hopMs), strength: rel });
    }
  }
  const novelty = noveltyCurve(envelope, hopMs);
  const maxNovelty = novelty.reduce((m, v) => Math.max(m, v), 0);
  if (maxNovelty > 0.05) {
    const gap = Math.max(1, Math.round(KEY_MOMENT_MIN_GAP_MS / hopMs));
    for (const i of localMaxima(novelty, maxNovelty * 0.35, gap)) {
      candidates.push({ tMs: Math.round(i * hopMs), strength: novelty[i] / maxNovelty });
    }
  }
  return spaceKeyMoments(candidates).map((m) => ({
    tMs: m.tMs,
    strength: Math.round(m.strength * 1000) / 1000,
  }));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate a cached analysis payload; anything off (wrong version, bad shape) is null, the caller re-analyses. */
export function parseBeatAnalysis(text: string): BeatAnalysis | null {
  try {
    const v = JSON.parse(text) as Partial<BeatAnalysis> | null;
    if (!v || v.version !== BEAT_ANALYSIS_VERSION || !isFiniteNumber(v.durationMs)) return null;
    if (!Array.isArray(v.beats) || !v.beats.every(isFiniteNumber)) return null;
    const moments = v.keyMoments;
    if (
      !Array.isArray(moments) ||
      !moments.every((m) => m && isFiniteNumber(m.tMs) && isFiniteNumber(m.strength))
    ) {
      return null;
    }
    const env = v.envelope;
    if (!env || !isFiniteNumber(env.hopMs) || env.hopMs <= 0) return null;
    if (!Array.isArray(env.values) || !env.values.every(isFiniteNumber)) return null;
    return {
      version: v.version,
      durationMs: v.durationMs,
      bpm: isFiniteNumber(v.bpm) ? v.bpm : null,
      beats: v.beats,
      keyMoments: moments,
      envelope: { hopMs: env.hopMs, values: env.values },
    };
  } catch {
    return null;
  }
}

/** Full analysis over mono PCM at `sampleRate`. Silence degrades to an empty result, never throws. */
export function analyseBeats(samples: Float32Array, sampleRate: number): BeatAnalysis {
  const displayHopMs = (ENVELOPE_HOP / sampleRate) * 1000;
  const hopMs = (ONSET_HOP / sampleRate) * 1000;
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  const display = rmsEnvelope(samples, ENVELOPE_HOP);
  const fine = rmsEnvelope(samples, ONSET_HOP);
  const strength = smooth3(onsetStrength(fine));
  const bpm = estimateTempo(strength, hopMs);
  const beats = bpm ? alignBeatGrid(strength, hopMs, bpm, durationMs) : [];
  const keyMoments = detectKeyMoments(fine, strength, hopMs);
  return {
    version: BEAT_ANALYSIS_VERSION,
    durationMs,
    bpm: bpm ? Math.round(bpm * 10) / 10 : null,
    beats,
    keyMoments,
    envelope: {
      hopMs: Math.round(displayHopMs * 1000) / 1000,
      values: display.map((v) => Math.round(v * 1000) / 1000),
    },
  };
}
