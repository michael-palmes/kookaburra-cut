import { describe, expect, it } from "vitest";
import { buildSceneTimeline } from "./sceneTimeline";
import { crossfadeProbes, outgoingWeight } from "./transitionCheck";

const frame = (rgb: [number, number, number], pixels = 16) => {
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < out.length; i += 4) out.set([...rgb, 255], i);
  return out;
};

describe("crossfadeProbes", () => {
  it("probes each crossfade either side of its overlap and at its midpoint", () => {
    const slots = buildSceneTimeline([
      { id: "a", durationMs: 1500, transition: { type: "crossfade", durationMs: 600 } },
      { id: "b", durationMs: 1800, transition: { type: "push", durationMs: 600 } },
      {
        id: "c",
        durationMs: 2000,
        transition: { type: "crossfade", durationMs: 400, ease: "smooth" },
      },
      { id: "d", durationMs: 1600 },
    ]);
    expect(crossfadeProbes(slots, 30)).toEqual([
      {
        fromIndex: 0,
        toIndex: 1,
        beforeMs: 900 - 1000 / 30,
        midMs: 1200,
        afterMs: 1500,
        expected: 0.5,
      },
      {
        fromIndex: 2,
        toIndex: 3,
        beforeMs: 3700 - 1000 / 30,
        midMs: 3900,
        afterMs: 4100,
        expected: 0.5,
      },
    ]);
  });

  it("skips hard cuts", () => {
    expect(
      crossfadeProbes(
        buildSceneTimeline([
          { id: "a", durationMs: 1000 },
          { id: "b", durationMs: 1000 },
        ]),
        30,
      ),
    ).toEqual([]);
  });
});

describe("outgoingWeight", () => {
  it("reads the outgoing scene's share of the midpoint", () => {
    expect(
      outgoingWeight(frame([240, 240, 240]), frame([140, 130, 120]), frame([40, 20, 0])),
    ).toBeCloseTo(0.5, 2);
  });

  it("reads zero when the outgoing scene is missing from the midpoint", () => {
    expect(outgoingWeight(frame([240, 240, 240]), frame([40, 20, 0]), frame([40, 20, 0]))).toBe(0);
  });

  it("gives up on scenes too alike to tell apart", () => {
    expect(
      outgoingWeight(frame([100, 100, 100]), frame([101, 101, 101]), frame([102, 102, 102])),
    ).toBeNull();
  });
});
