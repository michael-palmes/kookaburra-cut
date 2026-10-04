import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { inkRibbonMaterial } from "../../kit/inkRibbon";
import { lookMaterialProblem } from "../../kit/material";
import {
  GROVE,
  groveWands,
  gustPeriod,
  hazeWindow,
  rowCounts,
  type WindState,
  wandPoint,
  wandTip,
  windDirection,
} from "./grove";
import { DOWNWIND_AZIMUTH_DEG, look, presets } from "./index";
import {
  GROUND_FRAGMENT,
  LANTERN_FRAGMENT,
  LANTERN_VERTEX,
  ROD_FRAGMENT,
  ROD_PATH,
  ROD_WIDTH,
} from "./shaders";

const DEG = 180 / Math.PI;
const defaults = (time: number): WindState => ({
  time,
  lean: look.params.lean.default,
  sway: look.params.sway.default,
  gustPeriod: gustPeriod(look.params.gust.default),
  heightScale: look.params.height.default,
});
const TIMES = Array.from({ length: 49 }, (_, i) => i * 2.5);

describe("grove layout", () => {
  it("plants the sketch's 20, 28 and 36 wands at the default count", () => {
    expect(rowCounts(84)).toEqual([20, 28, 36]);
    for (let n = look.params.count.min; n <= look.params.count.max; n++) {
      const counts = rowCounts(n);
      expect(
        counts.reduce((s, c) => s + c, 0),
        `${n}`,
      ).toBe(n);
      expect(Math.min(...counts), `${n}`).toBeGreaterThan(0);
    }
  });

  it("is seeded and stays on its rows", () => {
    expect(groveWands(84, 18)).toEqual(groveWands(84, 18));
    for (const w of groveWands(84, 18)) {
      const r = Math.hypot(w.x, w.z);
      expect(r).toBeCloseTo(18 + GROVE.rows[w.row].offset, 9);
      expect(Number.isInteger(w.cycles)).toBe(true);
      expect(w.cycles).toBeGreaterThanOrEqual(14);
      expect(w.cycles).toBeLessThanOrEqual(22);
    }
  });

  it("stands every wand 7 to 16 units tall", () => {
    const heights = groveWands(84, 18).map((w) => w.height);
    expect(Math.min(...heights)).toBeGreaterThan(6);
    expect(Math.max(...heights)).toBeLessThan(16);
  });
});

describe("wind", () => {
  it("loops exactly, gusts and sway included", () => {
    const wands = groveWands(84, 18);
    for (const every of [6, 7, 12, 23, 40]) {
      const a = { ...defaults(0), gustPeriod: gustPeriod(every) };
      const b = { ...a, time: GROVE.loop };
      expect(Number.isInteger(Math.round((GROVE.loop / a.gustPeriod) * 1e9) / 1e9)).toBe(true);
      for (const w of wands) {
        const [ax, az] = wandTip(w, a);
        const [bx, bz] = wandTip(w, b);
        expect(bx).toBeCloseTo(ax, 9);
        expect(bz).toBeCloseTo(az, 9);
      }
    }
  });

  it("veers 26 degrees either way of its mean", () => {
    const angles = TIMES.map((t) => Math.atan2(windDirection(t)[1], windDirection(t)[0]) * DEG);
    expect(Math.max(...angles) - GROVE.windMean * DEG).toBeCloseTo(GROVE.windVeer * DEG, 0);
    expect(GROVE.windVeer * DEG).toBeCloseTo(26, 0);
  });

  it("keeps every lantern at least 11 degrees up from the stage at the defaults", () => {
    for (const w of groveWands(84, 18)) {
      for (const t of TIMES) {
        const s = defaults(t);
        const [x, y, z] = wandPoint(w, wandTip(w, s), 1, s.heightScale);
        expect(Math.atan2(y, Math.hypot(x, z)) * DEG).toBeGreaterThan(11);
      }
    }
  });

  it("never bends a rod into the content volume", () => {
    for (const inner of [look.params.inner.min, 18]) {
      let closest = Number.POSITIVE_INFINITY;
      for (const w of groveWands(look.params.count.max, inner)) {
        for (const t of TIMES) {
          const s = {
            ...defaults(t),
            lean: look.params.lean.max,
            sway: look.params.sway.max,
            heightScale: look.params.height.max,
          };
          const tip = wandTip(w, s);
          for (let k = 0; k <= GROVE.segments; k++) {
            const [x, , z] = wandPoint(w, tip, k / GROVE.segments, s.heightScale);
            closest = Math.min(closest, Math.hypot(x, z));
          }
        }
      }
      expect(closest, `inner ${inner}`).toBeGreaterThan(inner * 0.6);
    }
  });

  it("matches the sketch's haze band at 10 degrees", () => {
    const [lo, hi] = hazeWindow(10);
    expect(lo).toBeCloseTo(0.087, 3);
    expect(hi).toBeCloseTo(0.287, 3);
  });
});

describe("wind wands def", () => {
  it("builds sound look materials", () => {
    expect(
      lookMaterialProblem({ key: "wind-wands/ground", fragmentShader: GROUND_FRAGMENT }),
    ).toBeNull();
    expect(
      lookMaterialProblem({
        key: "wind-wands/lanterns",
        vertexShader: LANTERN_VERTEX,
        fragmentShader: LANTERN_FRAGMENT,
      }),
    ).toBeNull();
    expect(
      lookMaterialProblem(
        inkRibbonMaterial({
          key: "wind-wands/rods",
          path: ROD_PATH,
          width: ROD_WIDTH,
          fragmentShader: ROD_FRAGMENT,
        }),
      ),
    ).toBeNull();
  });

  it("flags the Lantern slot as the one glow slot", () => {
    expect(look.colorSlots.map((s) => !!s.glow)).toEqual([false, true, false]);
  });

  it("carries a cheap dusk key from the downwind side on every preset", () => {
    expect(DOWNWIND_AZIMUTH_DEG).toBe(70);
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      if (!p.lighting) continue;
      expect(companionLightingProblem(p.lighting), p.id).toBeNull();
      expect(p.lighting.sun?.azimuthDeg, p.id).toBe(DOWNWIND_AZIMUTH_DEG);
      expect(p.lighting.sun?.elevationDeg, p.id).toBe(20);
    }
  });
});
