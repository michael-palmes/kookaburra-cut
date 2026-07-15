import { describe, expect, it } from "vitest";
import type { Theme } from "../../theme/tokens";
import {
  computeStaggerUnits,
  DEFAULT_START_SCALE,
  EDGE_SENTINEL,
  hasOwnAnimationProps,
  MAX_STAGGER_UNITS,
  resolveTextAnimation,
  resolveTextAnimationWithDoc,
  SCATTER_DEPTH_EM,
  SCATTER_FADE_P,
  SCATTER_ROLL_MAX_RAD,
  SCATTER_ROLL_MIN_RAD,
  SCATTER_TILT_RAD,
  SHINE_HALF_W,
  sampleTextUnit,
  shineBand,
  type TextAnimTiming,
  TWIST_RAD,
  TWIST_START_SCALE,
  unitHash01,
  unitIndexForKey,
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
