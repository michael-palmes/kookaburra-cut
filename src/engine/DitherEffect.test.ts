import { afterEach, describe, expect, it } from "vitest";
import { ditherFragment } from "./DitherEffect";
import { resolveFrameEffects } from "./effects";
import { useEffectsStore } from "./effectsStore";
import { DEFAULT_RENDER_SETTINGS } from "./renderSettings";
import type { Resolved } from "./sceneTimeline";

/** The shader's noise and remap, mirrored so the contract's statistics are pinned. */
function ign(x: number, y: number): number {
  const f = (v: number) => v - Math.floor(v);
  return f(52.9829189 * f(x * 0.06711056 + y * 0.00583715));
}
function tri(u: number): number {
  const v = u * 2 - 1;
  return Math.sign(v) * (1 - Math.sqrt(Math.max(0, 1 - Math.abs(v))));
}

describe("DitherEffect", () => {
  it("dithers only the encoded output, in display space", () => {
    expect(ditherFragment).toContain("#ifdef ENCODE_OUTPUT");
    expect(ditherFragment).toContain("sRGBTransferOETF");
    expect(ditherFragment).toContain("sRGBTransferEOTF");
    expect(ditherFragment).not.toMatch(/uniform|time/);
  });

  it("is zero-mean triangular noise within one level", () => {
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const d = tri(ign(x, y));
        expect(Math.abs(d)).toBeLessThanOrEqual(1);
        sum += d;
        sumSq += d * d;
        n++;
      }
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.01);
    // A triangular distribution on (-1, 1) has variance 1/6.
    expect(sumSq / n).toBeCloseTo(1 / 6, 1);
  });

  describe("routing", () => {
    afterEach(() => useEffectsStore.getState().clearEffects());
    const solo = { active: [{ index: 0 }] } as unknown as Resolved;

    it("sends an effect-free project through the chain only when it opts in", () => {
      expect(resolveFrameEffects(solo)).toBeNull();
      useEffectsStore
        .getState()
        .setProjectEffects({}, {}, {}, { ...DEFAULT_RENDER_SETTINGS, dither: true });
      expect(resolveFrameEffects(solo)).toEqual({});
    });
  });
});
