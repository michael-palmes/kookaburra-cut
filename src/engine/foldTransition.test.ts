import { describe, expect, it } from "vitest";
import {
  FOLD_POWER_WINDOW_DEG,
  FOLD_SWITCH_DEG,
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
