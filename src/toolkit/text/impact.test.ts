import { describe, expect, it } from "vitest";
import { STAMP_SCALE_DEFAULTS } from "../motion/stampScale";
import { hitWindow, impactUnitCount, stampImpactMs, textImpactMs } from "./impact";
import { type ResolvedTextAnimation, TEXT_PRESET_NAMES, type TextPresetName } from "./presets";
import measured from "./textImpact.json";

const anim = (
  preset: TextPresetName,
  extra: Partial<ResolvedTextAnimation> = {},
): ResolvedTextAnimation => ({
  preset,
  outPreset: "none",
  ease: measured.ease,
  staggerMs: 0,
  granularity: null,
  params: { startScale: 0.8, shine: false, twistDir: 1 },
  ...extra,
});

describe("textImpactMs", () => {
  it("scales with the window", () => {
    expect(textImpactMs(anim("fade"), 1200)).toBeCloseTo(2 * textImpactMs(anim("fade"), 600), -1);
  });

  it("follows the ease: a slower ease lands later", () => {
    const quick = textImpactMs(anim("fade", { ease: "outExpo" }), 600);
    const slow = textImpactMs(anim("fade", { ease: "linear" }), 600);
    expect(quick).toBeLessThan(slow);
  });

  it("counts an overshoot's crossing only once it's opaque", () => {
    // spring-pop first reaches full size while still fading in, so it lands on the second crossing.
    expect(textImpactMs(anim("spring-pop"), 600)).toBeGreaterThan(100);
  });

  it("lands typewriter on its first keystroke and divides word-cycle by its words", () => {
    expect(textImpactMs(anim("typewriter"), 600, 6)).toBe(100);
    expect(textImpactMs(anim("word-cycle"), 600, 3)).toBeLessThan(
      textImpactMs(anim("word-cycle"), 600, 1),
    );
  });

  it("stays quick on an absurd window", () => {
    const started = Date.now();
    expect(textImpactMs(anim("fade"), 1e12)).toBeGreaterThan(0);
    expect(stampImpactMs({ inMs: 1e12 })).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keys its cache on build's shift", () => {
    const short = anim("build", {
      params: { startScale: 0.8, shine: false, twistDir: 1, buildShiftEm: 0 },
    });
    const long = anim("build", {
      params: { startScale: 0.8, shine: false, twistDir: 1, buildShiftEm: 6 },
    });
    expect(textImpactMs(long, 600)).toBeGreaterThan(textImpactMs(short, 600));
  });

  it("lands the v0 ramp where it ends", () => {
    expect(textImpactMs(anim("none"), 480)).toBe(480);
  });

  it("agrees with the capture for every motion (tools/impact-probe)", () => {
    const FRAME = 1000 / measured.fps;
    const off: string[] = [];
    for (const preset of TEXT_PRESET_NAMES) {
      const units = preset === "typewriter" ? 6 : 1;
      const got = textImpactMs(anim(preset), measured.windowMs, units);
      const seen = measured.motions[preset as keyof typeof measured.motions];
      if (typeof seen !== "number" || Math.abs(got - seen) > 3 * FRAME) {
        off.push(`${preset}: sampled ${got}, captured ${seen}`);
      }
    }
    expect(off).toEqual([]);
  });
});

describe("hitWindow", () => {
  it("keeps the in duration and starts the lead earlier", () => {
    const motion = anim("slam");
    const lead = textImpactMs(motion, 600);
    expect(hitWindow(5000, motion, 0, 600)).toEqual({ from: 5000 - lead, to: 5600 - lead });
  });

  it("takes the delay out too", () => {
    const motion = anim("fade", { delayMs: 200 });
    const plain = hitWindow(5000, anim("fade"), 0, 600);
    expect(hitWindow(5000, motion, 0, 600).from).toBe(plain.from - 200);
  });

  it("ignores where the window was authored", () => {
    expect(hitWindow(5000, anim("fade"), 1000, 1600)).toEqual(
      hitWindow(5000, anim("fade"), 0, 600),
    );
  });
});

describe("impactUnitCount", () => {
  it("only reads the copy for motions that divide the window", () => {
    expect(impactUnitCount(anim("fade"), "two words")).toBe(1);
    expect(impactUnitCount(anim("word-cycle"), "two words  here")).toBe(3);
    expect(impactUnitCount(anim("typewriter"), "abc")).toBe(3);
  });
});

describe("stampImpactMs", () => {
  it("agrees with the capture on the default pop", () => {
    expect(Math.abs(stampImpactMs() - measured.stamps.Stamp)).toBeLessThanOrEqual(34);
  });

  it("follows the pop's own timing", () => {
    expect(stampImpactMs({ inMs: STAMP_SCALE_DEFAULTS.inMs * 2 })).toBeGreaterThan(stampImpactMs());
  });
});
