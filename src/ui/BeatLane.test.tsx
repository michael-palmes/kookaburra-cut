import { describe, expect, it, vi } from "vitest";
import type { BeatAnalysis } from "../engine/beatAnalysis";
import type { AudioGridSpec } from "../engine/project";
import { beatGridMenuItems } from "./BeatLane";

const analysis: BeatAnalysis = {
  version: 2,
  sha256: "sha",
  tracker: "nn",
  fallbackReason: null,
  durationMs: 60000,
  bpm: 120,
  fit: {
    bpm: 120,
    offsetMs: 250,
    beatsPerBar: 4,
    periodMs: 500,
    phaseMs: 250,
    residualMs: 0.9,
    maxDriftMs: 2,
    constantTempo: true,
  },
  beats: [],
  beatInfo: [],
  downbeats: [250, 2250, 4250],
  keyMoments: [],
  envelope: { hopMs: 21.333, values: [] },
  energy: null,
  sections: [],
  breaths: [],
  stabs: [],
  lyrics: null,
};

const grid: AudioGridSpec = { bpm: 120, offsetMs: 250, beatsPerBar: 4 };

describe("beat lane grid menu", () => {
  it("offers Set downbeat here and Make this bar 1, each with a leading icon", () => {
    const items = beatGridMenuItems({ grid, analysis, trackMs: 4300, onSetGrid: vi.fn() });
    expect(items.map((item) => item.label)).toEqual(["Set downbeat here", "Make this bar 1"]);
    for (const item of items) expect(item.icon).toBeTruthy();
  });

  it("Set downbeat here shifts the phase and keeps bar numbers", () => {
    const onSetGrid = vi.fn();
    beatGridMenuItems({ grid, analysis, trackMs: 4300, onSetGrid })[0].onSelect();
    expect(onSetGrid).toHaveBeenCalledWith({ ...grid, offsetMs: 300 });
  });

  it("Make this bar 1 starts bar 1 on the clicked downbeat", () => {
    const onSetGrid = vi.fn();
    beatGridMenuItems({ grid, analysis, trackMs: 4400, onSetGrid })[1].onSelect();
    expect(onSetGrid).toHaveBeenCalledWith({ ...grid, offsetMs: 4250 });
  });

  it("creates a grid from the detected tempo when there is none", () => {
    const onSetGrid = vi.fn();
    beatGridMenuItems({ grid: undefined, analysis, trackMs: 2300, onSetGrid })[0].onSelect();
    expect(onSetGrid).toHaveBeenCalledWith(
      expect.objectContaining({
        bpm: 120,
        beatsPerBar: 4,
        offsetMs: 300,
        source: expect.anything(),
      }),
    );
  });

  it("is disabled with no tempo to start from", () => {
    const onSetGrid = vi.fn();
    const items = beatGridMenuItems({ grid: undefined, analysis: null, trackMs: 2300, onSetGrid });
    expect(items.every((item) => item.disabled)).toBe(true);
    for (const item of items) item.onSelect();
    expect(onSetGrid).not.toHaveBeenCalled();
  });
});
