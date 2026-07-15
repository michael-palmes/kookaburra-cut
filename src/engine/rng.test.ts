import { describe, expect, it } from "vitest";
import { createSeededRandom } from "./rng";

describe("createSeededRandom", () => {
  it("produces identical sequences for identical seeds", () => {
    const a = createSeededRandom(1234);
    const b = createSeededRandom(1234);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const divergent = Array.from({ length: 10 }, () => a() !== b());
    expect(divergent).toContain(true);
  });

  it("stays in [0, 1)", () => {
    const rand = createSeededRandom(99);
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("truncates fractional seeds to the same stream", () => {
    const a = createSeededRandom(7.9);
    const b = createSeededRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  // The exact mulberry32 stream is part of the export contract: committed projects bake generative geometry from it, so ANY change to these values means every generative scene re-renders differently. Do not update these numbers casually.
  it("matches the golden mulberry32 streams", () => {
    const seed0 = createSeededRandom(0);
    expect([seed0(), seed0(), seed0(), seed0()]).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111,
    ]);
    const seed1 = createSeededRandom(1);
    expect([seed1(), seed1(), seed1(), seed1()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741,
    ]);
    const seed42 = createSeededRandom(42);
    expect([seed42(), seed42(), seed42(), seed42()]).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
    ]);
  });
});
