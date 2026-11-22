import { describe, expect, it } from "vitest";
import { mergeExportTiming } from "./exportTiming";

describe("mergeExportTiming", () => {
  it("names what a frame's round trip cost beyond the stage's own phases", () => {
    const merged = mergeExportTiming(
      { frames: 10, ms: { stage: 500.4, push: 200.2, finish: 30 } },
      { frames: 10, ms: { prepare: 900, commit: 100, clips: 50, draw: 40, read: 250 } },
    );
    expect(merged).toEqual({
      frames: 10,
      ms: {
        push: 200,
        finish: 30,
        prepare: 900,
        commit: 100,
        clips: 50,
        draw: 40,
        read: 250,
        handoff: 60,
      },
    });
  });

  it("keeps the window's phases when the stage reported none", () => {
    expect(mergeExportTiming({ frames: 1, ms: { stage: 20, push: 5 } }, null)).toEqual({
      frames: 1,
      ms: { push: 5 },
    });
  });
});
