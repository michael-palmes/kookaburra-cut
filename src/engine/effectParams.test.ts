import { describe, expect, it } from "vitest";
import type { EffectsConfig } from "../theme/tokens";
import {
  blendEffectParams,
  GRAIN_HOLD_MAX,
  grainSeed,
  heldGrainSeed,
  resolveEffectParams,
  sceneBaseEffects,
} from "./effectParams";

describe("grainSeed — deterministic per-frame grain seed", () => {
  it("is 0 at t=0", () => {
    expect(grainSeed(0, 60)).toBe(0);
  });

  it("recovers the exact frame index at the canonical clock step tMs = frame * 1000/fps", () => {
    // The export loop steps tMs = frame * (1000 / fps); the seed must map back to `frame` exactly (rounding absorbs float error), so grain is a pure function of the frame.
    for (const frame of [1, 30, 59, 60, 137, 1000]) {
      expect(grainSeed((frame * 1000) / 60, 60)).toBe(frame);
    }
  });

  it("rounds to the nearest frame rather than flooring", () => {
    expect(grainSeed(1000, 60)).toBe(60); // 1.0s × 60 = 60
    expect(grainSeed(500, 60)).toBe(30); // 0.5s × 60 = 30
    expect(grainSeed(24, 30)).toBe(1); // 0.024s × 30 = 0.72 → 1
  });
});

describe("heldGrainSeed: the paper boil", () => {
  it("leaves the seed alone without a hold, at 1, or on a malformed one", () => {
    for (const hold of [undefined, 1, 0, -3, 1.4, Number.NaN]) {
      expect(heldGrainSeed(137, hold)).toBe(137);
    }
  });

  it("holds each pattern for exactly `hold` frames from frame 0", () => {
    const seeds = Array.from({ length: 15 }, (_, f) =>
      heldGrainSeed(grainSeed((f * 1000) / 60, 60), 5),
    );
    expect(seeds).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
  });

  it("rounds the hold and caps it at one second", () => {
    expect(heldGrainSeed(9, 2.6)).toBe(3);
    expect(heldGrainSeed(GRAIN_HOLD_MAX * 3 + 1, 10_000)).toBe(3);
  });

  it("holds 3 then 2 output frames on a 30 fps export (the 60 grid's even frames)", () => {
    const seeds = Array.from({ length: 10 }, (_, f) =>
      heldGrainSeed(grainSeed((f * 1000) / 30, 60), 5),
    );
    expect(seeds).toEqual([0, 0, 0, 1, 1, 2, 2, 2, 3, 3]);
  });
});

describe("resolveEffectParams — deep-merge project default + per-scene override", () => {
  const base: EffectsConfig = {
    bloom: { intensity: 1, luminanceThreshold: 0.9, luminanceSmoothing: 0.025 },
    vignette: { offset: 0.3, darkness: 0.5 },
  };

  it("returns the project default unchanged when there is no override", () => {
    expect(resolveEffectParams(base)).toEqual(base);
    expect(resolveEffectParams(base, undefined)).toEqual(base);
  });

  it("does not mutate or alias the project default", () => {
    const out = resolveEffectParams(base, { bloom: { intensity: 3 } });
    expect(base.bloom?.intensity).toBe(1); // base untouched
    expect(out.bloom).not.toBe(base.bloom); // fresh object
  });

  it("shallow-merges a partial override onto an existing effect, keeping unspecified fields", () => {
    expect(resolveEffectParams(base, { bloom: { intensity: 3 } })).toEqual({
      bloom: { intensity: 3, luminanceThreshold: 0.9, luminanceSmoothing: 0.025 },
      vignette: { offset: 0.3, darkness: 0.5 },
    });
  });

  it("adds an effect present only in the override", () => {
    expect(resolveEffectParams(base, { grain: { intensity: 0.08 } })).toEqual({
      bloom: { intensity: 1, luminanceThreshold: 0.9, luminanceSmoothing: 0.025 },
      vignette: { offset: 0.3, darkness: 0.5 },
      grain: { intensity: 0.08 },
    });
  });

  it("leaves effects absent from both the default and the override absent", () => {
    expect(resolveEffectParams({ bloom: base.bloom }, {}).vignette).toBeUndefined();
  });
});

describe("blendEffectParams — lerp an effect stack across a transition", () => {
  const A: EffectsConfig = {
    bloom: { intensity: 1, luminanceThreshold: 0.9, luminanceSmoothing: 0.025 },
    vignette: { offset: 0.3, darkness: 0.5 },
  };
  const B: EffectsConfig = {
    bloom: { intensity: 3, luminanceThreshold: 0.7, luminanceSmoothing: 0.025 },
    grain: { intensity: 0.1 },
  };

  it("returns the A stack at progress 0 and the B stack at progress 1 for a shared effect", () => {
    expect(blendEffectParams(A, B, 0).bloom).toEqual(A.bloom);
    expect(blendEffectParams(A, B, 1).bloom).toEqual(B.bloom);
  });

  it("lerps each numeric field of a shared effect at the midpoint", () => {
    expect(blendEffectParams(A, B, 0.5).bloom).toEqual({
      intensity: 2,
      luminanceThreshold: 0.8,
      luminanceSmoothing: 0.025,
    });
  });

  it("snaps a grain hold at the midpoint instead of holding for a fraction of a frame", () => {
    const held: EffectsConfig = { grain: { intensity: 0.1, hold: 5 } };
    const plain: EffectsConfig = { grain: { intensity: 0.1, hold: 2 } };
    expect(blendEffectParams(held, plain, 0.49).grain?.hold).toBe(5);
    expect(blendEffectParams(held, plain, 0.5).grain?.hold).toBe(2);
  });

  it("fades an A-only effect out toward its amount=0 as progress rises", () => {
    // vignette exists only in A; its amount field (darkness) ramps to 0, offset unchanged.
    expect(blendEffectParams(A, B, 0).vignette).toEqual({ offset: 0.3, darkness: 0.5 });
    expect(blendEffectParams(A, B, 0.5).vignette).toEqual({ offset: 0.3, darkness: 0.25 });
    expect(blendEffectParams(A, B, 1).vignette).toEqual({ offset: 0.3, darkness: 0 });
  });

  it("fades a B-only effect in from amount=0 as progress rises", () => {
    // grain exists only in B; its amount (intensity) ramps up from 0.
    expect(blendEffectParams(A, B, 0).grain).toEqual({ intensity: 0 });
    expect(blendEffectParams(A, B, 1).grain).toEqual({ intensity: 0.1 });
  });

  it("snaps a non-numeric field (LUT url) at the midpoint while lerping its intensity", () => {
    const la: EffectsConfig = { lut: { url: "a.cube", intensity: 1 } };
    const lb: EffectsConfig = { lut: { url: "b.cube", intensity: 0 } };
    expect(blendEffectParams(la, lb, 0.4).lut).toEqual({ url: "a.cube", intensity: 0.6 });
    expect(blendEffectParams(la, lb, 0.5).lut).toEqual({ url: "b.cube", intensity: 0.5 });
    expect(blendEffectParams(la, lb, 0.6).lut).toEqual({ url: "b.cube", intensity: 0.4 });
  });
});

describe("sceneBaseEffects (v8 per-scene theme swaps)", () => {
  const projectDefault: EffectsConfig = {
    bloom: { intensity: 1, luminanceThreshold: 0.5, luminanceSmoothing: 0.2 },
  };
  const sceneDefaults: Record<number, EffectsConfig> = {
    1: {}, // theme swap to an effects-free theme: effects OFF for this scene
    2: { grain: { intensity: 0.2 } },
  };

  it("uses the project default when a scene has no theme swap", () => {
    expect(sceneBaseEffects(projectDefault, sceneDefaults, 0)).toBe(projectDefault);
  });

  it("replaces the base WHOLESALE for swapped scenes (empty stack turns effects off)", () => {
    expect(sceneBaseEffects(projectDefault, sceneDefaults, 1)).toEqual({});
    expect(sceneBaseEffects(projectDefault, sceneDefaults, 2)).toEqual({
      grain: { intensity: 0.2 },
    });
  });

  it("manifest overrides still layer on top of a swapped base", () => {
    const base = sceneBaseEffects(projectDefault, sceneDefaults, 2);
    const resolved = resolveEffectParams(base, { grain: { intensity: 0.4 } });
    expect(resolved).toEqual({ grain: { intensity: 0.4 } });
    // The project default's bloom must NOT leak through a swapped base.
    expect(resolved.bloom).toBeUndefined();
  });
});
