import { describe, expect, it } from "vitest";
import {
  activeSceneIndex,
  applyTransitionEase,
  buildSceneTimeline,
  normalizeTransitionType,
  resolveAt,
  resolveTransitionParams,
  type TimelineSceneInput,
  timelineTotalMs,
} from "./sceneTimeline";

const scenes = (...specs: TimelineSceneInput[]) => specs;

describe("buildSceneTimeline — hard cuts (no transition)", () => {
  const slots = buildSceneTimeline(
    scenes({ id: "a", durationMs: 5000 }, { id: "b", durationMs: 5000 }),
  );

  it("lays scenes back-to-back with cumulative offsets", () => {
    expect(slots[0]).toMatchObject({ index: 0, startMs: 0, endMs: 5000, durationMs: 5000 });
    expect(slots[1]).toMatchObject({ index: 1, startMs: 5000, endMs: 10000, durationMs: 5000 });
  });

  it("has no transitionIn on either slot", () => {
    expect(slots[0].transitionIn).toBeUndefined();
    expect(slots[1].transitionIn).toBeUndefined();
  });

  it("total length is the simple sum", () => {
    expect(timelineTotalMs(slots)).toBe(10000);
  });
});

describe("buildSceneTimeline — overlap (cross-dissolve) timing", () => {
  const slots = buildSceneTimeline(
    scenes(
      { id: "a", durationMs: 5000, transition: { type: "crossfade", durationMs: 500 } },
      { id: "b", durationMs: 5000 },
    ),
  );

  it("starts B 500ms before A ends", () => {
    expect(slots[0]).toMatchObject({ startMs: 0, endMs: 5000 });
    expect(slots[1]).toMatchObject({ startMs: 4500, endMs: 9500 });
  });

  it("records the (clamped) overlap as B's transitionIn", () => {
    expect(slots[1].transitionIn).toMatchObject({ type: "crossfade", durationMs: 500 });
  });

  it("total = sum(durations) − sum(overlaps)", () => {
    expect(timelineTotalMs(slots)).toBe(9500);
  });

  it("subtracts every overlap across a chain", () => {
    const chain = buildSceneTimeline(
      scenes(
        { id: "a", durationMs: 5000, transition: { type: "crossfade", durationMs: 500 } },
        { id: "b", durationMs: 5000, transition: { type: "wipe", durationMs: 500 } },
        { id: "c", durationMs: 5000 },
      ),
    );
    expect(timelineTotalMs(chain)).toBe(14000);
  });

  it("clamps an over-long transition to the neighbouring durations (never negative starts)", () => {
    const tiny = buildSceneTimeline(
      scenes(
        { id: "a", durationMs: 1000, transition: { type: "crossfade", durationMs: 5000 } },
        { id: "b", durationMs: 1000 },
      ),
    );
    expect(tiny[1].startMs).toBeGreaterThanOrEqual(0);
    expect(tiny[1].transitionIn?.durationMs).toBe(1000);
  });

  it("ignores a transition on the last scene (nothing to exit into)", () => {
    const slots = buildSceneTimeline(
      scenes(
        { id: "a", durationMs: 5000 },
        { id: "b", durationMs: 5000, transition: { type: "crossfade", durationMs: 500 } },
      ),
    );
    expect(slots[1].transitionIn).toBeUndefined();
    expect(timelineTotalMs(slots)).toBe(10000);
  });
});

describe("resolveAt — single active scene (fast path)", () => {
  const slots = buildSceneTimeline(
    scenes({ id: "a", durationMs: 5000 }, { id: "b", durationMs: 5000 }),
  );

  it("maps global time to one scene's local time", () => {
    expect(resolveAt(slots, 0)).toEqual({ active: [{ index: 0, localMs: 0 }] });
    expect(resolveAt(slots, 2500)).toEqual({ active: [{ index: 0, localMs: 2500 }] });
  });

  it("half-open intervals: the boundary belongs to the next scene", () => {
    expect(resolveAt(slots, 5000)).toEqual({ active: [{ index: 1, localMs: 0 }] });
    expect(resolveAt(slots, 7500)).toEqual({ active: [{ index: 1, localMs: 2500 }] });
  });

  it("never reports a transition for hard cuts", () => {
    expect(resolveAt(slots, 4999).transition).toBeUndefined();
    expect(resolveAt(slots, 5000).transition).toBeUndefined();
  });

  it("clamps out-of-range time to the ends", () => {
    expect(resolveAt(slots, -100)).toEqual({ active: [{ index: 0, localMs: 0 }] });
    expect(resolveAt(slots, 999999)).toEqual({ active: [{ index: 1, localMs: 5000 }] });
  });
});

describe("resolveAt — during an overlap (two active scenes + transition)", () => {
  const slots = buildSceneTimeline(
    scenes(
      {
        id: "a",
        durationMs: 5000,
        transition: { type: "slide", durationMs: 500, direction: [1, 0] },
      },
      { id: "b", durationMs: 5000 },
    ),
  );

  it("reports both scenes with their own local times", () => {
    const r = resolveAt(slots, 4750);
    expect(r.active).toEqual([
      { index: 0, localMs: 4750 }, // A's tail
      { index: 1, localMs: 250 }, // B's head
    ]);
  });

  it("derives transition progress from the overlap window", () => {
    expect(resolveAt(slots, 4500).transition?.progress).toBeCloseTo(0, 5);
    expect(resolveAt(slots, 4750).transition?.progress).toBeCloseTo(0.5, 5);
    expect(resolveAt(slots, 4900).transition?.progress).toBeCloseTo(0.8, 5);
  });

  it("carries type/direction and from→to indices (A→B)", () => {
    const tr = resolveAt(slots, 4750).transition;
    expect(tr).toMatchObject({ type: "slide", direction: [1, 0], fromIndex: 0, toIndex: 1 });
  });

  it("exits the transition exactly at A's end (B becomes solo)", () => {
    expect(resolveAt(slots, 5000)).toEqual({ active: [{ index: 1, localMs: 500 }] });
  });
});

describe("resolveAt — determinism contract", () => {
  const slots = buildSceneTimeline(
    scenes(
      { id: "a", durationMs: 5000, transition: { type: "crossfade", durationMs: 500 } },
      { id: "b", durationMs: 5000 },
    ),
  );

  it("same input → identical output", () => {
    expect(resolveAt(slots, 4730)).toEqual(resolveAt(slots, 4730));
  });
});

describe("normalizeTransitionType (v10 M2)", () => {
  it("passes every known type through", () => {
    for (const t of [
      "crossfade",
      "dip",
      "slide",
      "wipe",
      "blur",
      "push",
      "zoom",
      "whip",
      "luma",
      "glitch",
      "slice",
      "dissolve",
      "warp",
    ] as const) {
      expect(normalizeTransitionType(t)).toBe(t);
    }
  });

  it("degrades unknown types to crossfade", () => {
    expect(normalizeTransitionType("sparkle")).toBe("crossfade");
    expect(normalizeTransitionType("")).toBe("crossfade");
  });

  it("normalizes inside buildSceneTimeline so slots never carry unknown types", () => {
    const slots = buildSceneTimeline([
      {
        id: "a",
        durationMs: 2000,
        transition: { type: "warpspeed" as never, durationMs: 500 },
      },
      { id: "b", durationMs: 2000 },
    ]);
    expect(slots[1].transitionIn?.type).toBe("crossfade");
  });
});

describe("resolveTransitionParams (v10 M2)", () => {
  it("bakes per-type intensity defaults", () => {
    const base = { durationMs: 600 } as const;
    expect(resolveTransitionParams({ type: "blur", ...base }).intensity).toBeCloseTo(0.05);
    expect(resolveTransitionParams({ type: "zoom", ...base }).intensity).toBeCloseTo(0.35);
    expect(resolveTransitionParams({ type: "whip", ...base }).intensity).toBeCloseTo(0.12);
    expect(resolveTransitionParams({ type: "glitch", ...base }).intensity).toBeCloseTo(0.5);
    expect(resolveTransitionParams({ type: "crossfade", ...base }).intensity).toBe(0);
  });

  it("clamps and rounds numerics into safe ranges", () => {
    const p = resolveTransitionParams({
      type: "glitch",
      durationMs: 600,
      intensity: 7,
      softness: 0,
      steps: 999.7,
      blocks: [0.2, 4000] as [number, number],
      parallax: -2,
      center: [9, -9] as [number, number],
    });
    expect(p.intensity).toBe(1);
    expect(p.softness).toBeCloseTo(0.005);
    expect(p.steps).toBe(60);
    expect(p.blocks).toEqual([1, 128]);
    expect(p.parallax).toBe(0);
    expect(p.center).toEqual([1, 0]);
  });

  it("rejects junk shapes and non-finite numbers", () => {
    const p = resolveTransitionParams({
      type: "luma",
      durationMs: 600,
      shape: "spiral" as never,
      softness: Number.NaN,
    });
    expect(p.shape).toBe("linear");
    expect(p.softness).toBeCloseTo(0.08);
  });

  it("resolveAt carries baked params on the resolved transition", () => {
    const slots = buildSceneTimeline([
      { id: "a", durationMs: 2000, transition: { type: "blur", durationMs: 500 } },
      { id: "b", durationMs: 2000 },
    ]);
    const mid = resolveAt(slots, 1750);
    expect(mid.transition?.type).toBe("blur");
    expect(mid.transition?.params.intensity).toBeCloseTo(0.05);
  });
});

describe("activeSceneIndex (the editing chrome's dominant scene — moved from EditBar, v13 M1)", () => {
  it("returns the sole scene under the playhead", () => {
    const slots = buildSceneTimeline(
      scenes({ id: "a", durationMs: 2000 }, { id: "b", durationMs: 3000 }),
    );
    expect(activeSceneIndex(slots, 0)).toBe(0);
    expect(activeSceneIndex(slots, 1999)).toBe(0);
    expect(activeSceneIndex(slots, 2000)).toBe(1);
  });

  it("prefers the LATER scene inside a transition overlap", () => {
    const slots = buildSceneTimeline(
      scenes(
        { id: "a", durationMs: 2000, transition: { type: "crossfade", durationMs: 600 } },
        { id: "b", durationMs: 2000 },
      ),
    );
    // Overlap window is [1400, 2000): both scenes are live; the incoming one wins.
    expect(activeSceneIndex(slots, 1500)).toBe(1);
    expect(activeSceneIndex(slots, 1399)).toBe(0);
  });

  it("pins the out-of-range fallback: no scene under the playhead → index 0 (the v7 semantics)", () => {
    // Callers keep the clock inside the timeline; at/past the exact end nothing matches the half-open windows, so behaviour falls back to the first scene, pinned verbatim from the EditBar original and must not change.
    const slots = buildSceneTimeline(
      scenes({ id: "a", durationMs: 1000 }, { id: "b", durationMs: 1000 }),
    );
    expect(activeSceneIndex(slots, 1999)).toBe(1);
    expect(activeSceneIndex(slots, 2000)).toBe(0);
    expect(activeSceneIndex(slots, 99999)).toBe(0);
  });
});

describe("applyTransitionEase (v14)", () => {
  it("preserves endpoints for every curve (the seam byte contract)", () => {
    for (const ease of ["linear", "smooth", "snappy"] as const) {
      expect(applyTransitionEase(ease, 0)).toBe(0);
      expect(applyTransitionEase(ease, 1)).toBe(1);
    }
    expect(applyTransitionEase(undefined, 0.25)).toBe(0.25);
  });

  it("smooth is smoothstep and snappy front-loads", () => {
    expect(applyTransitionEase("smooth", 0.5)).toBeCloseTo(0.5, 10);
    expect(applyTransitionEase("smooth", 0.25)).toBeCloseTo(0.15625, 10);
    expect(applyTransitionEase("snappy", 0.25)).toBeCloseTo(1 - 0.75 ** 3, 10);
    expect(applyTransitionEase("snappy", 0.25)).toBeGreaterThan(0.25);
  });

  it("resolveAt eases the reported progress; absent ease stays linear", () => {
    const eased = buildSceneTimeline([
      {
        id: "a",
        durationMs: 2000,
        transition: { type: "crossfade", durationMs: 500, ease: "smooth" },
      },
      { id: "b", durationMs: 2000 },
    ]);
    expect(resolveAt(eased, 1625).transition?.progress).toBeCloseTo(0.15625, 10);
    const plain = buildSceneTimeline([
      { id: "a", durationMs: 2000, transition: { type: "crossfade", durationMs: 500 } },
      { id: "b", durationMs: 2000 },
    ]);
    expect(resolveAt(plain, 1625).transition?.progress).toBeCloseTo(0.25, 10);
  });
});
