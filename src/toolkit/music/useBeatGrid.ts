import { useContext, useMemo } from "react";
import { type ProjectMusic, resolveSceneLocalMs, roundMs } from "../../engine/musicTime";
import { ProjectMusicContext, useSceneContext } from "../../engine/sceneContext";

/** Where a scene-local time sits on the grid: 1-based bar, beat and sixteenth (bar 0 and below are pickups), plus how far through the beat and the bar it is (0..1). */
export interface BeatPosition {
  bar: number;
  beat: number;
  sixteenth: number;
  beatPhase: number;
  barPhase: number;
}

/** The project's authored `audio.grid` in this scene's time. Every time is integer scene-local ms through the same rounding as sidecar `at` positions, so `grid.bar(13)` and a key at `"bar:13"` land on the same frame. */
export interface BeatGrid {
  bpm: number;
  beatsPerBar: number;
  /** One beat and one bar in ms, unrounded. */
  beatMs: number;
  barMs: number;
  /** Scene-local ms of a bar (and beat, sixteenth), all 1-based. */
  bar(bar: number, beat?: number, sixteenth?: number): number;
  /** Scene-local ms of a position (`"bar:13.3"`, `"cue:drop"`, `"section:outro"`, `"bar:9-40ms"`); throws when it can't resolve. */
  at(position: string): number;
  /** Project ms to scene-local ms. */
  local(projectMs: number): number;
  /** Scene-local ms to project ms. */
  project(localMs: number): number;
  position(localMs: number): BeatPosition;
}

/** Within this of a sixteenth boundary a time counts as on it, so a rounded `bar()` reads back as its own bar. */
const ON_BOUNDARY_MS = 0.5;

const floorMod = (n: number, m: number) => n - Math.floor(n / m) * m;

/** The authored scene start the hooks measure from: sidecar positions resolve against the slot, not a steered scene clock; 0 outside any scene. */
function useMusicScope(): { music: ProjectMusic | null; startMs: number } {
  const value = useContext(ProjectMusicContext);
  const scene = useSceneContext();
  if (!value) return { music: null, startMs: 0 };
  const startMs = scene ? (value.sceneStartsMs[scene.index] ?? scene.startMs) : 0;
  return { music: value.music, startMs };
}

/** The beat grid in scene-local time, or null when the project has no `audio.grid` (the scene then falls back to its own timing). */
export function useBeatGrid(): BeatGrid | null {
  const { music, startMs } = useMusicScope();
  return useMemo(() => (music?.grid ? beatGridFor(music, startMs) : null), [music, startMs]);
}

/** The project's `audio.cues` as scene-local ms by id; `{}` when it has none, and a cue that can't resolve is left out. */
export function useCues(): Readonly<Record<string, number>> {
  const { music, startMs } = useMusicScope();
  return useMemo(() => cuesFor(music, startMs), [music, startMs]);
}

/** `useBeatGrid()`'s value for a scene starting at `startMs` (project ms); exported for tests. */
export function beatGridFor(music: ProjectMusic, startMs: number): BeatGrid | null {
  const grid = music.grid;
  if (!grid) return null;
  const beatMs = 60000 / grid.bpm;
  const at = (position: string): number => {
    const r = resolveSceneLocalMs(position, music, startMs);
    if (!r.ok) throw new Error(`useBeatGrid: ${r.message}`);
    return r.projectMs;
  };
  return {
    bpm: grid.bpm,
    beatsPerBar: grid.beatsPerBar,
    beatMs,
    barMs: beatMs * grid.beatsPerBar,
    bar: (bar, beat = 1, sixteenth = 1) => at(`bar:${bar}.${beat}.${sixteenth}`),
    at,
    local: (projectMs) => roundMs(projectMs - startMs),
    project: (localMs) => roundMs(localMs + startMs),
    position: (localMs) => {
      const sixteenthMs = beatMs / 4;
      const elapsed = localMs + startMs + music.startOffsetMs - grid.offsetMs;
      const nearest = Math.round(elapsed / sixteenthMs);
      const sixteenths =
        Math.abs(elapsed - nearest * sixteenthMs) <= ON_BOUNDARY_MS
          ? nearest
          : elapsed / sixteenthMs;
      const beats = sixteenths / 4;
      const whole = Math.floor(beats);
      const bars = whole / grid.beatsPerBar;
      return {
        bar: Math.floor(bars) + 1,
        beat: floorMod(whole, grid.beatsPerBar) + 1,
        sixteenth: Math.floor(floorMod(sixteenths, 4)) + 1,
        beatPhase: beats - whole,
        barPhase: (beats - Math.floor(bars) * grid.beatsPerBar) / grid.beatsPerBar,
      };
    },
  };
}

/** `useCues()`'s value; exported for tests. */
export function cuesFor(
  music: ProjectMusic | null,
  startMs: number,
): Readonly<Record<string, number>> {
  if (!music) return EMPTY_CUES;
  const out: Record<string, number> = {};
  for (const id of Object.keys(music.cues)) {
    const r = resolveSceneLocalMs(`cue:${id}`, music, startMs);
    if (r.ok) out[id] = r.projectMs;
  }
  return out;
}

const EMPTY_CUES: Readonly<Record<string, number>> = Object.freeze({});
