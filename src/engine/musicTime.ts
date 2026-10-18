/** Musical positions (`bar:13.3`, `cue:drop`, `section:outro`, each with an optional `+40ms` / `-40ms` nudge) resolved to project ms against the authored `audio.grid`. Pure, and mirrored operation for operation by the kit's `kblib/music.py`, pinned by `music-vectors.json`: changing the grammar, the maths or its order is a contract change for every sidecar that stores an `at`. */

/** The authored tempo grid (`project.json` `audio.grid`). */
export interface MusicGrid {
  bpm: number;
  /** Track ms (ffmpeg decode) of bar 1 beat 1. */
  offsetMs: number;
  beatsPerBar: number;
}

/** Everything a position resolves against: the grid, the soundtrack's start offset and the authored cues and sections. Cue and section values are a position or project ms. */
export interface ProjectMusic {
  grid?: MusicGrid;
  /** Track ms where the soundtrack starts playing (`audio.startOffsetMs`). */
  startOffsetMs: number;
  cues: Readonly<Record<string, string | number>>;
  sections: Readonly<
    Record<string, { from: string | number; to: string | number; label?: string }>
  >;
}

export type MusicPositionError = "syntax" | "no-grid" | "range" | "unknown" | "nested";

export type MusicPositionResult =
  | { ok: true; projectMs: number }
  | { ok: false; code: MusicPositionError; message: string };

/** Bar numbers stay small enough that the kit's integer maths matches JavaScript's doubles exactly. */
export const MAX_BAR = 100000;

/** Cue and section ids: lowercase, digits and dashes, 1 to 40 characters. */
export const MUSIC_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const POSITION =
  /^(?:bar:(-?\d+)(?:\.(\d+)(?:\.(\d+))?)?|cue:([a-z0-9][a-z0-9-]{0,39})|section:([a-z0-9][a-z0-9-]{0,39}))(?:([+-])(\d+(?:\.\d+)?)ms)?$/;

/** True when `text` parses as a position (it may still fail to resolve). */
export function isMusicPosition(text: string): boolean {
  return POSITION.test(text);
}

/** Resolves a position to unrounded project ms. Bars, beats and sixteenths are 1-based (bar 0 and below are pickups); a cue or section may hold a position but never another cue or section. */
export function resolveMusicPosition(text: string, music: ProjectMusic): MusicPositionResult {
  return resolve(text, music, 0);
}

function resolve(text: string, music: ProjectMusic, depth: number): MusicPositionResult {
  const m = POSITION.exec(text);
  if (!m) {
    return {
      ok: false,
      code: "syntax",
      message: `"${text}" isn't bar:B[.beat[.16th]], cue:ID or section:ID`,
    };
  }
  const nudge = m[6] ? (m[6] === "-" ? -1 : 1) * Number(m[7]) : 0;
  let base: MusicPositionResult;
  if (m[1] !== undefined) {
    const grid = music.grid;
    if (!grid) return { ok: false, code: "no-grid", message: "the project has no audio.grid" };
    const bar = Number(m[1]);
    const beat = m[2] === undefined ? 1 : Number(m[2]);
    const sixteenth = m[3] === undefined ? 1 : Number(m[3]);
    if (!(Math.abs(bar) <= MAX_BAR)) {
      return {
        ok: false,
        code: "range",
        message: `bar ${m[1]} is outside -${MAX_BAR}..${MAX_BAR}`,
      };
    }
    if (beat < 1 || beat > grid.beatsPerBar) {
      return {
        ok: false,
        code: "range",
        message: `beat ${beat} is outside 1..${grid.beatsPerBar}`,
      };
    }
    if (sixteenth < 1 || sixteenth > 4) {
      return { ok: false, code: "range", message: `sixteenth ${sixteenth} is outside 1..4` };
    }
    const beatMs = 60000 / grid.bpm;
    const beats = (bar - 1) * grid.beatsPerBar + (beat - 1) + (sixteenth - 1) / 4;
    base = { ok: true, projectMs: grid.offsetMs + beats * beatMs - music.startOffsetMs };
  } else {
    if (depth > 0) {
      return {
        ok: false,
        code: "nested",
        message: "a cue or section can't point at another cue or section",
      };
    }
    const isCue = m[4] !== undefined;
    const id = (m[4] ?? m[5]) as string;
    const raw: unknown = isCue
      ? own(music.cues, id)
      : (own(music.sections, id) as { from?: unknown } | null | undefined)?.from;
    if (raw === undefined) {
      return { ok: false, code: "unknown", message: `no ${isCue ? "cue" : "section"} "${id}"` };
    }
    if (typeof raw === "number") base = { ok: true, projectMs: raw };
    else if (typeof raw === "string") base = resolve(raw, music, depth + 1);
    else
      return {
        ok: false,
        code: "syntax",
        message: `${isCue ? "cue" : "section"} "${id}" isn't a position or ms`,
      };
  }
  return base.ok ? { ok: true, projectMs: base.projectMs + nudge } : base;
}

function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

/** The one rounding rule for resolved times: `Math.round` (halves toward +infinity). The kit copies it exactly as `js_round`. */
export function roundMs(ms: number): number {
  return Math.round(ms);
}

/** A position as scene-local integer ms for a scene starting at `sceneStartMs` (project ms). */
export function resolveSceneLocalMs(
  text: string,
  music: ProjectMusic,
  sceneStartMs: number,
): MusicPositionResult {
  const r = resolveMusicPosition(text, music);
  return r.ok ? { ok: true, projectMs: roundMs(r.projectMs - sceneStartMs) } : r;
}
