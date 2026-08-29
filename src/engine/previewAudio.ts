/** Preview playback of the project soundtrack; UI lane only, the export mux (start_export) is the authoritative mixdown. Uses a decoded WebAudio `AudioBuffer` (not an `HTMLAudioElement`) because WebKit seeks VBR MP3s by byte-estimate, often 120ms+ off target, causing audible play-stop-play stutter; a buffer source starts sample-exact and position is pure `ctx.currentTime` arithmetic, so steady play needs no correction. Sync: play/pause follows the transport, target position derives from the clock, and the source restarts only on a genuine clock jump (drift > 250ms, e.g. a scrub or the play-loop wraparound). Nothing plays while `isExporting()`; the AudioContext resumes on the first play (a user gesture, WKWebView autoplay policy). */

import { useClockStore } from "./clock";
import { isExporting } from "./exportState";
import { fsUrl } from "./media";
import type { AudioFadeCurve, LoadedProject, ProjectAudio } from "./project";

const DRIFT_RESTART_S = 0.25;

interface ActiveSource {
  source: AudioBufferSourceNode;
  /** ctx.currentTime at start; position = offset + (ctx.currentTime − at). */
  at: number;
  offset: number;
}

interface PreviewAudioState {
  audio: ProjectAudio;
  projectTotalMs: number;
  ctx: AudioContext;
  gain: GainNode;
  /** Null until the one-off fetch+decode lands (or fails; stays null, degrades silent). */
  buffer: AudioBuffer | null;
  started: ActiveSource | null;
  unsubscribe: () => void;
}

let state: PreviewAudioState | null = null;
let wantPlaying = false;
let muted = false;

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));

/** afade's `curve=qsin`, the mux's fade-in shape, mirrored so preview ≈ export. */
function qsin(t: number): number {
  return Math.sin((Math.PI / 2) * clamp01(t));
}

/** afade's gain curves (ffmpeg af_afade fade_gain), mirrored per fade-out shape so preview ≈ export. */
const FADE_OUT_CURVES: Record<AudioFadeCurve, (t: number) => number> = {
  smooth: qsin,
  linear: clamp01,
  scurve: (t) => (1 - Math.cos(Math.PI * clamp01(t))) / 2,
  exponential: (t) => 0.1 ** ((1 - clamp01(t)) * 5),
  logarithmic: (t) => clamp01(1 + 0.2 * Math.log10(clamp01(t))),
};

/** Where the soundtrack stops being heard: the earlier of the timeline's end and the track running out (post-offset); the fade-out anchors here, the mux's rule. */
function audibleEndMs(a: ProjectAudio, totalMs: number): number {
  return Math.min(totalMs, Math.max(0, a.durationMs - (a.startOffsetMs ?? 0)));
}

function envelope(a: ProjectAudio, totalMs: number, tMs: number): number {
  const base = 10 ** ((a.gainDb ?? 0) / 20);
  const fadeIn = a.fadeInMs ? qsin(tMs / a.fadeInMs) : 1;
  const curve = FADE_OUT_CURVES[a.fadeOutCurve ?? "smooth"] ?? qsin;
  const fadeOut = a.fadeOutMs ? curve((audibleEndMs(a, totalMs) - tMs) / a.fadeOutMs) : 1;
  return muted ? 0 : base * fadeIn * fadeOut;
}

function targetPositionS(s: PreviewAudioState, tMs: number): number {
  return (tMs + (s.audio.startOffsetMs ?? 0)) / 1000;
}

function stopSource(s: PreviewAudioState): void {
  const active = s.started;
  if (!active) return;
  s.started = null;
  try {
    active.source.stop();
  } catch {
    // Already ended; stop() on a finished source throws in some WebKit builds.
  }
  active.source.disconnect();
}

/** Start a fresh one-shot source at the given track position (silence past the end; the project may outlast the track, the mux pads with apad, we just play nothing). */
function startSource(s: PreviewAudioState, offsetS: number): void {
  if (!s.buffer || offsetS < 0 || offsetS >= s.buffer.duration) return;
  const source = s.ctx.createBufferSource();
  source.buffer = s.buffer;
  source.connect(s.gain);
  source.onended = () => {
    // Natural end-of-track while the project plays on; ignore if already replaced.
    if (state === s && s.started?.source === source) s.started = null;
  };
  source.start(0, offsetS);
  s.started = { source, at: s.ctx.currentTime, offset: offsetS };
}

function applyTick(s: PreviewAudioState): void {
  if (isExporting()) {
    stopSource(s);
    return;
  }
  const tMs = useClockStore.getState().currentMs;
  s.gain.gain.value = envelope(s.audio, s.projectTotalMs, tMs);
  if (!wantPlaying || !s.buffer) return;
  const target = targetPositionS(s, tMs);
  if (s.started) {
    const position = s.started.offset + (s.ctx.currentTime - s.started.at);
    if (Math.abs(position - target) > DRIFT_RESTART_S) {
      stopSource(s);
      startSource(s, target);
    }
  } else if (target < s.buffer.duration) {
    // Back inside the track after a wraparound/scrub (or the decode just landed).
    startSource(s, target);
  }
}

function teardown(): void {
  if (!state) return;
  state.unsubscribe();
  stopSource(state);
  void state.ctx.close().catch(() => {});
  state = null;
}

/** Point the preview soundtrack at a freshly-loaded project (or none). Never plays here. */
export function setPreviewAudioProject(project: LoadedProject | null): void {
  teardown();
  wantPlaying = false;
  if (!project?.audio) return;
  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const s: PreviewAudioState = {
    audio: project.audio,
    projectTotalMs: project.totalMs,
    ctx,
    gain,
    buffer: null,
    started: null,
    unsubscribe: useClockStore.subscribe((curr, prev) => {
      if (curr.currentMs !== prev.currentMs && state === s) applyTick(s);
    }),
  };
  state = s;
  void (async () => {
    try {
      const bytes = await (await fetch(fsUrl(s.audio.abs))).arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      if (state !== s) return; // project switched mid-decode
      s.buffer = buffer;
      if (wantPlaying && !isExporting()) applyTick(s); // play pressed while decoding
    } catch (e) {
      console.warn("[audio] preview decode failed (preview stays silent):", e);
    }
  })();
}

/** Live-update the mix params (gain, fades, offset) without re-decoding: the Music drill's slider-drag lane. No-op without a loaded soundtrack. */
export function updatePreviewAudioSpec(audio: ProjectAudio): void {
  const s = state;
  if (!s) return;
  s.audio = audio;
  applyTick(s);
}

/** Follow the transport. Safe to call redundantly; a no-audio project is a no-op. */
export function syncPreviewAudioPlaying(playing: boolean): void {
  wantPlaying = playing && !isExporting();
  const s = state;
  if (!s) return;
  if (!wantPlaying) {
    stopSource(s);
    return;
  }
  void s.ctx.resume().catch(() => {});
  const tMs = useClockStore.getState().currentMs;
  s.gain.gain.value = envelope(s.audio, s.projectTotalMs, tMs);
  stopSource(s);
  startSource(s, targetPositionS(s, tMs));
}

/** UI mute (preview-only; the export mix is unaffected). */
export function setPreviewAudioMuted(m: boolean): void {
  muted = m;
  if (state)
    state.gain.gain.value = envelope(
      state.audio,
      state.projectTotalMs,
      useClockStore.getState().currentMs,
    );
}

/** Whether the current project has a soundtrack loaded for preview. */
export function hasPreviewAudio(): boolean {
  return state !== null;
}
