import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { DISH_FLOOR_VERTEX_SHADER } from "../../kit/dish";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import {
  SAND,
  SAND_SEGMENTS,
  sandBallTime,
  sandCut,
  sandPath,
  sandRose,
  sandSunAzimuth,
  writeSandSun,
} from "./rose";
import {
  BALL_FRAGMENT,
  BALL_VERTEX,
  FLOOR_FRAGMENT,
  RIBBON_FRAGMENT,
  RIBBON_VERTEX,
} from "./shaders";

const p = look.params;
const DEFAULT = sandRose(p.clearRadius.default, p.reach.default, p.petals.default);
const TAU = Math.PI * 2;

describe("sand-table", () => {
  it("closes the rose every loop and keeps it between the clearing and the reach", () => {
    for (const s of [0, 37.5, 911]) {
      const [x0, z0] = sandPath(s, DEFAULT);
      const [x1, z1] = sandPath(s + SAND.loop, DEFAULT);
      expect(x1).toBeCloseTo(x0, 9);
      expect(z1).toBeCloseTo(z0, 9);
    }
    for (let s = 0; s < SAND.loop; s += 3.7) {
      const r = Math.hypot(...sandPath(s, DEFAULT));
      expect(r).toBeGreaterThanOrEqual(DEFAULT.clear - 1e-9);
      expect(r).toBeLessThanOrEqual(DEFAULT.reach + 1e-9);
    }
  });

  it("drives the ball at about 1 unit a second", () => {
    let length = 0;
    let prev = sandPath(0, DEFAULT);
    for (let s = 0.1; s <= SAND.loop; s += 0.1) {
      const next = sandPath(s, DEFAULT);
      length += Math.hypot(next[0] - prev[0], next[1] - prev[1]);
      prev = next;
    }
    const speed = length / SAND.loop;
    expect(speed).toBeGreaterThan(0.75);
    expect(speed).toBeLessThan(1.25);
  });

  it("keeps the default groove band from folding where the rose turns tightest", () => {
    const h = 0.05;
    let tightest = Infinity;
    for (let s = h; s < SAND.loop; s += 0.4) {
      const [ax, az] = sandPath(s - h, DEFAULT);
      const [bx, bz] = sandPath(s, DEFAULT);
      const [cx, cz] = sandPath(s + h, DEFAULT);
      const a = Math.hypot(bx - ax, bz - az);
      const b = Math.hypot(cx - bx, cz - bz);
      const c = Math.hypot(cx - ax, cz - az);
      const area = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
      if (area > 1e-12) tightest = Math.min(tightest, (a * b * c) / (4 * area));
    }
    expect(tightest).toBeGreaterThan(SAND.halfWidth);
  });

  it("splits the ribbon at the ball so the newest groove draws last", () => {
    expect(sandCut(0)).toBe(1);
    expect(sandCut(SAND.loop - 1e-6)).toBe(SAND_SEGMENTS);
    for (const t of [0, 5, 1737.9]) {
      const tm = sandBallTime(t);
      const cut = sandCut(tm);
      expect((cut - 1) * SAND.pathStep).toBeLessThanOrEqual(tm);
      expect(cut * SAND.pathStep).toBeGreaterThan(tm);
    }
    expect(sandBallTime(SAND.loop - SAND.startOffset)).toBeCloseTo(0, 9);
  });

  it("swings the sun the slider's angle each way and closes with the loop", () => {
    const swing = p.sunSwing.default;
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 40; t += 0.05) {
      const d = sandSunAzimuth(t, swing) - SAND.sunAzimuth - (TAU * t) / SAND.loop;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    expect((hi * 180) / Math.PI).toBeCloseTo(swing, 1);
    expect((lo * 180) / Math.PI).toBeCloseTo(-swing, 1);
    const a = new Vector3();
    const b = new Vector3();
    writeSandSun(a, 12.5, swing, p.sunHeight.default);
    writeSandSun(b, 12.5 + SAND.loop, swing, p.sunHeight.default);
    expect(a.length()).toBeCloseTo(1, 12);
    expect(b.distanceTo(a)).toBeLessThan(1e-9);
  });

  it("whole-numbers the petal count and keeps the reach outside the clearing", () => {
    expect(sandRose(7.5, 29, 24.6).petals).toBe(25);
    expect(sandRose(14, 12, 25).reach).toBeGreaterThan(14);
  });

  it("builds sound look materials", () => {
    const specs = [
      {
        key: "sand-table/floor",
        vertexShader: DISH_FLOOR_VERTEX_SHADER,
        fragmentShader: FLOOR_FRAGMENT,
      },
      { key: "sand-table/grooves", vertexShader: RIBBON_VERTEX, fragmentShader: RIBBON_FRAGMENT },
      { key: "sand-table/ball", vertexShader: BALL_VERTEX, fragmentShader: BALL_FRAGMENT },
    ];
    for (const spec of specs) expect(lookMaterialProblem(spec), spec.key).toBeNull();
  });

  it("gives every preset a cheap companion rig", () => {
    for (const preset of presets) {
      expect(preset.lighting, preset.id).toBeDefined();
      if (preset.lighting) expect(companionLightingProblem(preset.lighting), preset.id).toBeNull();
    }
  });
});
