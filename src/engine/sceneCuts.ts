import { type ProjectMusic, resolveMusicPosition, roundMs } from "./musicTime";
import {
  buildSceneTimeline,
  resolveOverlapMs,
  type SceneSlot,
  type TransitionSpec,
} from "./sceneTimeline";

/** Pinned cuts: a manifest scene entry may carry `cutAt` (a musical position) and `align` (`"end"`, the default: the scene is gone at that moment; `"mid"`: its outgoing transition is centred on it). Its `durationMs` then caches the length that lands the cut there under the grid and every earlier transition, the sidecar `at` contract applied to scene lengths. Resolved in scene order, so a grid or transition change re-resolves each pinned length and later boundaries stay on the music. Mirrored by the kit's `kblib/film/timeline.py`, pinned by `timeline-vectors.json`. */

export type CutAlign = "end" | "mid";

export interface CutSceneInput {
  durationMs: number;
  /** The scene's outgoing transition. */
  transition?: TransitionSpec;
  cutAt?: unknown;
  align?: unknown;
}

export interface ResolvedCuts {
  /** Every scene's length: the input's for unpinned scenes and for pins that can't resolve. */
  durations: number[];
  /** Scenes whose cached `durationMs` moved. */
  changed: number[];
  issues: string[];
}

const NO_MUSIC: ProjectMusic = { startOffsetMs: 0, cues: {}, sections: {} };

export function cutAlignOf(value: unknown): CutAlign {
  return value === "mid" ? "mid" : "end";
}

export function isPinnedCut(entry: { cutAt?: unknown }): entry is { cutAt: string } {
  return typeof entry.cutAt === "string";
}

/** Each scene's length with its pinned cut resolved. A pinned scene's start reads the overlap clamped by the scene before it only, since its own length is what's being solved; an unpinned scene keeps the timeline's full clamp. */
export function resolveSceneCuts(
  scenes: readonly CutSceneInput[],
  music: ProjectMusic | undefined,
): ResolvedCuts {
  const durations = scenes.map((s) => s.durationMs);
  const changed: number[] = [];
  const issues: string[] = [];
  let end = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const pinned = isPinnedCut(scene);
    const start =
      i === 0
        ? 0
        : end -
          resolveOverlapMs(
            scenes[i - 1].transition,
            durations[i - 1],
            pinned ? Number.POSITIVE_INFINITY : durations[i],
          );
    if (pinned) {
      const r = resolveMusicPosition(scene.cutAt, music ?? NO_MUSIC);
      if (!r.ok) {
        issues.push(`scene ${i + 1} cutAt "${scene.cutAt}": ${r.message}`);
      } else {
        const out = scene.transition?.durationMs;
        const half =
          cutAlignOf(scene.align) === "mid" &&
          i + 1 < scenes.length &&
          typeof out === "number" &&
          Number.isFinite(out)
            ? Math.max(0, out) / 2
            : 0;
        const want = roundMs(r.projectMs + half - start);
        if (want <= 0) {
          issues.push(
            `scene ${i + 1} cutAt "${scene.cutAt}" lands at ${roundMs(r.projectMs)} ms, before the scene starts (${start} ms)`,
          );
        } else if (want !== durations[i]) {
          durations[i] = want;
          changed.push(i);
        }
      }
    }
    end = start + durations[i];
  }
  return { durations, changed, issues };
}

/** A cut this close to a grid beat counts as on it: positions resolve to fractional ms and scene lengths are whole. */
export const ON_BEAT_MS = 1;

/** The grid beat a project time sits on (`bar:9`, `bar:9.3`), or null when there's no grid or it's off the beat. */
export function beatAt(music: ProjectMusic | undefined, projectMs: number): string | null {
  const grid = music?.grid;
  if (!grid) return null;
  const beatMs = 60000 / grid.bpm;
  const index = Math.round((projectMs + music.startOffsetMs - grid.offsetMs) / beatMs);
  if (Math.abs(grid.offsetMs + index * beatMs - music.startOffsetMs - projectMs) > ON_BEAT_MS) {
    return null;
  }
  const bar = Math.floor(index / grid.beatsPerBar) + 1;
  const beat = index - (bar - 1) * grid.beatsPerBar + 1;
  return beat === 1 ? `bar:${bar}` : `bar:${bar}.${beat}`;
}

/** A manifest scene entry as the cut planner reads and writes it (v2: `transition` is outgoing). */
export interface CutEntry {
  durationMs?: number;
  transition?: TransitionSpec;
  cutAt?: string;
  align?: CutAlign;
  [key: string]: unknown;
}

/** The slots a scene list lands on with its pinned cuts resolved. */
export function cutTimeline(
  entries: readonly CutEntry[],
  durations: readonly number[],
  music: ProjectMusic | undefined,
): SceneSlot[] {
  const cuts = resolveSceneCuts(
    entries.map((e, i) => ({
      durationMs: durations[i],
      transition: e.transition,
      cutAt: e.cutAt,
      align: e.align,
    })),
    music,
  );
  return buildSceneTimeline(
    entries.map((e, i) => ({
      id: String(i),
      durationMs: cuts.durations[i],
      transition: e.transition,
    })),
  );
}

/** Where boundary `index` cuts now: the middle of its overlap (its end on a hard cut). */
export function boundaryCutMs(slots: readonly SceneSlot[], index: number): number {
  return slots[index].endMs - (slots[index + 1]?.transitionIn?.durationMs ?? 0) / 2;
}

/** Sets scene `index`'s outgoing transition (null = hard cut) without moving any later boundary: the cut stays where it is, pinned to its beat (centred) when it sits on one, else held by length; the next scene then gains or loses at its head so its end stays put. `durations` are the scenes' stored lengths (TSX fallbacks filled in). Mirrored by the kit's `keep_cuts_for_transition`. */
export function keepCutsForTransition(
  entries: readonly CutEntry[],
  durations: readonly number[],
  index: number,
  spec: TransitionSpec | null,
  music: ProjectMusic | undefined,
): { entries: CutEntry[]; cutMs: number; position: string | null } {
  const before = cutTimeline(entries, durations, music);
  const cutMs = boundaryCutMs(before, index);
  const nextEnd = before[index + 1].endMs;
  const lengths = [...durations];
  const next = entries.map((e) => ({ ...e }));
  const entry = next[index];
  if (spec) entry.transition = spec;
  else delete entry.transition;
  const position = isPinnedCut(entry) ? entry.cutAt : beatAt(music, cutMs);
  if (!isPinnedCut(entry)) {
    if (position) {
      entry.cutAt = position;
      entry.align = "mid";
    } else {
      const was = before[index + 1].transitionIn?.durationMs ?? 0;
      const now = resolveOverlapMs(spec ?? undefined, lengths[index], lengths[index + 1]);
      lengths[index] = roundMs(lengths[index] + (now - was) / 2);
      entry.durationMs = lengths[index];
    }
  }
  const follower = next[index + 1];
  if (!isPinnedCut(follower)) {
    const placed = cutTimeline(next, lengths, music);
    const length = roundMs(nextEnd - placed[index + 1].startMs);
    if (length > 0) {
      lengths[index + 1] = length;
      follower.durationMs = length;
    }
  }
  const cuts = resolveSceneCuts(
    next.map((e, i) => ({
      durationMs: lengths[i],
      transition: e.transition,
      cutAt: e.cutAt,
      align: e.align,
    })),
    music,
  );
  for (const i of cuts.changed) next[i].durationMs = cuts.durations[i];
  return { entries: next, cutMs, position };
}
