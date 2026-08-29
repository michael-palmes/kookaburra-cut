import { describe, expect, it, vi } from "vitest";
import type { Theme } from "../../theme/tokens";
import {
  CHROMA_EM,
  CONVERGE_EM,
  CONVERGE_STREAK,
  computeStaggerUnits,
  DEFAULT_START_SCALE,
  DEVELOP_SOFT_EM,
  DOLLY_EM,
  DOLLY_JITTER_EM,
  DOLLY_NEAR_EM,
  DOLLY_SOFT_EM,
  EDGE_SENTINEL,
  FLIP_DIP_EM,
  FLIP_RAD,
  GLINT_HALF_W,
  GLINT_INTENSITY,
  hasOwnAnimationProps,
  LINE_SCALE_X0,
  LINE_SCALE_Y0,
  MAX_STAGGER_UNITS,
  ORBIT_SWEEP_RAD,
  presetNeedsShaderPath,
  RIBBON_BOW_EM,
  RIBBON_RAD,
  RISE_MASK_EM,
  RISE_MASK_EXIT,
  resolveTextAnimation,
  resolveTextAnimationWithDoc,
  SCATTER_DEPTH_EM,
  SCATTER_FADE_P,
  SCATTER_ROLL_MAX_RAD,
  SCATTER_ROLL_MIN_RAD,
  SCATTER_TILT_RAD,
  SHINE_HALF_W,
  SHINE_INTENSITY,
  SLAM_OUT_SCALE,
  SLAM_OVERSHOOT,
  SLAM_SOFT_EM,
  SLAM_START_SCALE,
  SPOT_DIM,
  SPOT_SCALE,
  SPRING_DAMP,
  SPRING_OUT_BUMP,
  SPRING_START_SCALE,
  STAND_RAD,
  STAND_SETTLE_EM,
  STATIC_TEXT_PRESET,
  sampleTextUnit,
  shineBand,
  type TextAnimTiming,
  type TextPresetName,
  type TextUnitSample,
  TRACK_SOFT_EM,
  TRACK_SPREAD,
  TRACK_TIGHTEN,
  TWIST_RAD,
  TWIST_START_SCALE,
  textAnimationEndMs,
  textAnimationWindowToMs,
  UNDERLINE_RISE_EM,
  underlineProgress,
  unitHash01,
  unitIndexForKey,
  VAPOR_RATE_MIN,
  VAPOR_RISE_EM,
  VAPOR_SOFT_EM,
  VAPOR_WOBBLE_EM,
  WEIGHT_EM,
  WORD_CYCLE_POP_SCALE,
} from "./presets";

const baseTheme: Theme = {
  id: "test",
  name: "Test",
  colors: { background: "#000", text: "#fff", accent: "#08f", muted: "#888" },
  typography: {
    headline: { family: "Inter", weight: 600 },
    body: { family: "Inter", weight: 400 },
    scale: 1.25,
  },
  motion: {
    durations: { fast: 200, base: 500, slow: 900 },
    easings: { standard: "outQuad", emphasized: "outExpo" },
  },
};

const themed: Theme = {
  ...baseTheme,
  textAnimation: { in: "fade-up", out: "fade", staggerMs: 60 },
};

describe("resolveTextAnimation", () => {
  it("returns null when neither props nor theme configure anything (the legacy contract)", () => {
    expect(resolveTextAnimation({}, baseTheme)).toBeNull();
  });

  it("adopts the theme's textAnimation defaults", () => {
    const anim = resolveTextAnimation({}, themed);
    expect(anim).toMatchObject({
      preset: "fade-up",
      outPreset: "fade",
      staggerMs: 60,
      granularity: "word",
      ease: "outQuad",
    });
  });

  it("lets props override the theme", () => {
    const anim = resolveTextAnimation(
      { preset: "slide", outPreset: "none", ease: "outExpo", stagger: "char", staggerMs: 20 },
      themed,
    );
    expect(anim).toMatchObject({
      preset: "slide",
      outPreset: "none",
      ease: "outExpo",
      staggerMs: 20,
      granularity: "char",
    });
  });

  it("coerces unknown preset names to fade", () => {
    expect(resolveTextAnimation({ preset: "wobble" }, baseTheme)?.preset).toBe("fade");
  });

  it("gives a stagger request without a delay the granularity default", () => {
    expect(resolveTextAnimation({ preset: "fade", stagger: "char" }, baseTheme)?.staggerMs).toBe(
      35,
    );
    expect(resolveTextAnimation({ preset: "fade", stagger: "word" }, baseTheme)?.staggerMs).toBe(
      90,
    );
  });

  it("honours an explicit staggerMs of 0 over the granularity default", () => {
    const anim = resolveTextAnimation({ preset: "fade", stagger: "word", staggerMs: 0 }, themed);
    expect(anim?.staggerMs).toBe(0);
  });

  it("drops stagger when the preset resolves to none", () => {
    const anim = resolveTextAnimation({ preset: "none", staggerMs: 40 }, baseTheme);
    expect(anim?.granularity).toBeNull();
  });

  // ── params + delivery + the sidecar spec ──────────────────────────────────
  it("fully defaults params (the pre-v11 inputs resolve exactly as before)", () => {
    expect(resolveTextAnimation({}, themed)?.params).toEqual({
      startScale: DEFAULT_START_SCALE,
      shine: false,
      twistDir: 1,
    });
  });

  it("resolves params from props over the theme, clamping startScale", () => {
    const withTheme: Theme = {
      ...baseTheme,
      textAnimation: {
        in: "fade-scale",
        out: "fade-scale",
        staggerMs: 0,
        startScale: 1.15,
        shine: true,
        direction: "from-right",
      },
    };
    expect(resolveTextAnimation({}, withTheme)?.params).toEqual({
      startScale: 1.15,
      shine: true,
      twistDir: -1,
    });
    expect(resolveTextAnimation({ startScale: 0.9, shine: false }, withTheme)?.params).toEqual({
      startScale: 0.9,
      shine: false,
      twistDir: -1,
    });
    expect(resolveTextAnimation({ startScale: 99 }, baseTheme)?.params.startScale).toBe(4);
    expect(resolveTextAnimation({ startScale: 0 }, baseTheme)?.params.startScale).toBe(0.05);
  });

  it("maps delivery onto granularity; all-at-once FORCES the block path", () => {
    expect(resolveTextAnimation({ delivery: "by-paragraph" }, baseTheme)?.granularity).toBe(
      "paragraph",
    );
    const anim = resolveTextAnimation({ delivery: "by-paragraph" }, baseTheme);
    expect(anim?.staggerMs).toBe(160); // the paragraph default delay
    expect(resolveTextAnimation({ delivery: "by-paragraph-group" }, baseTheme)?.granularity).toBe(
      "paragraph-group",
    );
    // themed staggerMs 60 would imply "word"; all-at-once overrides it to block.
    expect(resolveTextAnimation({ delivery: "all-at-once" }, themed)?.granularity).toBeNull();
    // props.stagger still wins over props.delivery.
    expect(
      resolveTextAnimation({ stagger: "char", delivery: "by-paragraph" }, baseTheme)?.granularity,
    ).toBe("char");
  });

  it("the sidecar spec replaces the theme's whole spec (v11 · M3)", () => {
    const anim = resolveTextAnimation({}, themed, {
      in: "fade-scale",
      out: "none",
      staggerMs: 0,
      startScale: 1.2,
      shine: true,
    });
    expect(anim).toMatchObject({ preset: "fade-scale", outPreset: "none", staggerMs: 0 });
    expect(anim?.params).toEqual({ startScale: 1.2, shine: true, twistDir: 1 });
    // The doc spec alone opts a legacy-theme scene in.
    expect(
      resolveTextAnimation({}, baseTheme, { in: "fade", out: "none", staggerMs: 0 }),
    ).not.toBeNull();
  });

  it("resolves duration, distance and easing without changing their absent defaults", () => {
    const legacy = resolveTextAnimation({}, themed);
    expect(legacy?.durationMs).toBeUndefined();
    expect(legacy?.distance).toBeUndefined();
    const anim = resolveTextAnimation({}, baseTheme, {
      in: "fade-up",
      out: "none",
      staggerMs: 0,
      durationMs: 450,
      distance: 0.3,
      ease: "inOutCubic",
    });
    expect(anim).toMatchObject({ durationMs: 450, distance: 0.3, ease: "inOutCubic" });
    if (!anim || !legacy) throw new Error("expected resolved text animation");
    expect(textAnimationEndMs(200, 1100, anim)).toBe(650);
    expect(textAnimationEndMs(200, 1100, legacy)).toBe(1100);
  });

  it("resolves delayMs props > doc > theme, treating 0 and absent identically", () => {
    const delayTheme: Theme = {
      ...baseTheme,
      textAnimation: { in: "fade", out: "none", staggerMs: 0, delayMs: 400 },
    };
    expect(resolveTextAnimation({}, delayTheme)?.delayMs).toBe(400);
    const docSpec = { in: "fade", out: "none", staggerMs: 0, delayMs: 250 };
    expect(resolveTextAnimation({}, delayTheme, docSpec)?.delayMs).toBe(250);
    expect(resolveTextAnimation({ delayMs: 120 }, delayTheme, docSpec)?.delayMs).toBe(120);
    // 0 resolves EXACTLY like absent (the written-then-zeroed sidecar case).
    expect(resolveTextAnimation({ delayMs: 0 }, themed)).toEqual(resolveTextAnimation({}, themed));
    // The prop alone opts a legacy theme in (the staggerMs precedent).
    expect(resolveTextAnimation({ delayMs: 200 }, baseTheme)).toMatchObject({
      preset: "fade",
      delayMs: 200,
    });
    // No delay anywhere leaves the field off entirely (the null-for-legacy contract).
    expect("delayMs" in (resolveTextAnimation({}, themed) ?? {})).toBe(false);
  });

  it("clamps a negative delayMs to 0 with a single warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveTextAnimation({ delayMs: -123 }, themed)?.delayMs).toBeUndefined();
      resolveTextAnimation({ delayMs: -123 }, themed);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("shifts the effective in end by delayMs while the window end stays put", () => {
    const delayed = resolveTextAnimation({}, baseTheme, {
      in: "fade-up",
      out: "none",
      staggerMs: 0,
      delayMs: 300,
      durationMs: 450,
    });
    if (!delayed) throw new Error("expected resolved text animation");
    expect(textAnimationWindowToMs(200, 1100, delayed)).toBe(650);
    expect(textAnimationEndMs(200, 1100, delayed)).toBe(950);
    const noDuration = resolveTextAnimation({ delayMs: 300 }, themed);
    if (!noDuration) throw new Error("expected resolved text animation");
    expect(textAnimationWindowToMs(200, 1100, noDuration)).toBe(1100);
    expect(textAnimationEndMs(200, 1100, noDuration)).toBe(1400);
  });

  it("selects a keyed exception while retaining the scene-wide base for other items", () => {
    const doc = {
      textAnimation: { in: "fade", out: "none", staggerMs: 0 },
      textAnimationOverrides: {
        hero: { in: "slide", out: "none", staggerMs: 0, distance: 0.25 },
      },
    };
    expect(resolveTextAnimationWithDoc({}, baseTheme, doc, "hero")).toMatchObject({
      preset: "slide",
      distance: 0.25,
    });
    expect(resolveTextAnimationWithDoc({}, baseTheme, doc, "subtitle")?.preset).toBe("fade");
  });
});

function timing(overrides: Partial<TextAnimTiming["anim"]> = {}, outAt?: number): TextAnimTiming {
  return {
    anim: {
      preset: "fade",
      outPreset: "fade",
      ease: "linear",
      staggerMs: 50,
      granularity: "word",
      params: { startScale: 0.8, shine: false, twistDir: 1 },
      ...overrides,
    },
    from: 100,
    to: 500,
    outAt,
  };
}

describe("sampleTextUnit", () => {
  it("holds alpha at 0 before the window and 1 after", () => {
    expect(sampleTextUnit(timing(), 0, 0).alpha).toBe(0);
    expect(sampleTextUnit(timing(), 0, 100).alpha).toBe(0);
    expect(sampleTextUnit(timing(), 0, 500).alpha).toBe(1);
    expect(sampleTextUnit(timing(), 0, 2000).alpha).toBe(1);
  });

  it("ramps linearly under the linear ease", () => {
    expect(sampleTextUnit(timing(), 0, 300).alpha).toBeCloseTo(0.5, 12);
  });

  it("shifts unit i's window by i × staggerMs", () => {
    const t = timing();
    expect(sampleTextUnit(t, 2, 400).alpha).toBeCloseTo(sampleTextUnit(t, 0, 300).alpha, 12);
    // The last unit finishes after `to`, by (units−1) × staggerMs.
    expect(sampleTextUnit(t, 2, 500).alpha).toBeLessThan(1);
    expect(sampleTextUnit(t, 2, 600).alpha).toBe(1);
  });

  it("fade-up rises to rest: dyEm goes from −0.35 to 0", () => {
    const t = timing({ preset: "fade-up" });
    expect(sampleTextUnit(t, 0, 100).dyEm).toBeCloseTo(-0.35, 12);
    expect(sampleTextUnit(t, 0, 300).dyEm).toBeCloseTo(-0.175, 12);
    expect(sampleTextUnit(t, 0, 500).dyEm).toBe(-0);
  });

  it("uses an authored travel distance and keeps static fully visible", () => {
    const distance = timing({ preset: "fade-up", distance: 0.3 });
    expect(sampleTextUnit(distance, 0, 100).dyEm).toBeCloseTo(-0.3, 12);
    const staticTiming = timing({ preset: STATIC_TEXT_PRESET });
    expect(sampleTextUnit(staticTiming, 0, 0).alpha).toBe(1);
    expect(sampleTextUnit(staticTiming, 0, 300).alpha).toBe(1);
  });

  it("mask-reveal sweeps the right edge with full alpha", () => {
    const t = timing({ preset: "mask-reveal" });
    const mid = sampleTextUnit(t, 0, 300);
    expect(mid.alpha).toBe(1);
    expect(mid.sweep).toEqual([0, 0.5]);
    expect(sampleTextUnit(t, 0, 500).sweep).toEqual([0, 1]);
  });

  it("blur-in relaxes blur and scale to rest", () => {
    const t = timing({ preset: "blur-in" });
    const start = sampleTextUnit(t, 0, 100);
    expect(start.blurEm).toBeCloseTo(0.4, 12);
    expect(start.scale).toBeCloseTo(1.06, 12);
    const end = sampleTextUnit(t, 0, 500);
    expect(end.blurEm).toBe(0);
    expect(end.scale).toBe(1);
  });

  it("plays the out preset from outAt over the in duration", () => {
    const t = timing({}, 1000);
    expect(sampleTextUnit(t, 0, 1000).alpha).toBe(1);
    expect(sampleTextUnit(t, 0, 1200).alpha).toBeCloseTo(0.5, 12);
    expect(sampleTextUnit(t, 0, 1400).alpha).toBe(0);
  });

  it("fade-up out continues upward while fading", () => {
    const t = timing({ preset: "fade-up", outPreset: "fade-up" }, 1000);
    const s = sampleTextUnit(t, 0, 1200);
    expect(s.alpha).toBeCloseTo(0.5, 12);
    expect(s.dyEm).toBeCloseTo(0.175, 12);
  });

  it("mask-reveal out closes the window from the left", () => {
    const t = timing({ preset: "mask-reveal", outPreset: "mask-reveal" }, 1000);
    expect(sampleTextUnit(t, 0, 1200).sweep).toEqual([0.5, 1]);
  });

  // ── GOLDENS (export contract) ──────────────────────────────────────────────
  it("every legacy preset carries the neutral v11 fields (rotYRad 0, shineU −1, rotZRad 0, dzEm 0)", () => {
    for (const preset of ["none", "fade", "fade-up", "blur-in", "slide", "mask-reveal"] as const) {
      const s = sampleTextUnit(timing({ preset }), 0, 300);
      expect(s.rotYRad, preset).toBe(0);
      expect(s.shineU, preset).toBe(-1);
      expect(s.rotZRad, preset).toBe(0);
      expect(s.dzEm, preset).toBe(0);
    }
  });

  it("fade-scale lerps startScale → 1 (both directions) with alpha = p", () => {
    const grow = timing({
      preset: "fade-scale",
      params: { startScale: 0.8, shine: false, twistDir: 1 },
    });
    expect(sampleTextUnit(grow, 0, 100).scale).toBeCloseTo(0.8, 12);
    expect(sampleTextUnit(grow, 0, 300).scale).toBeCloseTo(0.9, 12);
    expect(sampleTextUnit(grow, 0, 500).scale).toBeCloseTo(1, 12);
    expect(sampleTextUnit(grow, 0, 300).alpha).toBeCloseTo(0.5, 12);
    const settle = timing({
      preset: "fade-scale",
      params: { startScale: 1.15, shine: false, twistDir: 1 },
    });
    expect(sampleTextUnit(settle, 0, 100).scale).toBeCloseTo(1.15, 12);
    expect(sampleTextUnit(settle, 0, 300).scale).toBeCloseTo(1.075, 12);
    expect(sampleTextUnit(settle, 0, 500).scale).toBeCloseTo(1, 12);
  });

  it("fade-scale shine: shineU = p while on, parked at 1 past the in, −1 when off", () => {
    const shiny = timing({
      preset: "fade-scale",
      params: { startScale: 0.8, shine: true, twistDir: 1 },
    });
    expect(sampleTextUnit(shiny, 0, 100).shineU).toBe(0);
    expect(sampleTextUnit(shiny, 0, 300).shineU).toBeCloseTo(0.5, 12);
    expect(sampleTextUnit(shiny, 0, 2000).shineU).toBe(1); // fully exited, no re-sweep
    const dull = timing({
      preset: "fade-scale",
      params: { startScale: 0.8, shine: false, twistDir: 1 },
    });
    expect(sampleTextUnit(dull, 0, 300).shineU).toBe(-1);
  });

  it("fade-scale out mirrors multiplicatively back toward startScale", () => {
    const t = timing(
      { preset: "fade-scale", outPreset: "fade-scale" },
      1000, // params: startScale 0.8 from the helper default
    );
    const s = sampleTextUnit(t, 0, 1200); // q = 0.5, in complete (scale 1)
    expect(s.alpha).toBeCloseTo(0.5, 12);
    expect(s.scale).toBeCloseTo(0.9, 12); // 1 × (0.8 + 0.2 × 0.5)
  });

  it("twist-scale turns from the entry side to rest, scaling from 0.92", () => {
    const left = timing({
      preset: "twist-scale",
      params: { startScale: 0.8, shine: false, twistDir: 1 },
    });
    expect(sampleTextUnit(left, 0, 100).rotYRad).toBeCloseTo(TWIST_RAD, 12);
    expect(sampleTextUnit(left, 0, 300).rotYRad).toBeCloseTo(TWIST_RAD / 2, 12);
    expect(sampleTextUnit(left, 0, 500).rotYRad).toBeCloseTo(0, 12);
    expect(sampleTextUnit(left, 0, 100).scale).toBeCloseTo(TWIST_START_SCALE, 12);
    expect(sampleTextUnit(left, 0, 500).scale).toBeCloseTo(1, 12);
    const right = timing({
      preset: "twist-scale",
      params: { startScale: 0.8, shine: false, twistDir: -1 },
    });
    expect(sampleTextUnit(right, 0, 100).rotYRad).toBeCloseTo(-TWIST_RAD, 12);
  });

  it("twist-scale honours an explicitly authored start size and shine", () => {
    const resolved = resolveTextAnimation(
      { preset: "twist-scale", startScale: 0.7, shine: true },
      baseTheme,
    );
    expect(resolved?.params.twistStartScale).toBe(0.7);
    expect(
      sampleTextUnit(timing({ preset: "twist-scale", params: resolved?.params }), 0, 100),
    ).toMatchObject({
      scale: 0.7,
      shineU: 0,
    });
  });

  it("twist-scale out turns back toward the entry side", () => {
    const t = timing(
      {
        preset: "twist-scale",
        outPreset: "twist-scale",
        params: { startScale: 0.8, shine: false, twistDir: 1 },
      },
      1000,
    );
    const s = sampleTextUnit(t, 0, 1200); // q = 0.5
    expect(s.rotYRad).toBeCloseTo(TWIST_RAD / 2, 12);
    expect(s.scale).toBeCloseTo(TWIST_START_SCALE + (1 - TWIST_START_SCALE) * 0.5, 12);
  });
});

describe("unitHash01 (v11 · M4b golden — the seeded per-unit randomness)", () => {
  it("pins exact values (changing the hash re-renders every scatter project)", () => {
    expect(unitHash01(0, 0)).toBeCloseTo(0.07890515378676355, 15);
    expect(unitHash01(1, 0)).toBeCloseTo(0.11811059410683811, 15);
    expect(unitHash01(2, 0)).toBeCloseTo(0.7095803839620203, 15);
    expect(unitHash01(0, 1)).toBeCloseTo(0.021185452584177256, 15);
    expect(unitHash01(0, 2)).toBeCloseTo(0.2527142292819917, 15);
    expect(unitHash01(5, 2)).toBeCloseTo(0.7886057067662477, 15);
  });

  it("is pure: identical inputs, identical outputs, range [0, 1)", () => {
    for (let i = 0; i < 40; i++) {
      const v = unitHash01(i, 3);
      expect(v).toBe(unitHash01(i, 3));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("scatter-scale (v11 · M4b goldens)", () => {
  const scatter = (outAt?: number) =>
    timing({ preset: "scatter-scale", staggerMs: 50, granularity: "char" }, outAt);
  const one = { count: 1 } as const;
  const unitDur = (i: number) => 400 * (0.7 + 0.3 * unitHash01(i, 1));
  const roll0 = (i: number) =>
    SCATTER_ROLL_MIN_RAD + (SCATTER_ROLL_MAX_RAD - SCATTER_ROLL_MIN_RAD) * unitHash01(i, 2);

  it("enters from the camera, rolled counter-clockwise, with the short initial fade", () => {
    const start = sampleTextUnit(scatter(), 0, 100, one);
    expect(start.alpha).toBe(0);
    expect(start.dzEm).toBe(SCATTER_DEPTH_EM);
    expect(start.rotZRad).toBeCloseTo(roll0(0), 12); // positive = counter-clockwise
    expect(start.rotZRad).toBeGreaterThanOrEqual(SCATTER_ROLL_MIN_RAD);
    expect(start.rotZRad).toBeLessThanOrEqual(SCATTER_ROLL_MAX_RAD);
    // Fade completes at p = SCATTER_FADE_P of the unit's own (rate-jittered) duration.
    const fadeEnd = sampleTextUnit(scatter(), 0, 100 + unitDur(0) * SCATTER_FADE_P, one);
    expect(fadeEnd.alpha).toBeCloseTo(1, 6);
    const rest = sampleTextUnit(scatter(), 0, 100 + unitDur(0) + 1, one);
    expect(rest.alpha).toBe(1);
    expect(Math.abs(rest.dzEm)).toBe(0);
    expect(Math.abs(rest.rotZRad)).toBe(0);
  });

  it("hashes the per-unit delays over the ordered budget (no left-to-right order)", () => {
    const ctx = { count: 13 } as const;
    // Ordered stagger would start unit 2 at 100 + 2×50 = 200; the hash parks it much later (h(2,0)≈0.71 × 600 ≈ 426ms) while unit 1 (h≈0.118 × 600 ≈ 71ms) is moving.
    const u1 = sampleTextUnit(scatter(), 1, 250, ctx);
    const u2 = sampleTextUnit(scatter(), 2, 250, ctx);
    expect(u1.alpha).toBeGreaterThan(0);
    expect(u2.alpha).toBe(0);
  });

  it("derives the X/Y drift from the unit's share of the element tilt", () => {
    const ctx = { count: 1, unitCenterEm: [10, 0] as const };
    const s = sampleTextUnit(scatter(), 0, 100, ctx);
    // A right-of-centre unit starts UP (counter-clockwise element tilt), slightly inward.
    expect(s.dyEm).toBeCloseTo(10 * Math.sin(SCATTER_TILT_RAD), 12);
    expect(s.dxEm).toBeCloseTo(10 * (Math.cos(SCATTER_TILT_RAD) - 1), 12);
    expect(s.dyEm).toBeGreaterThan(0);
    const rest = sampleTextUnit(scatter(), 0, 100 + unitDur(0) + 1, ctx);
    expect(Math.abs(rest.dxEm)).toBeCloseTo(0, 12);
    expect(Math.abs(rest.dyEm)).toBeCloseTo(0, 12);
  });

  it("out mirrors back toward the camera", () => {
    const t = timing(
      { preset: "scatter-scale", outPreset: "scatter-scale", staggerMs: 50, granularity: "char" },
      1000,
    );
    const s = sampleTextUnit(t, 0, 1000 + unitDur(0) / 2, one);
    expect(s.alpha).toBeCloseTo(0.5, 12);
    expect(s.dzEm).toBeCloseTo(SCATTER_DEPTH_EM * 0.5, 12);
    expect(s.rotZRad).toBeCloseTo(roll0(0) * 0.5, 12);
  });

  it("resolves to per-character stagger by default; all-at-once still forces block", () => {
    const anim = resolveTextAnimation({ preset: "scatter-scale" }, baseTheme);
    expect(anim?.granularity).toBe("char");
    expect(anim?.staggerMs).toBe(35); // the char default delay
    const block = resolveTextAnimation(
      { preset: "scatter-scale", delivery: "all-at-once" },
      baseTheme,
    );
    expect(block?.granularity).toBeNull();
  });
});

describe("shineBand (v11 · M3 golden)", () => {
  const bounds: readonly [number, number, number, number] = [-2, -0.5, 2, 0.5];

  it("is null when off or unmeasured", () => {
    expect(shineBand(bounds, -1)).toBeNull();
    expect(shineBand(null, 0.5)).toBeNull();
  });

  it("sweeps from just-off the low corner to fully exited (golden literals)", () => {
    // Corner projections on the 45° axis: ±2.5·√½; span 3.535533905932738.
    const span = 2.5 * Math.SQRT1_2 * 2;
    const halfW = SHINE_HALF_W * span;
    const start = shineBand(bounds, 0);
    expect(start?.centerS).toBeCloseTo(-2.5 * Math.SQRT1_2 - halfW, 12);
    expect(start?.centerS).toBeCloseTo(-2.4041630560342617, 12);
    expect(start?.invHalfWidthS).toBeCloseTo(1.571348402636772, 12);
    expect(shineBand(bounds, 0.5)?.centerS).toBeCloseTo(0, 12);
    expect(shineBand(bounds, 1)?.centerS).toBeCloseTo(2.4041630560342617, 12);
  });
});

/** caretPositions: [startX, endX, bottomY, topY] per char (troika's layout). */
function carets(chars: [number, number, number?, number?][]): Float32Array {
  const arr = new Float32Array(chars.length * 4);
  chars.forEach(([s, e, bottom, top], i) => {
    arr[i * 4] = s;
    arr[i * 4 + 1] = e;
    arr[i * 4 + 2] = bottom ?? 0;
    arr[i * 4 + 3] = top ?? 0;
  });
  return arr;
}

/** A line of per-char carets on one Y row: [startX, endX, bottomY, topY] each. */
function row(
  xs: [number, number][],
  bottom: number,
  top: number,
): [number, number, number, number][] {
  return xs.map(([s, e]) => [s, e, bottom, top]);
}

describe("computeStaggerUnits", () => {
  it("splits words on whitespace with midpoint decision edges", () => {
    const units = computeStaggerUnits(
      "ab cd",
      "word",
      carets([
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ]),
    );
    expect(units.count).toBe(2);
    expect(units.axis).toBe("x");
    expect(Array.from(units.startX)).toEqual([0, 3]);
    expect(Array.from(units.endX)).toEqual([2, 5]);
    // The pre-v11 `edgeX` values, bit-for-bit (the key extent aliases the X extent).
    expect(units.edgeKey[0]).toBeCloseTo(2.5, 6);
    expect(units.edgeKey[1]).toBe(Math.fround(EDGE_SENTINEL));
  });

  it("makes each non-whitespace char a unit under char granularity", () => {
    const units = computeStaggerUnits(
      "a b",
      "char",
      carets([
        [0, 1],
        [1, 2],
        [2, 3],
      ]),
    );
    expect(units.count).toBe(2);
    expect(Array.from(units.startX)).toEqual([0, 2]);
  });

  it("tolerates swapped caret edges (rtl runs)", () => {
    const units = computeStaggerUnits(
      "ab",
      "word",
      carets([
        [1, 0],
        [2, 1],
      ]),
    );
    expect(units.count).toBe(1);
    expect(units.startX[0]).toBe(0);
    expect(units.endX[0]).toBe(2);
  });

  it("merges beyond MAX_STAGGER_UNITS into ordered buckets", () => {
    const chars: [number, number][] = [];
    for (let i = 0; i < 100; i++) chars.push([i, i + 1]);
    const units = computeStaggerUnits("x".repeat(100), "char", carets(chars));
    expect(units.count).toBe(MAX_STAGGER_UNITS);
    expect(units.startX[0]).toBe(0);
    expect(units.endX[units.count - 1]).toBe(100);
    for (let i = 1; i < units.count; i++) {
      expect(units.startX[i]).toBeGreaterThan(units.startX[i - 1]);
    }
  });

  it("splits paragraphs on \\n with −Y midpoint edges (v11 · M4)", () => {
    // Two lines: "ab" on the top row (y 0.6..1.0), "cd" below (y −0.4..0.0).
    const units = computeStaggerUnits(
      "ab\ncd",
      "paragraph",
      carets([
        ...row(
          [
            [0, 1],
            [1, 2],
          ],
          0.6,
          1.0,
        ),
        [0, 0],
        ...row(
          [
            [0, 1.5],
            [1.5, 3],
          ],
          -0.4,
          0,
        ),
      ]),
    );
    expect(units.count).toBe(2);
    expect(units.axis).toBe("-y");
    // X extents are kept per unit (mask-reveal sweeps stay X-based).
    expect(Array.from(units.startX)).toEqual([0, 0]);
    expect(Array.from(units.endX)).toEqual([2, 3]);
    // Key space is −y: unit 0 spans [−1.0, −0.6], unit 1 [0, 0.4] → edge at midpoint.
    expect(units.edgeKey[0]).toBeCloseTo((-0.6 + 0) / 2, 6);
    expect(units.edgeKey[1]).toBe(Math.fround(EDGE_SENTINEL));
  });

  it("keeps a paragraph together across spaces, splits groups only on blank lines", () => {
    // "a b\nc\n \nd": group 1 = lines "a b" + "c", the whitespace-only line splits, group 2 = "d"; whitespace belongs to no unit but does not split a paragraph.
    const text = "a b\nc\n \nd";
    const chars: [number, number, number?, number?][] = [
      ...row(
        [
          [0, 1],
          [1, 2],
          [2, 3],
        ],
        2.6,
        3.0,
      ), // "a b"
      [0, 0],
      ...row([[0, 1]], 1.6, 2.0), // "c"
      [0, 0],
      ...row([[0, 0.5]], 0.6, 1.0), // " " (the blank line's space)
      [0, 0],
      ...row([[0, 1]], -0.4, 0), // "d"
    ];
    const groups = computeStaggerUnits(text, "paragraph-group", carets(chars));
    expect(groups.count).toBe(2);
    expect(groups.axis).toBe("-y");
    // Group 1 key extent spans both lines: [−3.0, −1.6]; group 2 [0, 0.4].
    expect(groups.edgeKey[0]).toBeCloseTo((-1.6 + 0) / 2, 6);

    const paras = computeStaggerUnits(text, "paragraph", carets(chars));
    expect(paras.count).toBe(3); // "a b" · "c" · "d", the blank line yields NO unit
    expect(Array.from(paras.endX)).toEqual([3, 1, 1]);
  });
});

describe("resolveTextAnimationWithDoc (v11 · M6 — the force override)", () => {
  const props = { preset: "twist-scale" as const, shine: true };
  const doc = { textAnimation: { in: "fade-up", out: "none", staggerMs: 0 } };

  it("without the flag it is argument-for-argument the M3 call (props win)", () => {
    expect(resolveTextAnimationWithDoc(props, baseTheme, doc)).toEqual(
      resolveTextAnimation(props, baseTheme, doc.textAnimation),
    );
    expect(resolveTextAnimationWithDoc(props, baseTheme, null)).toEqual(
      resolveTextAnimation(props, baseTheme),
    );
  });

  it("with the flag the TSX animation props are ignored — the sidecar/theme spec drives", () => {
    const forced = resolveTextAnimationWithDoc(props, baseTheme, {
      ...doc,
      textAnimationForce: true,
    });
    expect(forced?.preset).toBe("fade-up");
    expect(forced?.params.shine).toBe(false);
    // Force without any doc/theme spec = nothing configured → the legacy null.
    expect(resolveTextAnimationWithDoc(props, baseTheme, { textAnimationForce: true })).toBeNull();
  });

  it("hasOwnAnimationProps matches the resolver's props-only configured test", () => {
    expect(hasOwnAnimationProps({})).toBe(false);
    expect(hasOwnAnimationProps({ preset: "fade" })).toBe(true);
    expect(hasOwnAnimationProps({ staggerMs: 40 })).toBe(true);
    expect(hasOwnAnimationProps({ delayMs: 200 })).toBe(true);
    expect(hasOwnAnimationProps({ delivery: "by-paragraph" })).toBe(true);
  });
});

describe("computeStaggerUnits with astral codepoints", () => {
  it("keeps a surrogate pair as ONE char unit spanning both caret slots", () => {
    // "a𝔸b": 𝔸 (U+1D538) is two code units; troika splits its advance across slots 1-2.
    const units = computeStaggerUnits(
      "a𝔸b",
      "char",
      carets([
        [0, 1],
        [1, 1.5],
        [1.5, 2],
        [2, 3],
      ]),
    );
    expect(units.count).toBe(3);
    expect(Array.from(units.startX)).toEqual([0, 1, 2]);
    expect(Array.from(units.endX)).toEqual([1, 2, 3]);
  });

  it("merges an astral codepoint into its word", () => {
    const units = computeStaggerUnits(
      "a𝔸 b",
      "word",
      carets([
        [0, 1],
        [1, 1.5],
        [1.5, 2],
        [2, 3],
        [3, 4],
      ]),
    );
    expect(units.count).toBe(2);
    expect(Array.from(units.endX)).toEqual([2, 4]);
  });

  it("keeps paragraph unit ids identical across a surrogate pair", () => {
    const units = computeStaggerUnits(
      "𝔸x\nyz",
      "paragraph",
      carets([
        [0, 0.5],
        [0.5, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ]),
    );
    expect(units.count).toBe(2);
  });

  it("is byte-identical to the legacy walk for BMP-only text (the compatibility contract)", () => {
    // Same fixture as the legacy word test above; the codepoint stepper must reproduce the exact floats.
    const units = computeStaggerUnits(
      "ab cd",
      "word",
      carets([
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
      ]),
    );
    expect(units.edgeKey[0]).toBe(Math.fround(2.5));
    expect(Array.from(units.startX)).toEqual([0, 3]);
    expect(Array.from(units.endX)).toEqual([2, 5]);
  });
});

describe("unitIndexForKey (the shader walk's CPU twin)", () => {
  const units = (edges: number[]) =>
    ({
      count: edges.length,
      startX: new Float32Array(edges.length),
      endX: new Float32Array(edges.length),
      edgeKey: Float32Array.from(edges),
      centerY: new Float32Array(edges.length),
      axis: "x",
    }) as const;

  it("returns unit 0 with no measured units", () => {
    expect(unitIndexForKey(null, 5)).toBe(0);
  });

  it("selects the unit whose decision edge the key has not passed", () => {
    const u = units([2.5, 6.5, EDGE_SENTINEL]);
    expect(unitIndexForKey(u, 1)).toBe(0);
    expect(unitIndexForKey(u, 2.5)).toBe(0);
    expect(unitIndexForKey(u, 2.6)).toBe(1);
    expect(unitIndexForKey(u, 6.6)).toBe(2);
    expect(unitIndexForKey(u, 1e9)).toBe(2);
  });

  it("clamps to the last unit past every edge", () => {
    expect(unitIndexForKey(units([EDGE_SENTINEL]), 1e31)).toBe(0);
  });
});

// ── Wave-2 creative pack ─────────────────────────────────────────────────────

const WAVE2_PRESETS = [
  "tracking",
  "slam",
  "dolly",
  "chromatic",
  "line-stretch",
  "highlight-wipe",
  "rise-mask",
  "word-cycle",
  "ribbon",
  "stand-up",
  "spring-pop",
  "spotlight",
  "underline-draw",
  "orbit",
  "weight-build",
  "develop",
  "flip-cascade",
  "converge",
  "glint-wipe",
  "vapor",
] as const;
const LEGACY_PRESETS = [
  "fade",
  "fade-up",
  "blur-in",
  "slide",
  "mask-reveal",
  "fade-scale",
  "twist-scale",
  "scatter-scale",
] as const;

/** The motion-pack v2 fields at their neutral defaults (Math.abs tolerates ±0). */
function expectNeutralV2(s: TextUnitSample, label: string) {
  expect(Math.abs(s.rotXRad), label).toBe(0);
  expect(s.scaleX, label).toBe(1);
  expect(s.scaleY, label).toBe(1);
  expect(s.clipFinal, label).toBe(false);
  expect(Math.abs(s.colorMix), label).toBe(0);
  expect(Math.abs(s.weightEm), label).toBe(0);
  expect(Math.abs(s.softEm), label).toBe(0);
  expect(Math.abs(s.chromaEm), label).toBe(0);
  expect(s.highlight, label).toEqual([0, 0]);
}

describe("wave-2 resolution (forced granularities + direction)", () => {
  const forcedChar = ["tracking", "orbit", "develop", "flip-cascade", "converge", "vapor"] as const;
  const forcedWord = [
    "dolly",
    "highlight-wipe",
    "rise-mask",
    "word-cycle",
    "ribbon",
    "stand-up",
    "spring-pop",
    "spotlight",
  ] as const;

  it("forces char with the char default delay", () => {
    for (const preset of forcedChar) {
      const anim = resolveTextAnimation({ preset }, baseTheme);
      expect(anim?.granularity, preset).toBe("char");
      expect(anim?.staggerMs, preset).toBe(35);
    }
  });

  it("forces word with the word default delay", () => {
    for (const preset of forcedWord) {
      const anim = resolveTextAnimation({ preset }, baseTheme);
      expect(anim?.granularity, preset).toBe("word");
      expect(anim?.staggerMs, preset).toBe(90);
    }
  });

  it("an out-only wave-2 preset still forces (vapor is designed as an out)", () => {
    const anim = resolveTextAnimation({ preset: "fade", outPreset: "vapor" }, baseTheme);
    expect(anim?.granularity).toBe("char");
  });

  it("explicit choices still win over the forced default", () => {
    expect(
      resolveTextAnimation({ preset: "tracking", delivery: "all-at-once" }, baseTheme)?.granularity,
    ).toBeNull();
    expect(resolveTextAnimation({ preset: "dolly", stagger: "char" }, baseTheme)?.granularity).toBe(
      "char",
    );
  });

  it("block wave-2 presets stay block when nothing chose", () => {
    for (const preset of [
      "slam",
      "chromatic",
      "line-stretch",
      "underline-draw",
      "weight-build",
      "glint-wipe",
    ] as const) {
      expect(resolveTextAnimation({ preset }, baseTheme)?.granularity, preset).toBeNull();
    }
  });

  it("direction reaches orbit's sweep sign the way it reaches twist-scale", () => {
    expect(resolveTextAnimation({ preset: "orbit" }, baseTheme)?.params.twistDir).toBe(1);
    expect(
      resolveTextAnimation({ preset: "orbit", direction: "from-right" }, baseTheme)?.params
        .twistDir,
    ).toBe(-1);
  });
});

describe("presetNeedsShaderPath", () => {
  it("true for every wave-2 preset, false for every legacy path", () => {
    for (const preset of WAVE2_PRESETS) expect(presetNeedsShaderPath(preset), preset).toBe(true);
    const legacy: TextPresetName[] = ["none", STATIC_TEXT_PRESET, ...LEGACY_PRESETS];
    for (const preset of legacy) expect(presetNeedsShaderPath(preset), preset).toBe(false);
  });
});

describe("the null-for-legacy contract (v2 fields stay neutral)", () => {
  const ctx = { count: 3, unitCenterEm: [1, 0] as const };

  it("every legacy preset samples neutral v2 fields across in, rest and out", () => {
    for (const preset of LEGACY_PRESETS) {
      for (const ms of [100, 300, 500, 1150, 1250]) {
        const s = sampleTextUnit(timing({ preset, outPreset: preset }, 1000), 0, ms, ctx);
        expectNeutralV2(s, `${preset} @ ${ms}`);
      }
    }
  });

  it("pins a complete legacy sample byte-for-byte (fade-up mid-flight)", () => {
    expect(sampleTextUnit(timing({ preset: "fade-up" }), 0, 300)).toEqual({
      alpha: 0.5,
      dxEm: 0,
      dyEm: -0.175,
      scale: 1,
      blurEm: 0,
      sweep: [0, 1],
      rotYRad: 0,
      shineU: -1,
      rotZRad: 0,
      dzEm: 0,
      rotXRad: 0,
      scaleX: 1,
      scaleY: 1,
      clipFinal: false,
      colorMix: 0,
      weightEm: 0,
      softEm: 0,
      chromaEm: 0,
      highlight: [0, 0],
    });
  });

  it("every wave-2 preset returns to neutral v2 fields at rest (p=1, no out)", () => {
    for (const preset of WAVE2_PRESETS) {
      for (const unit of [0, 2]) {
        const s = sampleTextUnit(timing({ preset, outPreset: "none" }), unit, 5000, {
          count: 3,
          unitCenterEm: [1.5, 0.2],
        });
        expectNeutralV2(s, `${preset} unit ${unit}`);
      }
    }
  });
});

describe("wave-2 preset goldens", () => {
  it("tracking converges toward the centre and sharpens; the out drifts wider", () => {
    const ctx = { count: 4, unitCenterEm: [2, 0] as const };
    const tIn = timing({ preset: "tracking", granularity: "char" });
    const start = sampleTextUnit(tIn, 0, 100, ctx);
    expect(start.alpha).toBe(0);
    expect(start.dxEm).toBeCloseTo(-2 * TRACK_TIGHTEN, 12);
    expect(start.softEm).toBeCloseTo(TRACK_SOFT_EM, 12);
    const mid = sampleTextUnit(tIn, 0, 300, ctx);
    expect(mid.dxEm).toBeCloseTo(-TRACK_TIGHTEN, 12);
    expect(mid.alpha).toBeCloseTo(0.5, 12);
    const tOut = timing({ preset: "tracking", outPreset: "tracking", granularity: "char" }, 1000);
    const out = sampleTextUnit(tOut, 0, 1200, ctx);
    expect(out.dxEm).toBeCloseTo(2 * TRACK_SPREAD * 0.5, 12);
    expect(out.softEm).toBeCloseTo(TRACK_SOFT_EM * 0.5, 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("slam drops from oversize with a capped landing dip", () => {
    const tIn = timing({ preset: "slam" });
    const start = sampleTextUnit(tIn, 0, 100);
    expect(start.scale).toBeCloseTo(SLAM_START_SCALE, 12);
    expect(start.softEm).toBeCloseTo(SLAM_SOFT_EM, 12);
    expect(start.alpha).toBe(0);
    expect(sampleTextUnit(tIn, 0, 260).alpha).toBeCloseTo(1, 12);
    // p = 0.85: the landing bump's midpoint, the full compression
    expect(sampleTextUnit(tIn, 0, 440).scale).toBeCloseTo(
      1 + (SLAM_START_SCALE - 1) * 0.15 - SLAM_OVERSHOOT,
      12,
    );
    expect(sampleTextUnit(tIn, 0, 500).scale).toBeCloseTo(1, 12);
    const out = sampleTextUnit(timing({ preset: "slam", outPreset: "slam" }, 1000), 0, 1200);
    expect(out.scale).toBeCloseTo(1 + (SLAM_OUT_SCALE - 1) * 0.5, 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
    expect(out.softEm).toBeCloseTo(SLAM_SOFT_EM * 0.5, 12);
  });

  it("dolly pulls forward from hashed depth and exits past the camera", () => {
    const one = { count: 1 } as const;
    const depth = DOLLY_EM + DOLLY_JITTER_EM * unitHash01(0, 3);
    const tIn = timing({ preset: "dolly", granularity: "word" });
    const start = sampleTextUnit(tIn, 0, 100, one);
    expect(start.dzEm).toBeCloseTo(-depth, 12);
    expect(start.softEm).toBeCloseTo(DOLLY_SOFT_EM, 12);
    expect(start.alpha).toBe(0);
    expect(sampleTextUnit(tIn, 0, 300, one).dzEm).toBeCloseTo(-depth / 2, 12);
    const out = sampleTextUnit(timing({ preset: "dolly", outPreset: "dolly" }, 1000), 0, 1200, one);
    expect(out.dzEm).toBeCloseTo(DOLLY_NEAR_EM * 0.5, 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("chromatic converges the split then re-splits on the out", () => {
    const tIn = timing({ preset: "chromatic" });
    expect(sampleTextUnit(tIn, 0, 100).chromaEm).toBeCloseTo(CHROMA_EM, 12);
    const mid = sampleTextUnit(tIn, 0, 300);
    expect(mid.chromaEm).toBeCloseTo(CHROMA_EM / 2, 12);
    expect(mid.alpha).toBeCloseTo(0.5, 12);
    const out = sampleTextUnit(
      timing({ preset: "chromatic", outPreset: "chromatic" }, 1000),
      0,
      1200,
    );
    expect(out.chromaEm).toBeCloseTo(CHROMA_EM / 2, 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("line-stretch opens from a line with the shine tied to the opening", () => {
    const tIn = timing({ preset: "line-stretch" });
    const start = sampleTextUnit(tIn, 0, 100);
    expect(start.scaleY).toBeCloseTo(LINE_SCALE_Y0, 12);
    expect(start.scaleX).toBeCloseTo(LINE_SCALE_X0, 12);
    expect(start.shineU).toBe(0);
    expect(sampleTextUnit(tIn, 0, 200).alpha).toBeCloseTo(0.5, 12);
    const mid = sampleTextUnit(tIn, 0, 300);
    expect(mid.scaleY).toBeCloseTo(1 - (1 - LINE_SCALE_Y0) / 2, 12);
    expect(mid.alpha).toBe(1);
    expect(mid.shineU).toBeCloseTo(0.5, 12);
    // out: collapse first, fade over the back half
    const tOut = timing({ preset: "line-stretch", outPreset: "line-stretch" }, 1000);
    const oMid = sampleTextUnit(tOut, 0, 1200);
    expect(oMid.scaleY).toBeCloseTo(1 - (1 - LINE_SCALE_Y0) / 2, 12);
    expect(oMid.alpha).toBeCloseTo(1, 12);
    expect(sampleTextUnit(tOut, 0, 1300).alpha).toBeCloseTo(0.5, 12);
  });

  it("highlight-wipe sweeps the block on, chases it off, and mirrors on the out", () => {
    const tIn = timing({ preset: "highlight-wipe", granularity: "word" });
    const grow = sampleTextUnit(tIn, 0, 200);
    expect(grow.highlight).toEqual([0, 0.5]);
    expect(grow.sweep).toEqual([0, 0]);
    expect(grow.alpha).toBe(1);
    const chase = sampleTextUnit(tIn, 0, 400);
    expect(chase.highlight).toEqual([0.5, 1]);
    expect(chase.sweep).toEqual([0, 0.5]);
    const rest = sampleTextUnit(tIn, 0, 500);
    expect(rest.highlight).toEqual([0, 0]);
    expect(rest.sweep).toEqual([0, 1]);
    const tOut = timing(
      { preset: "highlight-wipe", outPreset: "highlight-wipe", granularity: "word" },
      1000,
    );
    const collect = sampleTextUnit(tOut, 0, 1100);
    expect(collect.highlight).toEqual([0.5, 1]);
    expect(collect.sweep).toEqual([0, 0.5]);
    const leave = sampleTextUnit(tOut, 0, 1300);
    expect(leave.highlight).toEqual([0, 0.5]);
    expect(leave.sweep).toEqual([0, 0]);
  });

  it("rise-mask rises through its final bounds and exits up through the same mask", () => {
    const tIn = timing({ preset: "rise-mask", granularity: "word" });
    const start = sampleTextUnit(tIn, 0, 100);
    expect(start.dyEm).toBeCloseTo(-RISE_MASK_EM, 12);
    expect(start.clipFinal).toBe(true);
    expect(start.alpha).toBe(0);
    const mid = sampleTextUnit(tIn, 0, 300);
    expect(mid.dyEm).toBeCloseTo(-RISE_MASK_EM / 2, 12);
    expect(mid.alpha).toBeCloseTo(0.75, 12);
    const rest = sampleTextUnit(tIn, 0, 500);
    expect(rest.clipFinal).toBe(false);
    expect(Math.abs(rest.dyEm)).toBe(0);
    const tOut = timing({ preset: "rise-mask", outPreset: "rise-mask" }, 1000);
    const out = sampleTextUnit(tOut, 0, 1200);
    expect(out.dyEm).toBeCloseTo(RISE_MASK_EM * RISE_MASK_EXIT * 0.5, 12);
    expect(out.clipFinal).toBe(true);
    expect(out.alpha).toBeCloseTo(1, 12);
    expect(sampleTextUnit(tOut, 0, 1300).alpha).toBeCloseTo(0.5, 12);
  });

  it("word-cycle slots words through the block centre; the last word holds", () => {
    const ctx = { count: 3, unitCenterEm: [2, 0] as const };
    const tIn = timing({ preset: "word-cycle", granularity: "word" });
    const active = sampleTextUnit(tIn, 0, 150, ctx);
    expect(active.alpha).toBe(1);
    expect(active.scale).toBe(1);
    expect(active.dxEm).toBe(-2);
    expect(sampleTextUnit(tIn, 1, 150, ctx).alpha).toBe(0);
    const popping = sampleTextUnit(tIn, 0, 100 + (400 * 0.125) / 3, ctx);
    expect(popping.alpha).toBeCloseTo(0.5, 9);
    expect(popping.scale).toBeCloseTo(1 - (1 - WORD_CYCLE_POP_SCALE) * 0.5, 9);
    const leaving = sampleTextUnit(tIn, 0, 100 + (400 * 0.875) / 3, ctx);
    expect(leaving.alpha).toBeCloseTo(0.5, 9);
    const rest = sampleTextUnit(tIn, 2, 5000, ctx);
    expect(rest.alpha).toBe(1);
    expect(rest.dxEm).toBe(-2);
    expect(sampleTextUnit(tIn, 0, 5000, ctx).alpha).toBe(0);
    // The out rewinds the walk and ends empty.
    const tOut = timing(
      { preset: "word-cycle", outPreset: "word-cycle", granularity: "word" },
      1000,
    );
    const oMid = sampleTextUnit(tOut, 1, 1200, ctx);
    expect(oMid.alpha).toBe(1);
    expect(oMid.dxEm).toBe(-2);
    expect(sampleTextUnit(tOut, 0, 1200, ctx).alpha).toBe(0);
    expect(sampleTextUnit(tOut, 2, 1200, ctx).alpha).toBe(0);
    expect(sampleTextUnit(tOut, 0, 1400, ctx).alpha).toBe(0);
  });

  it("ribbon turns in about Y with a toward-camera bow, out continues the turn", () => {
    const tIn = timing({ preset: "ribbon", granularity: "word" });
    const start = sampleTextUnit(tIn, 0, 100);
    expect(start.rotYRad).toBeCloseTo(RIBBON_RAD, 12);
    expect(start.alpha).toBe(0);
    const mid = sampleTextUnit(tIn, 0, 300);
    expect(mid.rotYRad).toBeCloseTo(RIBBON_RAD / 2, 12);
    expect(mid.dzEm).toBeCloseTo(RIBBON_BOW_EM, 12);
    const out = sampleTextUnit(timing({ preset: "ribbon", outPreset: "ribbon" }, 1000), 0, 1200);
    expect(out.rotYRad).toBeCloseTo(-RIBBON_RAD / 2, 12);
    expect(out.dzEm).toBeCloseTo(RIBBON_BOW_EM, 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("stand-up tips upright then falls flat forward", () => {
    const tIn = timing({ preset: "stand-up", granularity: "word" });
    const start = sampleTextUnit(tIn, 0, 100);
    expect(start.rotXRad).toBeCloseTo(-STAND_RAD, 12);
    expect(start.dyEm).toBeCloseTo(-STAND_SETTLE_EM, 12);
    expect(start.alpha).toBe(0);
    expect(sampleTextUnit(tIn, 0, 240).alpha).toBeCloseTo(1, 12);
    expect(sampleTextUnit(tIn, 0, 300).rotXRad).toBeCloseTo(-STAND_RAD / 2, 12);
    const out = sampleTextUnit(
      timing({ preset: "stand-up", outPreset: "stand-up" }, 1000),
      0,
      1200,
    );
    expect(out.rotXRad).toBeCloseTo(STAND_RAD / 2, 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("spring-pop overshoots under 1.06 and lands exactly at 1", () => {
    const tIn = timing({ preset: "spring-pop", granularity: "word" });
    expect(sampleTextUnit(tIn, 0, 100).scale).toBeCloseTo(SPRING_START_SCALE, 12);
    expect(sampleTextUnit(tIn, 0, 100).alpha).toBe(0);
    // p = 0.4: cos(SPRING_FREQ × 0.4) = −1, the first (largest) overshoot
    const peak = sampleTextUnit(tIn, 0, 260).scale;
    expect(peak).toBeCloseTo(1 - (SPRING_START_SCALE - 1) * Math.exp(-SPRING_DAMP * 0.4), 12);
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.06);
    expect(sampleTextUnit(tIn, 0, 500).scale).toBeCloseTo(1, 12);
    const tOut = timing({ preset: "spring-pop", outPreset: "spring-pop" }, 1000);
    // q = 0.175: the anticipation bump's peak
    const bumped = sampleTextUnit(tOut, 0, 1070);
    expect(bumped.scale).toBeCloseTo(
      (1 + SPRING_OUT_BUMP) * (1 + (SPRING_START_SCALE - 1) * 0.175),
      9,
    );
    const gone = sampleTextUnit(tOut, 0, 1400);
    expect(gone.alpha).toBe(0);
    expect(gone.scale).toBeCloseTo(SPRING_START_SCALE, 9);
  });

  it("spotlight walks emphasis across the words, leaving them lit", () => {
    const ctx = { count: 3 } as const;
    const tIn = timing({ preset: "spotlight", granularity: "word" });
    const peakMs = 100 + 400 / 6; // unit 0's slot peak
    const peak = sampleTextUnit(tIn, 0, peakMs, ctx);
    expect(peak.alpha).toBeCloseTo(1, 9);
    expect(peak.colorMix).toBeCloseTo(1, 9);
    expect(peak.scale).toBeCloseTo(1 + SPOT_SCALE, 9);
    const waiting = sampleTextUnit(tIn, 2, peakMs, ctx);
    expect(waiting.alpha).toBeCloseTo(SPOT_DIM, 12);
    expect(waiting.colorMix).toBe(0);
    const rising = sampleTextUnit(tIn, 0, 100 + 400 / 12, ctx); // t = 0.25: half emphasis
    expect(rising.colorMix).toBeCloseTo(0.5, 9);
    expect(rising.alpha).toBeCloseTo(SPOT_DIM + (1 - SPOT_DIM) * 0.5, 9);
    const done = sampleTextUnit(tIn, 0, 100 + 800 / 3, ctx); // the walk has passed
    expect(done.alpha).toBeCloseTo(1, 9);
    expect(done.colorMix).toBe(0);
    const out = sampleTextUnit(
      timing({ preset: "spotlight", outPreset: "spotlight", granularity: "word" }, 1000),
      0,
      1200,
      ctx,
    );
    expect(out.alpha).toBeCloseTo(0.5, 9);
  });

  it("underline-draw: the text rises late while the rule owns the start", () => {
    const tIn = timing({ preset: "underline-draw" });
    const early = sampleTextUnit(tIn, 0, 220); // p = 0.3: text not started
    expect(early.alpha).toBe(0);
    expect(early.dyEm).toBeCloseTo(-UNDERLINE_RISE_EM, 12);
    const mid = sampleTextUnit(tIn, 0, 360); // p = 0.65 → u = 0.5
    expect(mid.alpha).toBeCloseTo(0.5, 12);
    expect(mid.dyEm).toBeCloseTo(-UNDERLINE_RISE_EM / 2, 12);
    const out = sampleTextUnit(
      timing({ preset: "underline-draw", outPreset: "underline-draw" }, 1000),
      0,
      1140, // q = 0.35 → v = 0.5
    );
    expect(out.alpha).toBeCloseTo(0.5, 12);
    expect(out.dyEm).toBeCloseTo(-UNDERLINE_RISE_EM / 2, 12);
  });

  it("orbit sweeps in on an arc about the block centre, honouring direction", () => {
    const ctx = { count: 5, unitCenterEm: [2, 0] as const };
    const dir = (twistDir: 1 | -1) =>
      timing({
        preset: "orbit",
        granularity: "char",
        params: { startScale: 0.8, shine: false, twistDir },
      });
    const start = sampleTextUnit(dir(1), 0, 100, ctx);
    expect(start.rotZRad).toBeCloseTo(ORBIT_SWEEP_RAD, 12);
    expect(start.dxEm).toBeCloseTo(2 * (Math.cos(ORBIT_SWEEP_RAD) - 1), 12);
    expect(start.dyEm).toBeCloseTo(2 * Math.sin(ORBIT_SWEEP_RAD), 12);
    expect(start.alpha).toBe(0);
    const mid = sampleTextUnit(dir(1), 0, 300, ctx);
    expect(mid.rotZRad).toBeCloseTo(ORBIT_SWEEP_RAD / 2, 12);
    expect(mid.alpha).toBe(1);
    expect(sampleTextUnit(dir(-1), 0, 100, ctx).rotZRad).toBeCloseTo(-ORBIT_SWEEP_RAD, 12);
    // out re-curls the other way and spins off
    const tOut = timing(
      {
        preset: "orbit",
        outPreset: "orbit",
        granularity: "char",
        params: { startScale: 0.8, shine: false, twistDir: 1 },
      },
      1000,
    );
    const out = sampleTextUnit(tOut, 0, 1200, ctx);
    const theta = -ORBIT_SWEEP_RAD * 0.5;
    expect(out.rotZRad).toBeCloseTo(theta, 12);
    expect(out.dxEm).toBeCloseTo(2 * (Math.cos(theta) - 1), 12);
    expect(out.dyEm).toBeCloseTo(2 * Math.sin(theta), 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("weight-build thickens from hairline, thins out on the out", () => {
    const tIn = timing({ preset: "weight-build" });
    expect(sampleTextUnit(tIn, 0, 100).weightEm).toBeCloseTo(-WEIGHT_EM, 12);
    expect(sampleTextUnit(tIn, 0, 300).weightEm).toBeCloseTo(-WEIGHT_EM / 2, 12);
    expect(sampleTextUnit(tIn, 0, 220).alpha).toBeCloseTo(1, 12);
    const out = sampleTextUnit(
      timing({ preset: "weight-build", outPreset: "weight-build" }, 1000),
      0,
      1200,
    );
    expect(out.weightEm).toBeCloseTo(-WEIGHT_EM / 2, 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("develop reveals in seeded random order (hashed delay, salt 4)", () => {
    const ctx = { count: 13 } as const;
    const tIn = timing({ preset: "develop", granularity: "char" });
    for (const i of [0, 5, 9]) {
      const delay = unitHash01(i, 4) * 600;
      const s = sampleTextUnit(tIn, i, 100 + delay + 200, ctx);
      expect(s.alpha, `unit ${i}`).toBeCloseTo(0.5, 9);
      expect(s.softEm, `unit ${i}`).toBeCloseTo(DEVELOP_SOFT_EM / 2, 9);
    }
    const tOut = timing({ preset: "develop", outPreset: "develop", granularity: "char" }, 1000);
    const o = sampleTextUnit(tOut, 0, 1000 + unitHash01(0, 4) * 600 + 200, ctx);
    expect(o.alpha).toBeCloseTo(0.5, 9);
    expect(o.softEm).toBeCloseTo(DEVELOP_SOFT_EM / 2, 9);
  });

  it("flip-cascade flips up from face-down with a mid-flip dip", () => {
    const tIn = timing({ preset: "flip-cascade", granularity: "char" });
    const start = sampleTextUnit(tIn, 0, 100);
    expect(start.rotXRad).toBeCloseTo(FLIP_RAD, 12);
    expect(start.alpha).toBe(0);
    const mid = sampleTextUnit(tIn, 0, 300);
    expect(mid.rotXRad).toBeCloseTo(FLIP_RAD / 2, 12);
    expect(mid.dyEm).toBeCloseTo(-FLIP_DIP_EM, 12);
    expect(sampleTextUnit(tIn, 0, 180).alpha).toBeCloseTo(1, 12);
    const out = sampleTextUnit(
      timing({ preset: "flip-cascade", outPreset: "flip-cascade", granularity: "char" }, 1000),
      0,
      1200,
    );
    expect(out.rotXRad).toBeCloseTo(-FLIP_RAD / 2, 12);
    expect(out.dyEm).toBeCloseTo(-FLIP_DIP_EM, 12);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("converge streaks in from both edges (sign of the unit centre)", () => {
    const tIn = timing({ preset: "converge", granularity: "char" });
    const right = { count: 5, unitCenterEm: [2, 0] as const };
    const left = { count: 5, unitCenterEm: [-2, 0] as const };
    expect(sampleTextUnit(tIn, 0, 100, right).dxEm).toBeCloseTo(CONVERGE_EM, 12);
    expect(sampleTextUnit(tIn, 0, 100, left).dxEm).toBeCloseTo(-CONVERGE_EM, 12);
    expect(sampleTextUnit(tIn, 0, 100, right).scaleX).toBeCloseTo(1, 12);
    const mid = sampleTextUnit(tIn, 0, 300, right);
    expect(mid.dxEm).toBeCloseTo(CONVERGE_EM / 2, 12);
    expect(mid.scaleX).toBeCloseTo(1 + CONVERGE_STREAK, 9); // streak peaks mid-travel
    expect(sampleTextUnit(tIn, 0, 180, right).alpha).toBeCloseTo(1, 12);
    const out = sampleTextUnit(
      timing({ preset: "converge", outPreset: "converge", granularity: "char" }, 1000),
      0,
      1200,
      right,
    );
    expect(out.dxEm).toBeCloseTo(CONVERGE_EM / 2, 12);
    expect(out.scaleX).toBeCloseTo(1 + CONVERGE_STREAK, 9);
    expect(out.alpha).toBeCloseTo(0.5, 12);
  });

  it("glint-wipe wipes with the shine tracking the edge (accent constants pinned)", () => {
    const tIn = timing({ preset: "glint-wipe" });
    const mid = sampleTextUnit(tIn, 0, 300);
    expect(mid.sweep).toEqual([0, 0.5]);
    expect(mid.shineU).toBeCloseTo(0.5, 12);
    expect(mid.alpha).toBe(1);
    const out = sampleTextUnit(
      timing({ preset: "glint-wipe", outPreset: "glint-wipe" }, 1000),
      0,
      1100,
    );
    expect(out.sweep).toEqual([0.25, 1]);
    expect(out.shineU).toBeCloseTo(0.25, 12);
    expect(GLINT_HALF_W).toBe(0.06);
    expect(GLINT_INTENSITY).toBe(0.85);
    expect(GLINT_HALF_W).toBeLessThan(SHINE_HALF_W);
    expect(GLINT_INTENSITY).toBeGreaterThan(SHINE_INTENSITY);
  });

  it("vapor dissolves upward with hashed wobble and rate jitter; the in condenses", () => {
    const one = { count: 1 } as const;
    const vaporDur = (i: number) =>
      400 * (VAPOR_RATE_MIN + (1 - VAPOR_RATE_MIN) * unitHash01(i, 6));
    const phase = unitHash01(0, 5) * 2 * Math.PI;
    const tOut = timing({ preset: "fade", outPreset: "vapor", granularity: "char" }, 1000);
    const o = sampleTextUnit(tOut, 0, 1000 + vaporDur(0) / 2, one);
    expect(o.alpha).toBeCloseTo(0.5, 9);
    expect(o.dyEm).toBeCloseTo(VAPOR_RISE_EM / 2, 9);
    expect(o.dxEm).toBeCloseTo(Math.sin(Math.PI + phase) * VAPOR_WOBBLE_EM * 0.5, 9);
    expect(o.softEm).toBeCloseTo(VAPOR_SOFT_EM / 2, 9);
    const tIn = timing({ preset: "vapor", granularity: "char" });
    const mid = sampleTextUnit(tIn, 0, 100 + vaporDur(0) / 4, one);
    expect(mid.alpha).toBeCloseTo(0.25, 9);
    expect(mid.dyEm).toBeCloseTo(VAPOR_RISE_EM * 0.75, 9);
    expect(mid.softEm).toBeCloseTo(VAPOR_SOFT_EM * 0.75, 9);
    expect(mid.dxEm).toBeCloseTo(Math.sin(0.75 * 2 * Math.PI + phase) * VAPOR_WOBBLE_EM * 0.75, 9);
  });
});

describe("underlineProgress (the companion rule)", () => {
  it("draws over the first UNDERLINE_DRAW_P of the eased in window", () => {
    const t = timing({ preset: "underline-draw", outPreset: "none" });
    expect(underlineProgress(t, 0)).toBe(0);
    expect(underlineProgress(t, 100)).toBe(0);
    expect(underlineProgress(t, 180)).toBeCloseTo(0.5, 12); // p = 0.2
    expect(underlineProgress(t, 260)).toBeCloseTo(1, 12); // p = UNDERLINE_DRAW_P
    expect(underlineProgress(t, 2000)).toBe(1);
  });

  it("out: re-draws, holds, then wipes off", () => {
    const t = timing({ preset: "underline-draw", outPreset: "underline-draw" }, 1000);
    expect(underlineProgress(t, 1080)).toBeCloseTo(0.5, 12); // q = 0.2: re-drawing
    expect(underlineProgress(t, 1200)).toBe(1); // q = 0.5: the hold
    expect(underlineProgress(t, 1340)).toBeCloseTo(0.5, 12); // q = 0.85: wiping
    expect(underlineProgress(t, 1400)).toBe(0);
  });

  it("a non-underline out wipes the rule with the fade", () => {
    const t = timing({ preset: "underline-draw", outPreset: "fade" }, 1000);
    expect(underlineProgress(t, 1200)).toBeCloseTo(0.5, 12);
  });

  it("returns 0 when neither side is underline-draw, and during a foreign in", () => {
    expect(underlineProgress(timing({ preset: "fade", outPreset: "fade" }), 300)).toBe(0);
    const t = timing({ preset: "fade", outPreset: "underline-draw" }, 1000);
    expect(underlineProgress(t, 300)).toBe(0);
    expect(underlineProgress(t, 1080)).toBeCloseTo(0.5, 12);
  });
});

describe("sampleTextUnit delayMs (the delayed-start hold)", () => {
  it("holds the pre-entry state until from + delayMs, then plays the in verbatim", () => {
    const delayed = timing({ delayMs: 300 });
    const plain = timing();
    // 1ms before the delayed start: exactly the undelayed pre-entry sample.
    expect(sampleTextUnit(delayed, 0, 399)).toEqual(sampleTextUnit(plain, 0, 99));
    expect(sampleTextUnit(delayed, 0, 399).alpha).toBe(0);
    // Mid-in: exactly the undelayed sample half the window in.
    expect(sampleTextUnit(delayed, 0, 600)).toEqual(sampleTextUnit(plain, 0, 300));
    expect(sampleTextUnit(delayed, 0, 900).alpha).toBe(1);
  });

  it("composes additively with per-unit stagger", () => {
    const delayed = timing({ delayMs: 300 });
    const plain = timing();
    // unit 2 starts at from + delayMs + 2 × staggerMs.
    expect(sampleTextUnit(delayed, 2, 499).alpha).toBe(0);
    expect(sampleTextUnit(delayed, 2, 700)).toEqual(sampleTextUnit(plain, 2, 400));
  });

  it("never shifts the out: a delayed in composes with an on-schedule out", () => {
    // in 100→500 delayed to start at 900; the out still starts at outAt 1000.
    const t = timing({ delayMs: 800 }, 1000);
    const s = sampleTextUnit(t, 0, 1100);
    // p = 0.5 (in mid-flight), q = 0.25 (out on schedule): fade × fade.
    expect(s.alpha).toBeCloseTo(0.5 * 0.75, 12);
  });

  it("shifts block-progress walks (word-cycle) by the same delay", () => {
    const delayed = timing({ preset: "word-cycle", outPreset: "none", staggerMs: 0, delayMs: 300 });
    const plain = timing({ preset: "word-cycle", outPreset: "none", staggerMs: 0 });
    const ctx = { count: 3 };
    expect(sampleTextUnit(delayed, 1, 550, ctx)).toEqual(sampleTextUnit(plain, 1, 250, ctx));
  });

  it("delays the underline draw with the text, out still on schedule", () => {
    const delayed = timing({ preset: "underline-draw", outPreset: "none", delayMs: 300 });
    const plain = timing({ preset: "underline-draw", outPreset: "none" });
    expect(underlineProgress(delayed, 399)).toBe(0);
    expect(underlineProgress(delayed, 520)).toBeCloseTo(underlineProgress(plain, 220), 12);
    const withOut = timing(
      { preset: "underline-draw", outPreset: "underline-draw", delayMs: 800 },
      1000,
    );
    expect(underlineProgress(withOut, 1080)).toBeCloseTo(0.5, 12); // q = 0.2: re-drawing on time
  });
});
