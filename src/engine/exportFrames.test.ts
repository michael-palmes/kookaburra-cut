import { describe, expect, it } from "vitest";
import { exportFrameTimeMs, normalExportFrameCount, posterFrameSample } from "./exportFrames";
import { buildSceneTimeline, resolveAt } from "./sceneTimeline";

describe("export frame schedule", () => {
  it("keeps the normal frame count and timestamps unchanged", () => {
    expect(normalExportFrameCount(10_000, 60)).toBe(600);
    expect(exportFrameTimeMs(0, 60)).toBe(0);
    expect(exportFrameTimeMs(1, 60)).toBe(1000 / 60);
  });

  it("chooses the lower centre sample on the selected output grid", () => {
    const slots = buildSceneTimeline([{ id: "first", durationMs: 4000 }]);
    expect(posterFrameSample(slots, 60).tMs).toBe(119 * (1000 / 60));
    expect(posterFrameSample(slots, 30).tMs).toBe(59 * (1000 / 30));
  });

  it("uses frame zero when scene one contains a single output frame", () => {
    const poster = posterFrameSample(
      buildSceneTimeline([{ id: "first", durationMs: 1000 / 60 }]),
      60,
    );
    expect(poster).toEqual({ tMs: 0, resolved: { active: [{ index: 0, localMs: 0 }] } });
  });

  it("renders scene one alone when its sample lies in an outgoing transition", () => {
    const slots = buildSceneTimeline([
      { id: "first", durationMs: 1000, transition: { type: "crossfade", durationMs: 800 } },
      { id: "second", durationMs: 1000 },
    ]);
    const poster = posterFrameSample(slots, 60);
    expect(resolveAt(slots, poster.tMs).active).toHaveLength(2);
    expect(poster.resolved).toEqual({ active: [{ index: 0, localMs: poster.tMs }] });
  });

  it("puts one poster sample before the unchanged normal sequence", () => {
    const posterMs = posterFrameSample(
      buildSceneTimeline([{ id: "first", durationMs: 4000 }]),
      30,
    ).tMs;
    expect(exportFrameTimeMs(0, 30, posterMs)).toBe(posterMs);
    expect(exportFrameTimeMs(1, 30, posterMs)).toBe(0);
    expect(exportFrameTimeMs(2, 30, posterMs)).toBe(1000 / 30);
  });
});
