import { describe, expect, it } from "vitest";
import type { Theme } from "../../theme/tokens";
import {
  BUILD_FADE_P,
  BUILD_SHIFT_EM,
  buildLineShiftEm,
  EDGE_SENTINEL,
  hasOwnAnimationProps,
  presetNeedsShaderPath,
  presetNeedsTypeMask,
  resolveTextAnimation,
  STAMP_FROM_SCALE,
  STAMP_IN_P,
  STAMP_PEAK_SCALE,
  type StaggerUnits,
  sampleTextUnit,
  type TextAnimTiming,
  typewriterCount,
  typewriterHead,
  typewriterStops,
} from "./presets";

const theme: Theme = {
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

function timing(overrides: Partial<TextAnimTiming["anim"]> = {}, outAt?: number): TextAnimTiming {
  return {
    anim: {
      preset: "fade",
      outPreset: "none",
      ease: "linear",
      staggerMs: 100,
      granularity: "word",
      params: { startScale: 0.8, shine: false, twistDir: 1 },
      ...overrides,
    },
    from: 100,
    to: 500,
    outAt,
  };
}

/** Three words on one line: [0, 1], [1.5, 2.5], [3, 5] (layout units). */
const words = (centerY: [number, number, number] = [0, 0, 0]): StaggerUnits => ({
  count: 3,
  startX: new Float32Array([0, 1.5, 3]),
  endX: new Float32Array([1, 2.5, 5]),
  edgeKey: new Float32Array([1.25, 2.75, EDGE_SENTINEL]),
  centerY: new Float32Array(centerY),
  axis: "x",
});

describe("motion toolkit presets: resolution", () => {
  it("routes stamp and build through the pack, typewriter through the mask", () => {
    expect(presetNeedsShaderPath("stamp")).toBe(true);
    expect(presetNeedsShaderPath("build")).toBe(true);
    expect(presetNeedsShaderPath("typewriter")).toBe(false);
    expect(presetNeedsTypeMask("typewriter")).toBe(true);
    expect(presetNeedsTypeMask("build")).toBe(false);
  });

  it("forces build to words and typewriter to one block unit", () => {
    expect(resolveTextAnimation({ preset: "build" }, theme)?.granularity).toBe("word");
    expect(resolveTextAnimation({ preset: "build" }, theme)?.staggerMs).toBe(90);
    const typed = resolveTextAnimation(
      { preset: "typewriter", stagger: "char", staggerMs: 40 },
      theme,
    );
    expect(typed?.granularity).toBeNull();
    expect(resolveTextAnimation({ preset: "stamp" }, theme)?.granularity).toBeNull();
  });

  it("carries buildShiftEm only when authored", () => {
    expect(resolveTextAnimation({ preset: "build" }, theme)?.params.buildShiftEm).toBeUndefined();
    expect(
      resolveTextAnimation({ preset: "build", buildShiftEm: 0.6 }, theme)?.params,
    ).toMatchObject({
      buildShiftEm: 0.6,
    });
    const spec = { in: "build", out: "none", staggerMs: 200, buildShiftEm: 0 };
    expect(resolveTextAnimation({}, theme, spec)?.params.buildShiftEm).toBe(0);
    expect(resolveTextAnimation({ buildShiftEm: 0.2 }, theme)).not.toBeNull();
    expect(hasOwnAnimationProps({ buildShiftEm: 0.2 })).toBe(true);
  });
});

describe("stamp (goldens)", () => {
  const t = timing({ preset: "stamp", granularity: null, staggerMs: 0 });

  it("is a true 0 until it starts, then fully opaque", () => {
    expect(sampleTextUnit(t, 0, 50).alpha).toBe(0);
    expect(sampleTextUnit(t, 0, 100).alpha).toBe(0);
    expect(sampleTextUnit(t, 0, 101).alpha).toBe(1);
    expect(sampleTextUnit(t, 0, 2000).alpha).toBe(1);
  });

  it("drops from the oversize, lands on the squash and settles at 1", () => {
    expect(sampleTextUnit(t, 0, 100).scale).toBe(STAMP_FROM_SCALE);
    expect(sampleTextUnit(t, 0, 100 + 400 * STAMP_IN_P).scale).toBeCloseTo(STAMP_PEAK_SCALE, 9);
    expect(sampleTextUnit(t, 0, 500).scale).toBe(1);
    expect(sampleTextUnit(t, 0, 130).scale).toBeGreaterThan(1);
    expect(sampleTextUnit(t, 0, 130).scale).toBeLessThan(STAMP_FROM_SCALE);
  });

  it("ignores the ease (its own curve is the contract)", () => {
    const eased = timing({ preset: "stamp", granularity: null, staggerMs: 0, ease: "outExpo" });
    for (const ms of [120, 200, 320, 450]) {
      expect(sampleTextUnit(eased, 0, ms).scale).toBe(sampleTextUnit(t, 0, ms).scale);
    }
  });

  it("out grows back toward the oversize while fading", () => {
    const out = timing(
      { preset: "stamp", outPreset: "stamp", granularity: null, staggerMs: 0 },
      1000,
    );
    const mid = sampleTextUnit(out, 0, 1200);
    expect(mid.alpha).toBeCloseTo(0.5, 9);
    expect(mid.scale).toBeCloseTo(1 + (STAMP_FROM_SCALE - 1) * 0.5, 9);
  });
});

describe("build", () => {
  const t = timing({ preset: "build" });

  it("fades each word in over the first part of its window", () => {
    expect(sampleTextUnit(t, 0, 100).alpha).toBe(0);
    expect(sampleTextUnit(t, 0, 100 + 400 * BUILD_FADE_P).alpha).toBe(1);
    expect(sampleTextUnit(t, 1, 200).alpha).toBe(0);
  });

  it("re-centres the growing line: the unbuilt run shifts the visible words", () => {
    const units = words();
    expect(buildLineShiftEm(t, 0, units, 0.5, 0.5)).toBeCloseTo((5 * 0.5) / 0.5, 9);
    expect(buildLineShiftEm(t, 5000, units, 0.5, 0.5)).toBe(0);
    // Slots 1, 1.5, 2.5 at progress 1, 0.75, 0.5: 3.375 of 5 shown.
    expect(buildLineShiftEm(t, 500, units, 0.5, 0.5)).toBeCloseTo(((5 - 3.375) * 0.5) / 0.5, 9);
    expect(buildLineShiftEm(t, 500, units, 0, 0.5)).toBe(0);
    expect(buildLineShiftEm(t, 500, units, 1, 0.5)).toBeCloseTo((5 - 3.375) / 0.5, 9);
  });

  it("is single line only and builds nothing for other presets", () => {
    expect(buildLineShiftEm(t, 300, words([0, 0, -0.6]), 0.5, 0.5)).toBeUndefined();
    expect(buildLineShiftEm(timing(), 300, words(), 0.5, 0.5)).toBeUndefined();
  });

  it("slides each word in from the right on top of the line shift", () => {
    const at = sampleTextUnit(t, 1, 200, { count: 3, lineShiftEm: 2 });
    expect(at.dxEm).toBeCloseTo(2 + BUILD_SHIFT_EM, 9);
    const custom = timing({
      preset: "build",
      params: { startScale: 0.8, shine: false, twistDir: 1, buildShiftEm: 0 },
    });
    expect(sampleTextUnit(custom, 1, 200, { count: 3, lineShiftEm: 2 }).dxEm).toBe(2);
    expect(sampleTextUnit(t, 1, 200, { count: 3 }).dxEm).toBe(0);
  });
});

describe("typewriter", () => {
  const t = timing({ preset: "typewriter", granularity: null, staggerMs: 0 });

  it("types evenly across the window, a true 0 before it starts", () => {
    expect(typewriterCount(t, 0, 10)).toBe(0);
    expect(typewriterCount(t, 100, 10)).toBe(0);
    expect(typewriterCount(t, 300, 10)).toBe(5);
    expect(typewriterCount(t, 500, 10)).toBe(10);
    expect(typewriterCount(t, 9000, 10)).toBe(10);
    expect(typewriterCount(timing({ preset: "fade" }), 0, 10)).toBe(10);
  });

  it("honours a resolved delay and backspaces as an out", () => {
    expect(typewriterCount(timing({ preset: "typewriter", delayMs: 100 }), 300, 10)).toBe(2);
    const out = timing({ preset: "typewriter", outPreset: "typewriter" }, 1000);
    expect(typewriterCount(out, 1200, 10)).toBe(5);
    expect(typewriterCount(out, 1400, 10)).toBe(0);
    expect(sampleTextUnit(out, 0, 1400).alpha).toBe(0);
    expect(sampleTextUnit(out, 0, 1399).alpha).toBe(1);
  });

  it("gates the block alpha at the start", () => {
    expect(sampleTextUnit(t, 0, 100).alpha).toBe(0);
    expect(sampleTextUnit(t, 0, 101).alpha).toBe(1);
  });

  it("counts every keystroke but line breaks, astral code points once", () => {
    expect(typewriterStops("ab c\nd")).toEqual([0, 1, 2, 3, 5]);
    expect(typewriterStops("a𝐀b")).toEqual([0, 1, 3]);
  });

  it("places the head on the last shown character's line", () => {
    const text = "ab\ncd";
    const stops = typewriterStops(text);
    const carets = new Float32Array([0, 1, 0, 1, 1, 2, 0, 1, 2, 2, 0, 1, 0, 1, -1, 0, 1, 2, -1, 0]);
    expect(typewriterHead(text, stops, carets, 0)).toBe("none");
    expect(typewriterHead(text, stops, carets, 4)).toBe("all");
    expect(typewriterHead(text, stops, carets, 1)).toEqual({ x: 1, bottom: 0, top: 1 });
    expect(typewriterHead(text, stops, carets, 3)).toEqual({ x: 1, bottom: -1, top: 0 });
    expect(typewriterHead(text, stops, null, 2)).toBe("none");
  });
});
