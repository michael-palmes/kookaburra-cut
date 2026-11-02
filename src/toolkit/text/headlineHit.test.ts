import { describe, expect, it } from "vitest";
import { withHitAt } from "./AnimatedHeadline";
import { textImpactMs } from "./impact";
import type { ResolvedTextAnimation } from "./presets";

const anim: ResolvedTextAnimation = {
  preset: "stamp",
  outPreset: "fade",
  ease: "outCubic",
  staggerMs: 0,
  granularity: null,
  params: { startScale: 0.8, shine: false, twistDir: 1 },
};

describe("withHitAt", () => {
  it("lands the v0 ramp at hitAt, keeping its length", () => {
    expect(withHitAt({ text: "x", hitAt: 2000, from: 0, to: 600 }, null)).toMatchObject({
      from: 1400,
      to: 2000,
    });
  });

  it("starts a motion its lead before hitAt and keeps the window", () => {
    const lead = textImpactMs(anim, 600);
    expect(withHitAt({ text: "x", hitAt: 2000, to: 600 }, anim)).toMatchObject({
      from: 2000 - lead,
      to: 2600 - lead,
    });
  });

  it("wins over `from` and leaves the out alone", () => {
    const moved = withHitAt({ text: "x", hitAt: 2000, from: 500, to: 1100, outAt: 3000 }, anim);
    expect(moved.from).toBe(2000 - textImpactMs(anim, 600));
    expect(moved.outAt).toBe(3000);
  });

  it("reads the lead from a pinned reveal's duration", () => {
    const lead = textImpactMs(anim, 1200);
    expect(withHitAt({ text: "x", hitAt: 2000, durationMs: 1200 }, anim).from).toBe(2000 - lead);
  });

  it("takes a sidecar delay out too", () => {
    const delayed = { ...anim, delayMs: 100 };
    expect(withHitAt({ text: "x", hitAt: 2000, to: 600 }, delayed).from).toBe(
      2000 - textImpactMs(anim, 600) - 100,
    );
  });

  it("counts words for a motion that divides its window", () => {
    const cycling = { ...anim, preset: "word-cycle" as const };
    expect(withHitAt({ text: "two words", hitAt: 2000, to: 600 }, cycling).from).toBe(
      2000 - textImpactMs(cycling, 600, 2),
    );
  });
});
