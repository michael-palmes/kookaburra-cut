import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ProjectAudioSpec,
  projectMusicOf,
  sanitiseAudioMusic,
  soundtrackAudioBlock,
  withSanitisedMusic,
} from "./project";

const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => vi.restoreAllMocks());

describe("sanitiseAudioMusic", () => {
  it("keeps a valid grid, cues and sections, defaulting beatsPerBar to 4", () => {
    const source = { sha256: "x", analysisVersion: 2, tracker: "nn" as const };
    const out = sanitiseAudioMusic({
      file: "a.mp3",
      grid: { bpm: 135.11, offsetMs: 101.7, source },
      cues: { drop: "bar:9", raw: 4000, nudged: "bar:9-40ms" },
      sections: [{ id: "chorus", label: "Chorus", from: "bar:17", to: "bar:25" }],
    });
    expect(out).toEqual({
      grid: { bpm: 135.11, offsetMs: 101.7, beatsPerBar: 4, source },
      cues: { drop: "bar:9", raw: 4000, nudged: "bar:9-40ms" },
      sections: [{ id: "chorus", label: "Chorus", from: "bar:17", to: "bar:25" }],
    });
  });

  it("drops a grid with a bad field, with a warning each", () => {
    const warn = quiet();
    for (const grid of [
      { bpm: 20, offsetMs: 0 },
      { bpm: 301, offsetMs: 0 },
      { bpm: Number.NaN, offsetMs: 0 },
      { bpm: 120, offsetMs: Number.POSITIVE_INFINITY },
      { bpm: 120, offsetMs: 0, beatsPerBar: 0 },
      { bpm: 120, offsetMs: 0, beatsPerBar: 17 },
      { bpm: 120, offsetMs: 0, beatsPerBar: 3.5 },
      "120",
    ]) {
      expect(sanitiseAudioMusic({ file: "a.mp3", grid } as unknown as ProjectAudioSpec)).toEqual(
        {},
      );
    }
    expect(warn).toHaveBeenCalledTimes(8);
    expect(
      sanitiseAudioMusic({ file: "a.mp3", grid: { bpm: 30, offsetMs: -5, beatsPerBar: 16 } }),
    ).toEqual({ grid: { bpm: 30, offsetMs: -5, beatsPerBar: 16 } });
  });

  it("drops cues with bad ids or values, or that point at another cue or section", () => {
    const warn = quiet();
    const out = sanitiseAudioMusic({
      file: "a.mp3",
      grid: { bpm: 120, offsetMs: 0 },
      cues: {
        ok: "bar:2",
        Bad: "bar:2",
        loop: "cue:ok",
        part: "section:intro",
        wrong: "bar 2",
        beat: "bar:2.5",
        inf: Number.POSITIVE_INFINITY,
        flag: true as unknown as number,
      },
    });
    expect(out.cues).toEqual({ ok: "bar:2" });
    expect(warn).toHaveBeenCalledTimes(7);
  });

  it("keeps a bar cue without a grid: it resolves once one exists", () => {
    expect(sanitiseAudioMusic({ file: "a.mp3", cues: { drop: "bar:9" } }).cues).toEqual({
      drop: "bar:9",
    });
  });

  it("needs sections with unique ids and from before to once resolved", () => {
    const warn = quiet();
    const out = sanitiseAudioMusic({
      file: "a.mp3",
      grid: { bpm: 120, offsetMs: 0 },
      sections: [
        { id: "a", from: "bar:1", to: "bar:5" },
        { id: "a", from: "bar:5", to: "bar:9" },
        { id: "back", from: "bar:9", to: "bar:5" },
        { id: "same", from: 4000, to: "bar:3" },
        { id: "ms", from: 0, to: 2000 },
        { id: "nest", from: "cue:x", to: "bar:9" },
      ],
    });
    expect(out.sections?.map((s) => s.id)).toEqual(["a", "ms"]);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe("withSanitisedMusic and projectMusicOf", () => {
  it("leave a block that authors no music alone, so legacy loads are untouched", () => {
    const spec = { file: "a.mp3", gainDb: -3 };
    expect(withSanitisedMusic(spec)).toBe(spec);
    expect(projectMusicOf(spec)).toBeUndefined();
    expect(projectMusicOf(undefined)).toBeUndefined();
  });

  it("replace the music fields with their sanitised selves", () => {
    quiet();
    expect(
      withSanitisedMusic({ file: "a.mp3", gainDb: -3, grid: { bpm: 5, offsetMs: 0 } }),
    ).toEqual({ file: "a.mp3", gainDb: -3 });
  });

  it("build the resolver's view of a sanitised block", () => {
    expect(
      projectMusicOf({
        file: "a.mp3",
        startOffsetMs: 1500,
        grid: { bpm: 120, offsetMs: 250 },
        sections: [{ id: "outro", from: "bar:9", to: 30000 }],
      }),
    ).toEqual({
      grid: { bpm: 120, offsetMs: 250, beatsPerBar: 4 },
      startOffsetMs: 1500,
      cues: {},
      sections: { outro: { from: "bar:9", to: 30000 } },
    });
  });
});

describe("soundtrackAudioBlock (Set soundtrack)", () => {
  it("keeps the grid, cues and sections and resets the old track's mix and markers", () => {
    const existing = {
      file: "assets/old.mp3",
      gainDb: -6,
      startOffsetMs: 2000,
      markers: { version: 1, keyMoments: [100] },
      grid: { bpm: 120, offsetMs: 250 },
      cues: { drop: "bar:9" },
      sections: [{ id: "intro", from: "bar:1", to: "bar:5" }],
    };
    expect(soundtrackAudioBlock(existing, "assets/new.mp3")).toEqual({
      file: "assets/new.mp3",
      grid: { bpm: 120, offsetMs: 250 },
      cues: { drop: "bar:9" },
      sections: [{ id: "intro", from: "bar:1", to: "bar:5" }],
    });
  });

  it("writes the file alone when there is nothing to keep", () => {
    expect(soundtrackAudioBlock(undefined, "assets/new.mp3")).toEqual({ file: "assets/new.mp3" });
    expect(soundtrackAudioBlock({ file: "assets/old.mp3", gainDb: 2 }, "assets/new.mp3")).toEqual({
      file: "assets/new.mp3",
    });
  });
});
