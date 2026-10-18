import { describe, expect, it } from "vitest";
import { ease } from "../../engine/ease";
import { clamp01, lerp, ramp } from "./math";
import { sampleKeys } from "./sampleKeys";
import { stampScale } from "./stampScale";

describe("clamp01", () => {
  it("clamps and reads NaN as 0", () => {
    expect([-1, 0, 0.25, 1, 2, Number.NaN].map(clamp01)).toEqual([0, 0, 0.25, 1, 1, 0]);
  });
});

describe("ramp", () => {
  it("is linear by default and clamps the time", () => {
    expect(ramp(-50, 0, 200)).toBe(0);
    expect(ramp(50, 0, 200)).toBe(0.25);
    expect(ramp(500, 0, 200)).toBe(1);
  });

  it("eases with a named curve and passes the overshoot through", () => {
    expect(ramp(150, 100, 300, "outCubic")).toBe(ease("outCubic", 0.25));
    expect(ramp(200, 100, 300, "outBack", { overshoot: 3 })).toBe(1.25);
  });

  it("steps when the span is empty", () => {
    expect(ramp(99, 100, 100)).toBe(0);
    expect(ramp(100, 100, 100)).toBe(1);
    expect(ramp(100, 100, 50)).toBe(1);
  });

  it("re-exports the engine lerp", () => {
    expect(lerp(2, 4, 0.25)).toBe(2.5);
  });
});

describe("sampleKeys", () => {
  const keys = [
    { tMs: 600, x: 1, opacity: 1, label: "end", ease: "outCubic" },
    { tMs: 0, x: -1, opacity: 0, label: "start" },
  ];

  it("sorts, holds the ends and eases by the arriving key", () => {
    expect(sampleKeys(keys, -100)).toEqual({ x: -1, opacity: 0, label: "start" });
    expect(sampleKeys(keys, 900)).toEqual({ x: 1, opacity: 1, label: "end" });
    const mid = sampleKeys(keys, 150);
    const p = ease("outCubic", 0.25);
    expect(mid.x).toBe(lerp(-1, 1, p));
    expect(mid.opacity).toBe(p);
    expect(mid.label).toBe("start");
  });

  it("defaults to linear and honours a default ease option", () => {
    const plain = [
      { tMs: 0, v: 0 },
      { tMs: 100, v: 10 },
    ];
    expect(sampleKeys(plain, 25).v).toBe(2.5);
    expect(sampleKeys(plain, 25, { ease: "inQuad" }).v).toBe(0.625);
  });

  it("interpolates equal-length number arrays and holds everything else", () => {
    const track = [
      { tMs: 0, pos: [0, 0, 0], size: [1, 1], colour: "#000000" },
      { tMs: 100, pos: [2, 4, 6], size: [1, 1, 1], colour: "#ffffff" },
    ];
    const s = sampleKeys(track, 50);
    expect(s.pos).toEqual([1, 2, 3]);
    expect(s.size).toEqual([1, 1]);
    expect(s.colour).toBe("#000000");
    expect(sampleKeys(track, 100).colour).toBe("#ffffff");
  });

  it("interpolates a property across the keys that set it", () => {
    const track = [
      { tMs: 0, x: 0, y: 0 },
      { tMs: 100, x: 10 },
      { tMs: 200, x: 20, y: 20 },
    ];
    expect(sampleKeys(track, 100)).toEqual({ x: 10, y: 10 });
  });

  it("lets a Back ease overshoot between keys", () => {
    const track = [
      { tMs: 0, s: 0 },
      { tMs: 100, s: 1, ease: "outBack" },
    ];
    expect(sampleKeys(track, 50, { overshoot: 3 }).s).toBe(1.25);
  });

  it("samples properties named like object prototype keys", () => {
    const track = [
      { tMs: 0, valueOf: 0, constructor: 2 },
      { tMs: 100, valueOf: 1, constructor: 4 },
    ];
    expect(sampleKeys(track, 50)).toEqual({ valueOf: 0.5, constructor: 3 });
  });
});

describe("stampScale", () => {
  // The defaults are contract: scenes bake their pops from them.
  it("matches the golden default curve", () => {
    const stamp = stampScale();
    expect([-1, 0, 45, 90, 135, 180, 245, 310, 375, 440, 1000].map(stamp)).toEqual([
      0, 0, 0.6475000000000001, 0.9800000000000001, 1.1025, 1.12, 1.1024264068711929, 1.06,
      1.0175735931288072, 1, 1,
    ]);
  });

  it("takes custom phases", () => {
    const stamp = stampScale({ from: 0.5, peak: 1.3, inMs: 100, settleMs: 0 });
    expect(stamp(-10)).toBe(0.5);
    expect(stamp(Number.NaN)).toBe(0.5);
    expect(stamp(50)).toBe(lerp(0.5, 1.3, ease("outCubic", 0.5)));
    expect(stamp(100)).toBe(1);
  });
});
