import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ProjectMusic, resolveSceneLocalMs } from "../../engine/musicTime";
import { ProjectMusicContext, projectMusicValue, SceneContext } from "../../engine/sceneContext";
import { type BeatGrid, beatGridFor, cuesFor, useBeatGrid, useCues } from "./useBeatGrid";

const music: ProjectMusic = {
  grid: { bpm: 135.11, offsetMs: 101.7, beatsPerBar: 4 },
  startOffsetMs: 640,
  cues: { drop: "bar:9", raw: 4000, nudge: "bar:9+40ms", broken: "cue:drop" },
  sections: { chorus: { from: "bar:17.3", to: "bar:25" } },
};

const local = (position: string, startMs: number) => {
  const r = resolveSceneLocalMs(position, music, startMs);
  if (!r.ok) throw new Error(r.message);
  return r.projectMs;
};

function Probe({ onRead }: { onRead: (grid: BeatGrid | null, cues: object) => void }) {
  onRead(useBeatGrid(), useCues());
  return null;
}

function read(
  value: ReturnType<typeof projectMusicValue>,
  scene?: { index: number; startMs: number },
) {
  let grid: BeatGrid | null = null;
  let cues: object = {};
  const probe = (
    <Probe
      onRead={(g, c) => {
        grid = g;
        cues = c;
      }}
    />
  );
  renderToStaticMarkup(
    <ProjectMusicContext.Provider value={value}>
      {scene ? (
        <SceneContext.Provider value={{ ...scene, durationMs: 5000 }}>
          {probe}
        </SceneContext.Provider>
      ) : (
        probe
      )}
    </ProjectMusicContext.Provider>,
  );
  return { grid: grid as BeatGrid | null, cues };
}

describe("useBeatGrid and useCues", () => {
  it("are null and {} without authored music (null-for-legacy)", () => {
    expect(read(null)).toEqual({ grid: null, cues: {} });
    const cuesOnly = projectMusicValue({
      music: { startOffsetMs: 0, cues: { hit: 1200 }, sections: {} },
      slots: [{ startMs: 0 }],
    });
    expect(read(cuesOnly, { index: 0, startMs: 0 })).toEqual({ grid: null, cues: { hit: 1200 } });
  });

  it("match the sidecar resolver exactly, in the scene's authored slot time", () => {
    const value = projectMusicValue({ music, slots: [{ startMs: 0 }, { startMs: 7333 }] });
    // A steered scene clock (Present's slideshow anchor) must not move musical times.
    const { grid, cues } = read(value, { index: 1, startMs: 99999 });
    if (!grid) throw new Error("no grid");
    expect(grid.bar(13)).toBe(local("bar:13", 7333));
    expect(grid.bar(13, 3)).toBe(local("bar:13.3", 7333));
    expect(grid.bar(13, 3, 2)).toBe(local("bar:13.3.2", 7333));
    expect(grid.bar(0, 4)).toBe(local("bar:0.4", 7333));
    expect(grid.at("section:chorus")).toBe(local("bar:17.3", 7333));
    expect(grid.at("cue:nudge")).toBe(local("bar:9+40ms", 7333));
    expect(cues).toEqual({
      drop: local("bar:9", 7333),
      raw: 4000 - 7333,
      nudge: local("bar:9+40ms", 7333),
    });
    for (const t of [grid.bar(13), grid.at("cue:drop"), grid.local(12345.6)]) {
      expect(Number.isInteger(t)).toBe(true);
    }
    expect(grid.local(10000)).toBe(10000 - 7333);
    expect(grid.project(100)).toBe(7433);
    expect(grid.bpm).toBe(135.11);
    expect(grid.beatMs).toBe(60000 / 135.11);
    expect(grid.barMs).toBe((60000 / 135.11) * 4);
  });

  it("measure from project 0 outside any scene", () => {
    const { grid } = read(projectMusicValue({ music, slots: [{ startMs: 500 }] }));
    expect(grid?.bar(5)).toBe(local("bar:5", 0));
  });

  it("throw on a position that can't resolve", () => {
    const grid = beatGridFor(music, 0);
    expect(() => grid?.at("cue:nowhere")).toThrow(/no cue/);
    expect(() => grid?.bar(1, 5)).toThrow(/beat 5/);
    expect(() => grid?.bar(1.5)).toThrow();
  });

  it("read a time back as its bar, beat and sixteenth", () => {
    const grid = beatGridFor(music, 2000);
    if (!grid) throw new Error("no grid");
    expect(grid.position(grid.bar(13, 3, 2))).toEqual({
      bar: 13,
      beat: 3,
      sixteenth: 2,
      beatPhase: 0.25,
      barPhase: (2 + 0.25) / 4,
    });
    expect(grid.position(grid.bar(0, 4))).toMatchObject({ bar: 0, beat: 4, sixteenth: 1 });
    const mid = grid.position(grid.bar(2) + grid.beatMs * 0.6);
    expect(mid).toMatchObject({ bar: 2, beat: 1, sixteenth: 3 });
    expect(mid.beatPhase).toBeCloseTo(0.6, 2);
  });

  it("leaves unresolvable cues out", () => {
    expect(cuesFor(music, 0)).not.toHaveProperty("broken");
    expect(cuesFor(null, 0)).toEqual({});
  });
});
