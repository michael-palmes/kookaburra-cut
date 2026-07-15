import { describe, expect, it } from "vitest";
import type { EffectsConfig } from "../theme/tokens";
import {
  blendEffectParams,
  grainSeed,
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
