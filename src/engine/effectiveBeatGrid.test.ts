import { describe, expect, it } from "vitest";
import type { BeatAnalysis } from "./beatAnalysis";
import { authoredBeatKey, buildSyncTrack, withKeyAt } from "./beatCameraSync";
import { effectiveBeatGrid, nearestGridBeat, projectBeatGrid } from "./beatState";
import { type ProjectMusic, resolveMusicPosition, resolveSceneLocalMs } from "./musicTime";
import { defaultOrbitPose } from "./sceneCamera";

const analysis: BeatAnalysis = {
  version: 3,
  sha256: "abc",
  tracker: "dsp",
  fallbackReason: null,
  durationMs: 6000,
  bpm: 120,
  fit: null,
  beats: [300, 800, 1300, 1800, 2300, 2800],
  beatInfo: [],
  downbeats: [300, 2300],
  keyMoments: [],
  envelope: { hopMs: 21.333, values: [] },
  energy: null,
  sections: [],
  breaths: [],
  stabs: [],
  hits: [],
  lyrics: null,
};

// 100 BPM in 3/4, bar 1 at track 1000, the soundtrack starting 400 ms in: a beat is 600 ms.
const music: ProjectMusic = {
  grid: { bpm: 100, offsetMs: 1000, beatsPerBar: 3 },
  startOffsetMs: 400,
  cues: {},
  sections: {},
};

describe("effectiveBeatGrid", () => {
  it("falls back to the analysis when there is no authored grid", () => {
    const grid = effectiveBeatGrid(analysis, undefined, 300, 2000);
    expect(grid).toEqual({
      source: "detected",
      beats: projectBeatGrid(analysis, 300, 2000),
      bars: [0, 2000],
    });
    expect(effectiveBeatGrid(analysis, { ...music, grid: undefined }).source).toBe("detected");
  });

  it("draws the authored grid whenever there is one, pickups included", () => {
    const grid = effectiveBeatGrid(analysis, music, 0, 2500);
    expect(grid.source).toBe("authored");
    // Track beats 400 (bar 0 beat 3), 1000 (bar 1), 1600, 2200, 2800 (bar 2) ... minus the 400 offset.
    expect(grid.beats.map((t) => Math.round(t))).toEqual([0, 600, 1200, 1800, 2400]);
    expect(grid.bars.map((t) => Math.round(t))).toEqual([600, 2400]);
  });

  it("puts each authored beat exactly where its position resolves", () => {
    const grid = effectiveBeatGrid(null, music, 0, 5000);
    const bar2 = resolveMusicPosition("bar:2", music);
    if (!bar2.ok) throw new Error(bar2.message);
    expect(grid.bars).toContain(bar2.projectMs);
  });

  it("runs to the analysed track's end without a timeline length", () => {
    const grid = effectiveBeatGrid(analysis, music);
    expect(grid.beats.at(-1)).toBeLessThanOrEqual(analysis.durationMs - music.startOffsetMs);
    expect(effectiveBeatGrid(null, music).beats).toEqual([0]);
  });
});

describe("nearestGridBeat", () => {
  it("names the nearest authored beat as a bar position", () => {
    expect(nearestGridBeat(music, 610)).toEqual({ index: 0, position: "bar:1", projectMs: 600 });
    expect(nearestGridBeat(music, 1150)).toMatchObject({ index: 1, position: "bar:1.2" });
    expect(nearestGridBeat(music, 0)).toMatchObject({ index: -1, position: "bar:0.3" });
    expect(nearestGridBeat(undefined, 600)).toBeNull();
  });
});

describe("beat-lane camera keys on the authored grid", () => {
  it("land on a beat within a quarter beat and keep its position", () => {
    const key = authoredBeatKey(music, 1180, 1000);
    expect(key).toEqual({ tMs: 200, at: "bar:1.2" });
    const r = resolveSceneLocalMs("bar:1.2", music, 1000);
    expect(r.ok && r.projectMs).toBe(key?.tMs);
  });

  it("leave detected or off-beat times alone", () => {
    expect(authoredBeatKey(music, 1450, 0)).toBeNull();
    expect(authoredBeatKey(undefined, 1200, 0)).toBeNull();
  });

  it("tag the generated keys", () => {
    const track = buildSyncTrack(defaultOrbitPose(), [1200, 2400], 0, ["bar:2", undefined]);
    expect(track.keys.map((k) => ("at" in k ? k.at : null))).toEqual([null, "bar:2", null]);
    const tagged = withKeyAt(track, 2400, "bar:3");
    expect(tagged.keys[2]).toMatchObject({ tMs: 2400, at: "bar:3" });
    expect(withKeyAt(track, 999, "bar:3")).toBe(track);
  });
});
