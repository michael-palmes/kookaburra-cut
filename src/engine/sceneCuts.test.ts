import { describe, expect, it } from "vitest";
import type { ProjectMusic } from "./musicTime";
import {
  beatAt,
  boundaryCutMs,
  cutTimeline,
  keepCutsForTransition,
  resolveSceneCuts,
} from "./sceneCuts";

// 120 bpm in 4/4: a beat is 500 ms, a bar 2000 ms, bar 1 at 0.
const music: ProjectMusic = {
  grid: { bpm: 120, offsetMs: 0, beatsPerBar: 4 },
  startOffsetMs: 0,
  cues: {},
  sections: {},
};
const fade = (durationMs: number) => ({ type: "crossfade" as const, durationMs });

describe("resolveSceneCuts", () => {
  it("leaves unpinned scenes alone", () => {
    const r = resolveSceneCuts(
      [{ durationMs: 3000, transition: fade(800) }, { durationMs: 4000 }],
      music,
    );
    expect(r).toEqual({ durations: [3000, 4000], changed: [], issues: [] });
  });

  it("ends a pinned scene on its position, after earlier overlaps", () => {
    const r = resolveSceneCuts(
      [
        { durationMs: 4000, transition: fade(800) },
        { durationMs: 1000, cutAt: "bar:5" },
        { durationMs: 2000 },
      ],
      music,
    );
    // Scene 2 starts at 4000 - 800 = 3200 and must end at bar 5 (8000 ms).
    expect(r.durations).toEqual([4000, 4800, 2000]);
    expect(r.changed).toEqual([1]);
  });

  it("centres the outgoing transition on a mid cut", () => {
    const r = resolveSceneCuts(
      [
        { durationMs: 1, transition: fade(800), cutAt: "bar:3", align: "mid" },
        { durationMs: 2000 },
      ],
      music,
    );
    expect(r.durations[0]).toBe(4400);
  });

  it("keeps later boundaries on their bars when an earlier transition changes", () => {
    const scenes = (overlap: number) => [
      { durationMs: 4000, transition: fade(overlap), cutAt: "bar:3", align: "mid" },
      { durationMs: 1, transition: fade(overlap), cutAt: "bar:5", align: "mid" },
      { durationMs: 3000 },
    ];
    for (const overlap of [0, 400, 1000]) {
      const r = resolveSceneCuts(scenes(overlap), music);
      const slots = cutTimeline(
        scenes(overlap).map((s) => ({ ...s, align: "mid" as const })),
        r.durations,
        music,
      );
      expect([boundaryCutMs(slots, 0), boundaryCutMs(slots, 1)]).toEqual([4000, 8000]);
    }
  });

  it("keeps the stored length when a pin can't resolve", () => {
    const r = resolveSceneCuts([{ durationMs: 3000, cutAt: "bar:9" }], undefined);
    expect(r.durations).toEqual([3000]);
    expect(r.issues).toEqual(['scene 1 cutAt "bar:9": the project has no audio.grid']);
  });

  it("refuses a cut before the scene starts", () => {
    const r = resolveSceneCuts([{ durationMs: 5000 }, { durationMs: 3000, cutAt: "bar:2" }], music);
    expect(r.durations).toEqual([5000, 3000]);
    expect(r.issues).toEqual([
      'scene 2 cutAt "bar:2" lands at 2000 ms, before the scene starts (5000 ms)',
    ]);
  });
});

describe("beatAt", () => {
  it("names the beat a time sits on", () => {
    expect(beatAt(music, 4000)).toBe("bar:3");
    expect(beatAt(music, 4500.6)).toBe("bar:3.2");
    expect(beatAt(music, 4250)).toBeNull();
    expect(beatAt(undefined, 4000)).toBeNull();
  });
});

describe("keepCutsForTransition", () => {
  const entries = [
    { durationMs: 4000 },
    { durationMs: 4000 },
    { durationMs: 2000, transition: fade(500) },
    { durationMs: 3000 },
  ];
  const lengths = entries.map((e) => e.durationMs);
  const later = (es: typeof entries | ReturnType<typeof keepCutsForTransition>["entries"]) => {
    const slots = cutTimeline(
      es,
      es.map((e) => e.durationMs as number),
      music,
    );
    return slots.slice(2).map((s) => [s.startMs, s.endMs]);
  };

  it("pins an on-beat cut, centres the overlap and holds every later scene", () => {
    const r = keepCutsForTransition(entries, lengths, 0, fade(800), music);
    expect(r.position).toBe("bar:3");
    expect(r.entries[0]).toEqual({
      durationMs: 4400,
      transition: fade(800),
      cutAt: "bar:3",
      align: "mid",
    });
    expect(r.entries[1].durationMs).toBe(4400);
    expect(later(r.entries)).toEqual(later(entries));
  });

  it("holds an off-beat cut by length", () => {
    const off = [{ durationMs: 4250 }, ...entries.slice(1)];
    const r = keepCutsForTransition(
      off,
      off.map((e) => e.durationMs),
      0,
      fade(600),
      music,
    );
    expect(r.position).toBeNull();
    expect(r.entries[0]).toEqual({ durationMs: 4550, transition: fade(600) });
    expect(later(r.entries)).toEqual(later(off));
  });

  it("removing a transition gives the overlap back without moving later scenes", () => {
    const withFade = keepCutsForTransition(entries, lengths, 0, fade(800), music).entries;
    const r = keepCutsForTransition(
      withFade,
      withFade.map((e) => e.durationMs as number),
      0,
      null,
      music,
    );
    expect(r.entries[0]).toEqual({ durationMs: 4000, cutAt: "bar:3", align: "mid" });
    expect(r.entries[1].durationMs).toBe(4000);
    expect(later(r.entries)).toEqual(later(entries));
  });
});
