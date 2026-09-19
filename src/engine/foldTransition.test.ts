import { describe, expect, it } from "vitest";
import {
  FOLD_BLUR_MAX_RADIUS,
  FOLD_POWER_WINDOW_DEG,
  FOLD_RAMP_EDGE,
  FOLD_SWITCH_DEG,
  foldOpenedAtMs,
  foldRampFront,
  foldSampleAt,
  foldScreenLevels,
  foldScreensAt,
  resolveFoldSwitchDeg,
  resolveFoldTransition,
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

describe("the blur handover", () => {
  // The Duo: static half on the right of the inside display, hinge on the left of the outside one.
  const UNFOLD = { closedDeg: 0, openDeg: 180 };
  const at = (deg: number, range: typeof UNFOLD | null = UNFOLD, spec = {}) =>
    foldScreensAt(deg, range, spec, false, 1, true);
  const us = [0, 0.25, 0.5, 0.75, 1];

  it("rests at any held angle: a Book or Flex pose is simply lit and sharp", () => {
    for (const deg of [0, 45, 90, 120, 180]) {
      const plain = foldScreenLevels(deg, {}, false);
      const state = at(deg, null);
      expect(state.main.flat).toBe(0);
      for (const u of us) {
        expect(foldSampleAt(state.main, u)).toEqual({ radius: 0, gain: plain.main });
        expect(foldSampleAt(state.cover, u)).toEqual({ radius: 0, gain: plain.cover });
      }
    }
  });

  it("starts and ends a fold exactly where the device rests, so nothing pops", () => {
    const closed = at(0);
    const open = at(180);
    for (const u of us) {
      expect(foldSampleAt(closed.cover, u)).toEqual({ radius: 0, gain: 1 });
      expect(foldSampleAt(open.main, u)).toEqual({ radius: 0, gain: 1 });
    }
    expect(closed.main.level).toBe(0);
    expect(open.cover.level).toBe(0);
    expect(closed.cover.flat).toBe(0);
    expect(open.main.flat).toBe(0);
    // Home: the ramp starts past the free edge, so it touches nothing.
    expect(foldRampFront(0)).toBe(FOLD_RAMP_EDGE);
  });

  it("draws the moving panel's content flat through the middle of the fold", () => {
    expect(at(40).cover.flat).toBe(1);
    expect(at(130).main.flat).toBe(1);
  });

  it("matches the brightness measured along Apple's footage at 45 degrees", () => {
    // Hinge edge about 0.87, mid panel about 0.5 to 0.6, free edge about 0.12.
    const { cover } = at(45);
    expect(foldSampleAt(cover, 0).gain).toBeGreaterThan(0.8);
    expect(foldSampleAt(cover, 0.7).gain).toBeGreaterThan(0.35);
    expect(foldSampleAt(cover, 0.7).gain).toBeLessThan(0.65);
    expect(foldSampleAt(cover, 1).gain).toBeLessThan(0.2);
    // One smooth ramp: brightness only ever falls towards the free edge.
    let previous = 2;
    for (let u = 0; u <= 1.0001; u += 0.05) {
      const gain = foldSampleAt(cover, u).gain;
      expect(gain).toBeLessThanOrEqual(previous);
      previous = gain;
    }
  });

  it("darkens the free edge almost at once, and softens ahead of the dimming", () => {
    const early = at(12).cover;
    expect(foldSampleAt(early, 0.1)).toEqual({ radius: 0, gain: 1 });
    expect(foldSampleAt(early, 0.5).gain).toBe(1);
    expect(foldSampleAt(early, 1).gain).toBeLessThan(0.35);
    const mid = at(45).cover;
    // The hinge side is already soft while it is still bright, and fully soft where it is only half dimmed.
    expect(foldSampleAt(mid, 0.3).radius).toBeGreaterThan(FOLD_BLUR_MAX_RADIUS / 2);
    expect(foldSampleAt(mid, 0.3).gain).toBeGreaterThan(0.95);
    expect(foldSampleAt(mid, 0.7).radius).toBeCloseTo(FOLD_BLUR_MAX_RADIUS, 12);
  });

  it("mirrors the outside display on the swinging half, by its turn from flat", () => {
    // 45 degrees open and 45 degrees short of flat are the same picture, hinge to free edge.
    const cover = at(45).cover;
    const swing = at(135).main;
    for (const h of [0, 0.3, 0.6, 1]) {
      const onCover = foldSampleAt(cover, h);
      const onSwing = foldSampleAt(swing, 0.5 - h / 2);
      expect(onSwing.gain).toBeCloseTo(onCover.gain, 9);
      expect(onSwing.radius).toBeCloseTo(onCover.radius / 2, 9);
    }
  });

  it("leaves the static half of the inside display alone", () => {
    for (const deg of [10, 60, 95, 130, 170]) {
      const main = at(deg).main;
      for (const u of [0.6, 0.75, 1]) {
        expect(foldSampleAt(main, u)).toEqual({ radius: 0, gain: main.level });
      }
    }
  });

  it("turns the outside display off as it nears edge-on", () => {
    expect(at(60).cover.level).toBe(1);
    expect(at(90).cover.level).toBe(0);
    expect(at(150).cover.level).toBe(0);
  });

  it("sweeps one way only: a fold never flickers back", () => {
    let mainFront = Number.NEGATIVE_INFINITY;
    let coverFront = Number.POSITIVE_INFINITY;
    for (let deg = 0; deg <= 180; deg++) {
      const state = at(deg);
      expect(state.main.front).toBeGreaterThanOrEqual(mainFront);
      expect(state.cover.front).toBeLessThanOrEqual(coverFront);
      mainFront = state.main.front;
      coverFront = state.cover.front;
    }
  });

  it("plays against the fold's own range, so a partial unfold still finishes clean", () => {
    const partial = { closedDeg: 0, openDeg: 120 };
    const end = at(120, partial).main;
    for (const u of us) expect(foldSampleAt(end, u)).toEqual({ radius: 0, gain: 1 });
    // Half way through a 0 to 120 fold looks like half way through a full one.
    expect(at(60, partial).main.front).toBe(at(90).main.front);
  });

  it("skips a fold that never changes which display is lit", () => {
    const state = at(150, { closedDeg: 100, openDeg: 180 });
    expect(state.main).toMatchObject({ blur: 0, darken: 0, flat: 0, level: 1 });
  });

  it("mirrors for a device whose static half is on the other side", () => {
    const right = foldScreensAt(140, UNFOLD, {}, false, 1, true).main;
    const left = foldScreensAt(140, UNFOLD, {}, false, -1, true).main;
    for (const u of us) expect(foldSampleAt(left, u)).toEqual(foldSampleAt(right, 1 - u));
  });

  it("is the plain brightness handover when switched off, at zero intensity, or with both screens held on", () => {
    for (const deg of [0, 30, 45, 60, 120, 180]) {
      const plain = foldScreenLevels(deg, {}, false);
      for (const spec of [{ enabled: false }, { intensity: 0 }]) {
        const state = at(deg, UNFOLD, spec);
        expect(foldSampleAt(state.main, 0.3)).toEqual({ radius: 0, gain: plain.main });
        expect(foldSampleAt(state.cover, 0.3)).toEqual({ radius: 0, gain: plain.cover });
      }
      const both = foldScreensAt(deg, UNFOLD, {}, true, 1, true);
      expect(foldSampleAt(both.main, 0.3)).toEqual({ radius: 0, gain: 1 });
      expect(foldSampleAt(both.cover, 0.3)).toEqual({ radius: 0, gain: 1 });
    }
  });

  it("scales blur and dimming independently, and clamps every option", () => {
    const soft = at(95, UNFOLD, { blur: 0.5, darken: 0 }).main;
    expect(foldSampleAt(soft, 0.02).radius).toBeCloseTo(FOLD_BLUR_MAX_RADIUS / 4, 9);
    expect(foldSampleAt(soft, 0.02).gain).toBe(1);
    expect(resolveFoldTransition({ intensity: 9, blur: -1, darken: Number.NaN })).toMatchObject({
      enabled: true,
      intensity: 1,
      blur: 0,
      darken: 1,
    });
  });
});
