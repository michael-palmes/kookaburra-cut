/** Beat guidance for the loaded project's soundtrack: the native song analyser (`song_analysis`: ffmpeg decode, the bundled beat-this model or the DSP fit, cached by audio SHA) supplies it and this module keeps the lanes' copy. Module singleton beside `previewAudio`; the store carries only what the lanes draw, and the export path never reads it. */

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { BeatAnalysis, BeatKeyMoment } from "./beatAnalysis";
import { parseBeatAnalysis } from "./beatAnalysis";
import type { AudioMarkersSpec, LoadedProject } from "./project";

export type BeatStatus = "idle" | "analysing" | "ready" | "error";

interface BeatStoreState {
  status: BeatStatus;
  analysis: BeatAnalysis | null;
}

export const useBeatStore = create<BeatStoreState>(() => ({ status: "idle", analysis: null }));

let generation = 0;
let currentAbs: string | null = null;

function run(force: boolean): void {
  const gen = ++generation;
  const abs = currentAbs;
  if (!abs) {
    useBeatStore.setState({ status: "idle", analysis: null });
    return;
  }
  useBeatStore.setState({ status: "analysing", analysis: null });
  void (async () => {
    try {
      const raw = await invoke<unknown>("song_analysis", { path: abs, force });
      if (gen !== generation) return;
      const analysis = parseBeatAnalysis(raw);
      if (!analysis) throw new Error("the song analysis did not validate");
      useBeatStore.setState({ status: "ready", analysis });
    } catch (e) {
      console.warn("[beats] analysis failed (beat lane shows an error chip):", e);
      if (gen === generation) useBeatStore.setState({ status: "error", analysis: null });
    }
  })();
}

/** Point beat analysis at a freshly-loaded project (or none). Cache makes reloads instant. */
export function setBeatProject(project: LoadedProject | null): void {
  currentAbs = project?.audio?.abs ?? null;
  run(false);
}

/** Re-run after a failure (the error chip's retry), bypassing the cache. */
export function retryBeatAnalysis(): void {
  run(true);
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
