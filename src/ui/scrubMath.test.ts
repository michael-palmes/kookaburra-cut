import { describe, expect, it } from "vitest";
import { activeSceneIndex, buildSceneTimeline, timelineTotalMs } from "../engine/sceneTimeline";
import {
  msFromTrackX,
  playheadFraction,
  SCENE_CELL_FLOOR,
  SCRUB_STEP_MS,
  type SceneCellSpan,
  sceneCellSpans,
} from "./scrubMath";

describe("msFromTrackX (the scrub mapping pin)", () => {
  it("is proportional and snapped to the 16ms step (range-input parity)", () => {
    expect(msFromTrackX(0, 400, 8000)).toBe(0);
    expect(msFromTrackX(400, 400, 8000)).toBe(8000);
    expect(msFromTrackX(200, 400, 8000)).toBe(4000);
    // 100/400 of 8000 = 2000 → already on the grid; 101px = 2020 → snaps to 2016.
    expect(msFromTrackX(101, 400, 8000)).toBe(2016);
  });

  it("clamps outside the track and never exceeds the duration", () => {
    expect(msFromTrackX(-50, 400, 8000)).toBe(0);
    expect(msFromTrackX(999, 400, 8000)).toBe(8000);
    // Snapping at the far end can't round past the duration.
    expect(msFromTrackX(400, 400, 8005)).toBe(8005);
  });

  it("degrades to 0 on empty tracks/durations", () => {
    expect(msFromTrackX(10, 0, 8000)).toBe(0);
    expect(msFromTrackX(10, 400, 0)).toBe(0);
  });
});

describe("playheadFraction", () => {
  it("clamps to [0,1]", () => {
    expect(playheadFraction(-5, 100)).toBe(0);
    expect(playheadFraction(50, 100)).toBe(0.5);
    expect(playheadFraction(150, 100)).toBe(1);
    expect(playheadFraction(10, 0)).toBe(0);
  });
});

describe("sceneCellSpans (cells tile the track on attribution boundaries)", () => {
  it("weights mid-transition to mid-transition so the drawn change sits halfway through each overlap", () => {
    // Three scenes with a 600ms crossfade into each: starts 0 / 2400 / 4800, total 7400.
    const slots = [
      { startMs: 0, durationMs: 3000 },
      { startMs: 2400, durationMs: 3000, transitionIn: { durationMs: 600 } },
      { startMs: 4800, durationMs: 2600, transitionIn: { durationMs: 600 } },
    ];
    const spans = sceneCellSpans(slots, 7400);
    expect(spans.map((s) => s.weight)).toEqual([2700, 2400, 2300]);
    expect(spans.reduce((sum, s) => sum + s.weight, 0)).toBe(7400);
  });

  it("degrades to start boundaries on hard cuts (no overlap to halve)", () => {
    const slots = [
      { startMs: 0, durationMs: 2000 },
      { startMs: 2000, durationMs: 1000 },
    ];
    expect(sceneCellSpans(slots, 3000).map((s) => s.weight)).toEqual([2000, 1000]);
  });

  it("a single scene owns the whole track", () => {
    expect(sceneCellSpans([{ startMs: 0, durationMs: 3000 }], 3000)).toEqual([
      { index: 0, weight: 3000, startMs: 0, endMs: 3000 },
    ]);
  });
});

/** Hard-cut slots from a list of durations: no overlaps, so attribution boundaries are the starts. */
const cutSlots = (durations: number[]) => {
  let at = 0;
  return durations.map((durationMs) => {
    const startMs = at;
    at += durationMs;
    return { startMs, durationMs };
  });
};

const totalWeight = (spans: SceneCellSpan[]) => spans.reduce((sum, s) => sum + s.weight, 0);
const shares = (spans: SceneCellSpan[]) => spans.map((s) => s.weight / totalWeight(spans));

/** Which cell a display fraction lands in, accumulated exactly as the mapping does. */
const cellAtFraction = (spans: SceneCellSpan[], fraction: number) => {
  const total = totalWeight(spans);
  let acc = 0;
  for (let i = 0; i < spans.length; i++) {
    const share = spans[i].weight / total;
    if (fraction < acc + share) return i;
    acc += share;
  }
  return spans.length - 1;
};

describe("sceneCellSpans (the 8% display floor)", () => {
  it("is a no-op when every cell already clears the floor", () => {
    const spans = sceneCellSpans(cutSlots([3000, 2000, 5000]), 10000);
    expect(spans.map((s) => s.weight)).toEqual([3000, 2000, 5000]);
    expect(spans.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 3000],
      [3000, 5000],
      [5000, 10000],
    ]);
  });

  it("pins one tiny cell to the floor and rescales the rest in proportion", () => {
    const spans = sceneCellSpans(cutSlots([5000, 100, 4900]), 10000);
    expect(totalWeight(spans)).toBeCloseTo(10000, 6);
    expect(shares(spans)[1]).toBeCloseTo(SCENE_CELL_FLOOR, 12);
    expect(spans[0].weight / spans[2].weight).toBeCloseTo(5000 / 4900, 12);
    // The attribution windows are the true ones, untouched by the display floor.
    expect(spans.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 5000],
      [5000, 5100],
      [5100, 10000],
    ]);
  });

  it("pins two tiny cells and keeps the survivors proportional", () => {
    const spans = sceneCellSpans(cutSlots([4900, 100, 100, 4900]), 10000);
    const s = shares(spans);
    expect(s[1]).toBeCloseTo(SCENE_CELL_FLOOR, 12);
    expect(s[2]).toBeCloseTo(SCENE_CELL_FLOOR, 12);
    expect(s[0]).toBeCloseTo(0.42, 12);
    expect(s[3]).toBeCloseTo(0.42, 12);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("cascades: a cell pushed under the floor by an earlier pin is pinned too", () => {
    // Raw shares 0.01 / 0.082 / 0.454 / 0.454: the second clears the floor until the first is pinned.
    const s = shares(sceneCellSpans(cutSlots([100, 820, 4540, 4540]), 10000));
    expect(s[0]).toBeCloseTo(SCENE_CELL_FLOOR, 12);
    expect(s[1]).toBeCloseTo(SCENE_CELL_FLOOR, 12);
    expect(s[2]).toBeCloseTo(0.42, 12);
    expect(s[3]).toBeCloseTo(0.42, 12);
  });

  it("falls back to equal widths when the floor cannot fit (n * FLOOR >= 1)", () => {
    const durations = Array.from({ length: 13 }, (_, i) => 100 + i * 100);
    const total = durations.reduce((a, b) => a + b, 0);
    const spans = sceneCellSpans(cutSlots(durations), total);
    expect(spans.every((s) => s.weight === spans[0].weight)).toBe(true);
    expect(spans[0].weight).toBeCloseTo(total / 13, 9);
    // Time attribution is untouched: only the drawn widths are equalised.
    expect(spans[0].endMs).toBe(100);
    expect(spans[12].endMs).toBe(total);
  });
});

describe("the piecewise mapping (spans-driven scrub)", () => {
  // Scene b is 400ms long inside a 10.8s project, so its cell is floored.
  const slots = buildSceneTimeline([
    { id: "a", durationMs: 5000, transition: { type: "crossfade", durationMs: 600 } },
    { id: "b", durationMs: 400, transition: { type: "crossfade", durationMs: 200 } },
    { id: "c", durationMs: 6000 },
  ]);
  const totalMs = timelineTotalMs(slots);
  const spans = sceneCellSpans(slots, totalMs);

  it("stages a floored fixture (boundaries mid-transition, cell b widened)", () => {
    expect(totalMs).toBe(10800);
    expect(spans.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 4800],
      [4800, 4900],
      [4900, 10800],
    ]);
    expect(shares(spans)[1]).toBeCloseTo(SCENE_CELL_FLOOR, 12);
  });

  it("without spans it is byte-for-byte the old linear mapping", () => {
    for (let x = 0; x <= 400; x++) {
      expect(msFromTrackX(x, 400, totalMs, undefined)).toBe(msFromTrackX(x, 400, totalMs));
    }
    expect(msFromTrackX(101, 400, 8000, undefined)).toBe(2016);
    expect(playheadFraction(50, 100, undefined)).toBe(0.5);
  });

  it("reduces to the linear mapping when no cell is floored", () => {
    const flat = sceneCellSpans(cutSlots([2000, 2000, 4000]), 8000);
    for (let x = 0; x <= 400; x++) {
      expect(msFromTrackX(x, 400, 8000, flat)).toBe(msFromTrackX(x, 400, 8000));
    }
    for (let ms = 0; ms <= 8000; ms += 37) {
      expect(playheadFraction(ms, 8000, flat)).toBeCloseTo(playheadFraction(ms, 8000), 12);
    }
    // Uneven cells agree too, bar the odd x whose linear value sits exactly on a snap tie.
    const uneven = sceneCellSpans(cutSlots([2700, 2400, 2300]), 7400);
    for (let x = 0; x <= 400; x++) {
      const delta = Math.abs(msFromTrackX(x, 400, 7400, uneven) - msFromTrackX(x, 400, 7400));
      expect(delta).toBeLessThanOrEqual(SCRUB_STEP_MS);
    }
  });

  it("maps the floored cell across its own attribution window", () => {
    const s = shares(spans);
    const width = 800;
    const mid = (s[0] + s[1] / 2) * width;
    // The middle of cell b's display width is the middle of its 100ms window (snapped).
    expect(msFromTrackX(mid, width, totalMs, spans)).toBe(4848);
    expect(msFromTrackX(s[0] * width, width, totalMs, spans)).toBe(4800);
  });

  it("round trips x → ms → x inside a cell (within the snap step)", () => {
    const width = 800;
    for (const x of [10, 120, 330, 350, 400, 500, 640, 790]) {
      const ms = msFromTrackX(x, width, totalMs, spans);
      const back = playheadFraction(ms, totalMs, spans) * width;
      expect(Math.abs(back - x)).toBeLessThanOrEqual(6);
    }
  });

  it("agrees with activeSceneIndex on every ms of the project", () => {
    for (let ms = 0; ms < totalMs; ms += 7) {
      expect(cellAtFraction(spans, playheadFraction(ms, totalMs, spans))).toBe(
        activeSceneIndex(slots, ms),
      );
    }
    // The boundaries themselves: the first ms of each attribution window.
    for (const span of spans) {
      expect(cellAtFraction(spans, playheadFraction(span.startMs, totalMs, spans))).toBe(
        span.index,
      );
      expect(cellAtFraction(spans, playheadFraction(span.endMs - 1, totalMs, spans))).toBe(
        span.index,
      );
    }
  });

  it("keeps both ends exact", () => {
    expect(msFromTrackX(0, 800, totalMs, spans)).toBe(0);
    expect(msFromTrackX(-40, 800, totalMs, spans)).toBe(0);
    expect(msFromTrackX(800, 800, totalMs, spans)).toBe(totalMs);
    expect(msFromTrackX(1200, 800, totalMs, spans)).toBe(totalMs);
    expect(msFromTrackX(800, 800, 10805, spans)).toBe(10805);
    expect(playheadFraction(0, totalMs, spans)).toBe(0);
    expect(playheadFraction(totalMs, totalMs, spans)).toBe(1);
    expect(playheadFraction(totalMs + 500, totalMs, spans)).toBe(1);
  });

  it("degrades to the linear mapping on empty or weightless spans", () => {
    expect(msFromTrackX(200, 400, 8000, [])).toBe(4000);
    expect(playheadFraction(2000, 8000, [])).toBe(0.25);
  });
});
