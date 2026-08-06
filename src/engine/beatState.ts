/** Beat guidance for the loaded project's soundtrack: cache-first via Rust (`beat_cache_load`/`beat_cache_store`), else decode at the pinned rate and analyse in the webview. Module singleton beside `previewAudio`; the store carries only what the lanes draw, and the export path never reads it. */

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { BeatKeyMoment } from "./beatAnalysis";
import {
  analyseBeats,
  BEAT_SAMPLE_RATE,
  type BeatAnalysis,
  parseBeatAnalysis,
} from "./beatAnalysis";
import { fsUrl } from "./media";
import type { AudioMarkersSpec, LoadedProject } from "./project";

export type BeatStatus = "idle" | "analysing" | "ready" | "error";

interface BeatStoreState {
  status: BeatStatus;
  analysis: BeatAnalysis | null;
}

export const useBeatStore = create<BeatStoreState>(() => ({ status: "idle", analysis: null }));

let generation = 0;
let currentAbs: string | null = null;

async function decodeMono(bytes: ArrayBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, BEAT_SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(bytes);
  const mono = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  if (buffer.numberOfChannels > 1) {
    for (let i = 0; i < mono.length; i++) mono[i] /= buffer.numberOfChannels;
  }
  return mono;
}

function run(): void {
  const gen = ++generation;
  const abs = currentAbs;
  if (!abs) {
    useBeatStore.setState({ status: "idle", analysis: null });
    return;
  }
  useBeatStore.setState({ status: "analysing", analysis: null });
  void (async () => {
    try {
      const cached = await invoke<string | null>("beat_cache_load", { path: abs });
      if (gen !== generation) return;
      const parsed = cached ? parseBeatAnalysis(cached) : null;
      if (parsed) {
        useBeatStore.setState({ status: "ready", analysis: parsed });
        return;
      }
      const bytes = await (await fetch(fsUrl(abs))).arrayBuffer();
      const mono = await decodeMono(bytes);
      if (gen !== generation) return;
      const analysis = analyseBeats(mono, BEAT_SAMPLE_RATE);
      useBeatStore.setState({ status: "ready", analysis });
      void invoke("beat_cache_store", { path: abs, json: JSON.stringify(analysis) }).catch((e) => {
        console.warn("[beats] cache store failed (analysis kept in memory):", e);
      });
    } catch (e) {
      console.warn("[beats] analysis failed (beat lane shows an error chip):", e);
      if (gen === generation) useBeatStore.setState({ status: "error", analysis: null });
    }
  })();
}

/** Point beat analysis at a freshly-loaded project (or none). Cache makes reloads instant. */
export function setBeatProject(project: LoadedProject | null): void {
  currentAbs = project?.audio?.abs ?? null;
  run();
}

/** Re-run after a failure (the error chip's retry). */
export function retryBeatAnalysis(): void {
  run();
}

/** How close a manual marker sits to a detected moment before it inherits that strength. */
const MARKER_MATCH_MS = 30;
const MANUAL_MARKER_STRENGTH = 0.8;

/** The lane's key moments in PROJECT time (detected track times shift back by `startOffsetMs`, clipped to the timeline): the manifest overlay replaces detection wholesale when present; manual times borrow the nearest detected strength so the size hierarchy survives edits. */
export function effectiveKeyMoments(
  analysis: BeatAnalysis | null,
  markers: AudioMarkersSpec | undefined,
  startOffsetMs = 0,
  durationMs = Number.POSITIVE_INFINITY,
): BeatKeyMoment[] {
  const detected = (analysis?.keyMoments ?? [])
    .map((m) => ({ tMs: m.tMs - startOffsetMs, strength: m.strength }))
    .filter((m) => m.tMs >= 0 && m.tMs <= durationMs);
  if (!markers) return detected;
  return markers.keyMoments
    .filter((tMs) => tMs >= 0 && tMs <= durationMs)
    .map((tMs) => {
      const near = detected.find((m) => Math.abs(m.tMs - tMs) <= MARKER_MATCH_MS);
      return { tMs, strength: near?.strength ?? MANUAL_MARKER_STRENGTH };
    });
}

/** The beat grid in project time, clipped to the timeline. */
export function projectBeatGrid(
  analysis: BeatAnalysis | null,
  startOffsetMs = 0,
  durationMs = Number.POSITIVE_INFINITY,
): number[] {
  return (analysis?.beats ?? [])
    .map((t) => t - startOffsetMs)
    .filter((t) => t >= 0 && t <= durationMs);
}
