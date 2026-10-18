import { describe, expect, it } from "vitest";
import {
  isMusicPosition,
  type ProjectMusic,
  resolveMusicPosition,
  resolveSceneLocalMs,
  roundMs,
} from "./musicTime";

const music = (over: Partial<ProjectMusic> = {}): ProjectMusic => ({
  grid: { bpm: 120, offsetMs: 250, beatsPerBar: 4 },
  startOffsetMs: 0,
  cues: { drop: "bar:9", raw: 4000, loop: "cue:drop", early: "bar:9-40ms" },
  sections: { chorus: { from: "bar:17.3", to: "bar:25" } },
  ...over,
});

const ms = (text: string, m = music()) => {
  const r = resolveMusicPosition(text, m);
  if (!r.ok) throw new Error(`${text}: ${r.code}`);
  return r.projectMs;
};

const code = (text: string, m = music()) => {
  const r = resolveMusicPosition(text, m);
  return r.ok ? "ok" : r.code;
};

describe("resolveMusicPosition", () => {
  it("places bars, beats and sixteenths 1-based from the grid offset", () => {
    expect(ms("bar:1")).toBe(250);
    expect(ms("bar:1.2")).toBe(750);
    expect(ms("bar:1.1.3")).toBe(500);
    expect(ms("bar:2")).toBe(2250);
    expect(ms("bar:13.3")).toBe(250 + (12 * 4 + 2) * 500);
  });

  it("treats bar 0 and below as pickups", () => {
    expect(ms("bar:0.4")).toBe(250 - 500);
    expect(ms("bar:-1")).toBe(250 - 8 * 500);
  });

  it("applies nudges and the soundtrack start offset", () => {
    expect(ms("bar:2+40ms")).toBe(2290);
    expect(ms("bar:2-12.5ms")).toBe(2237.5);
    expect(ms("bar:2", music({ startOffsetMs: 1000 }))).toBe(1250);
  });

  it("resolves cues and sections, one level deep", () => {
    expect(ms("cue:drop")).toBe(ms("bar:9"));
    expect(ms("cue:raw")).toBe(4000);
    expect(ms("cue:early+40ms")).toBe(ms("bar:9"));
    expect(ms("section:chorus")).toBe(ms("bar:17.3"));
    expect(code("cue:loop")).toBe("nested");
  });

  it("reports every error kind", () => {
    expect(code("beat:13.3")).toBe("syntax");
    expect(code("bar:13.")).toBe("syntax");
    expect(code("bar:13+40")).toBe("syntax");
    expect(code("cue:Drop")).toBe("syntax");
    expect(code("bar:1", music({ grid: undefined }))).toBe("no-grid");
    expect(code("cue:raw", music({ grid: undefined }))).toBe("ok");
    expect(code("bar:1.5")).toBe("range");
    expect(code("bar:1.0")).toBe("range");
    expect(code("bar:1.1.5")).toBe("range");
    expect(code("bar:100001")).toBe("range");
    expect(code("cue:missing")).toBe("unknown");
    expect(code("section:missing")).toBe("unknown");
  });

  it("recognises the grammar without resolving", () => {
    expect(isMusicPosition("bar:12.3.2-8ms")).toBe(true);
    expect(isMusicPosition("16th:12.10")).toBe(false);
  });
});

describe("roundMs", () => {
  it("rounds halves toward +infinity like Math.round", () => {
    expect(roundMs(0.5)).toBe(1);
    expect(roundMs(-0.5)).toBe(-0);
    expect(roundMs(1.5)).toBe(2);
    expect(roundMs(0.49999999999999994)).toBe(0);
  });

  it("gives scene-local integer ms", () => {
    const r = resolveSceneLocalMs(
      "bar:2",
      music({ grid: { bpm: 135.11, offsetMs: 447.5, beatsPerBar: 4 } }),
      1000,
    );
    expect(r).toEqual({ ok: true, projectMs: roundMs(447.5 + 4 * (60000 / 135.11) - 1000) });
  });
});
