import { describe, expect, it } from "vitest";
import {
  FOLD_POWER_WINDOW_DEG,
  FOLD_SWITCH_DEG,
  foldOpenedAtMs,
  foldScreenLevels,
  resolveFoldSwitchDeg,
} from "./foldTransition";

describe("a foldable's auto screen power", () => {
  it("lights exactly one display at each end of the hinge's travel", () => {
    expect(foldScreenLevels(0, undefined, false)).toEqual({ main: 0, cover: 1 });
    expect(foldScreenLevels(180, undefined, false)).toEqual({ main: 1, cover: 0 });
  });

  it("hands over smoothly across the window, never brighter than one display in total", () => {
    let previous = -1;
    for (let deg = 0; deg <= 180; deg++) {
      const { main, cover } = foldScreenLevels(deg, undefined, false);
      expect(main).toBeGreaterThanOrEqual(previous);
      expect(main + cover).toBeCloseTo(1, 12);
      previous = main;
    }
    expect(foldScreenLevels(FOLD_SWITCH_DEG, undefined, false).main).toBeCloseTo(0.5, 12);
    expect(foldScreenLevels(FOLD_SWITCH_DEG - FOLD_POWER_WINDOW_DEG, undefined, false).main).toBe(
      0,
    );
    expect(foldScreenLevels(FOLD_SWITCH_DEG + FOLD_POWER_WINDOW_DEG, undefined, false).main).toBe(
      1,
    );
  });

  it("keeps both displays lit at any angle when the scene asks", () => {
    for (const deg of [0, 45, 120, 180]) {
      expect(foldScreenLevels(deg, undefined, true)).toEqual({ main: 1, cover: 1 });
    }
  });

  it("clamps the switch angle so closed and open stay exact", () => {
    expect(resolveFoldSwitchDeg({ switchDeg: 0 })).toBe(FOLD_POWER_WINDOW_DEG);
    expect(resolveFoldSwitchDeg({ switchDeg: 400 })).toBe(180 - FOLD_POWER_WINDOW_DEG);
    expect(resolveFoldSwitchDeg({ switchDeg: Number.NaN })).toBe(FOLD_SWITCH_DEG);
    expect(foldScreenLevels(0, { switchDeg: 0 }, false).cover).toBe(1);
    expect(foldScreenLevels(180, { switchDeg: 400 }, false).main).toBe(1);
  });
});

describe("when the device opens", () => {
  // Closed until 500 ms, then a linear unfold over one second.
  const unfold = (ms: number) => Math.min(180, Math.max(0, ((ms - 500) / 1000) * 180));

  it("finds the first rendered frame at or past the switch angle", () => {
    // 45 degrees is a quarter of the way: 750 ms, which 30 fps cannot land on exactly.
    const at = foldOpenedAtMs(unfold, 1500, 45, 30);
    expect(at).toBeCloseTo(766.667, 2);
    expect(unfold(at ?? 0)).toBeGreaterThanOrEqual(45);
    expect(unfold((at ?? 0) - 1000 / 30)).toBeLessThan(45);
  });

  it("is zero for a device that starts open, and null for one that never opens", () => {
    expect(foldOpenedAtMs(() => 180, 0, 45, 30)).toBe(0);
    expect(foldOpenedAtMs(() => 0, 2000, 45, 30)).toBeNull();
  });

  it("takes the first crossing when an ease overshoots and dips back", () => {
    const wobble = (ms: number) => (ms < 400 ? 0 : ms < 600 ? 60 : ms < 800 ? 30 : 180);
    expect(foldOpenedAtMs(wobble, 1000, 45, 30)).toBe(400);
  });
});
