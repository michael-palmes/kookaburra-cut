import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { goboSunDirection } from "../../kit/gobo";
import { inkRibbonMaterial } from "../../kit/inkRibbon";
import { lookMaterialProblem } from "../../kit/material";
import { KITE_CAPACITY, kiteGeometry, kitesLightness } from "./BoxKites";
import { look, presets } from "./index";
import {
  createKiteScratch,
  createLineFrame,
  KITE_SUN,
  KITES,
  kiteLines,
  kiteList,
  linePoint,
  poseKite,
  trainCount,
  trainU,
  windVeer,
} from "./kites";
import {
  KITE_FRAGMENT,
  KITE_VERTEX,
  LAKE_FRAGMENT,
  LAMP_FRAGMENT,
  LAMP_VERTEX,
  LINE_FRAGMENT,
  LINE_PATH,
  LINE_VERTEX_HOOK,
} from "./shaders";

const DEG = Math.PI / 180;
const defaults = () => kiteLines(8, 3, 1, 3);
const elevation = (p: readonly number[]) => Math.atan2(p[1], Math.hypot(p[0], p[2])) / DEG;

describe("box-kites layout", () => {
  it("rings the sky with eight lines by default, five of them carrying trains of two or three", () => {
    const lines = defaults();
    expect(lines).toHaveLength(8);
    const trains = lines.filter((l) => l.count > 1);
    expect(trains).toHaveLength(5);
    for (const l of trains) expect([2, 3]).toContain(l.count);
    expect(kiteLines(99, 3, 1, 3)).toHaveLength(KITES.maxLines);
  });

  it("keeps singles single at every train length and caps trains at four", () => {
    for (let train = 1; train <= 4; train++) expect(trainCount(1, train)).toBe(1);
    expect(trainCount(3, 3)).toBe(3);
    expect(trainCount(3, 4)).toBe(4);
    expect(trainCount(2, 1)).toBe(1);
  });

  it("keeps every train at least 25 degrees off the wind axis, so none is seen end-on from the stage", () => {
    const windAz = Math.atan2(KITES.wind[0], -KITES.wind[2]) / DEG;
    for (const l of kiteLines(KITES.maxLines, 4, 1, 3)) {
      if (l.count < 2) continue;
      const az = Math.atan2(l.head[0], -l.head[2]) / DEG;
      const off = Math.abs(((az - windAz + 540) % 180) - 90);
      expect(90 - off).toBeGreaterThanOrEqual(25);
    }
  });

  it("sizes the instance capacity for the densest sliders", () => {
    const full = kiteList(kiteLines(KITES.maxLines, KITES.maxTrain, 1, 3));
    expect(KITE_CAPACITY[0] + KITE_CAPACITY[1]).toBe(full.length);
    for (const v of [0, 1] as const) {
      expect(kiteGeometry(v).getAttribute("aSwap").count).toBe(KITE_CAPACITY[v]);
    }
  });

  it("anchors each line on the lake upwind of its head, and rides the last kite at least halfway up", () => {
    for (const l of kiteLines(KITES.maxLines, 4, 1, 3)) {
      expect(l.anchor[1]).toBe(KITES.floorY);
      const toHead = [l.head[0] - l.anchor[0], l.head[2] - l.anchor[2]];
      expect(toHead[0] * KITES.wind[0] + toHead[1] * KITES.wind[2]).toBeGreaterThan(0);
      expect(trainU(l, l.count - 1)).toBeGreaterThanOrEqual(KITES.trainReach - 1e-9);
    }
  });
});

describe("box-kites motion", () => {
  it("loops exactly at 120 s", () => {
    const [line] = defaults();
    const frame = createLineFrame();
    for (const t of [0, 13.25, 77.5]) {
      for (const u of [0.3, 0.83, 1]) {
        const a = linePoint(line, u, t, windVeer(t, 13), 1, frame, [0, 0, 0]);
        const b = linePoint(
          line,
          u,
          t + KITES.period,
          windVeer(t + KITES.period, 13),
          1,
          frame,
          [0, 0, 0],
        );
        for (let c = 0; c < 3; c++) expect(b[c]).toBeCloseTo(a[c], 6);
      }
    }
    expect(windVeer(0, 13)).toBeCloseTo(13 * DEG * Math.sin(0.4), 12);
  });

  it("pins each line to its anchor and moves the head within a few seconds", () => {
    const frame = createLineFrame();
    for (const line of defaults()) {
      const foot = linePoint(line, 0, 21, windVeer(21, 13), 1, frame, [0, 0, 0]);
      for (let c = 0; c < 3; c++) expect(foot[c]).toBeCloseTo(line.anchor[c], 9);
      const a = linePoint(line, 1, 10, windVeer(10, 13), 1, frame, [0, 0, 0]);
      const b = linePoint(line, 1, 13, windVeer(13, 13), 1, frame, [0, 0, 0]);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.5);
    }
  });

  it("poses each kite as a span-scaled orthogonal frame riding above its line, nose upwind, lamp under the front cell", () => {
    const lines = defaults();
    const scratch = createKiteScratch();
    const m = new Float32Array(16);
    const lamp: [number, number, number] = [0, 0, 0];
    for (const kite of kiteList(lines)) {
      const line = lines[kite.line];
      poseKite(line, kite, 42, 13, 1, scratch, m, lamp);
      const axes = [0, 4, 8].map((o) => [m[o], m[o + 1], m[o + 2]]);
      for (const a of axes) expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(kite.span, 4);
      const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
      expect(dot(axes[0], axes[1])).toBeCloseTo(0, 3);
      expect(dot(axes[1], axes[2])).toBeCloseTo(0, 3);
      expect(dot(axes[2], KITES.wind)).toBeLessThan(0);
      const at = linePoint(
        line,
        trainU(line, kite.j),
        42,
        windVeer(42, 13),
        1,
        createLineFrame(),
        [0, 0, 0],
      );
      const lift = Math.hypot(m[12] - at[0], m[13] - at[1], m[14] - at[2]);
      expect(lift).toBeCloseTo(0.3 * kite.span, 4);
      expect(lamp[1]).toBeLessThan(m[13]);
    }
  });

  it("lights lamps only from 9 degrees up, and every default head lamp stays lit all loop", () => {
    expect(KITES.lampFade[1]).toBe(9);
    const lines = defaults();
    const scratch = createKiteScratch();
    const m = new Float32Array(16);
    const lamp: [number, number, number] = [0, 0, 0];
    for (let t = 0; t < KITES.period; t += 2.5) {
      for (const kite of kiteList(lines)) {
        if (kite.j > 0) continue;
        poseKite(lines[kite.line], kite, t, 13, 1, scratch, m, lamp);
        expect(elevation(lamp)).toBeGreaterThan(KITES.lampFade[1]);
      }
    }
  });
});

describe("box-kites look", () => {
  it("compiles every part as a sound look material", () => {
    const specs = [
      { key: "box-kites/kite", vertexShader: KITE_VERTEX, fragmentShader: KITE_FRAGMENT },
      { key: "box-kites/lamp", vertexShader: LAMP_VERTEX, fragmentShader: LAMP_FRAGMENT },
      { key: "box-kites/lake", fragmentShader: LAKE_FRAGMENT },
      inkRibbonMaterial({
        key: "box-kites/line",
        path: LINE_PATH,
        vertex: LINE_VERTEX_HOOK,
        fragmentShader: LINE_FRAGMENT,
      }),
    ];
    for (const spec of specs) expect(lookMaterialProblem(spec), spec.key).toBeNull();
  });

  it("eases between dark and light backings", () => {
    expect(kitesLightness(0.005)).toBe(0);
    expect(kitesLightness(0.88)).toBe(1);
    expect(kitesLightness(0.2)).toBeGreaterThan(0);
    expect(kitesLightness(0.2)).toBeLessThan(1);
  });

  it("carries a valid companion sun on the bearing of the shading sun", () => {
    const sun = goboSunDirection(KITE_SUN.azimuthDeg, KITE_SUN.elevationDeg);
    expect(sun[1]).toBeCloseTo(Math.sin(55 * DEG), 9);
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      if (!p.lighting) continue;
      expect(companionLightingProblem(p.lighting), p.id).toBeNull();
      expect(p.lighting.sun?.azimuthDeg).toBe(KITE_SUN.azimuthDeg);
      expect(p.lighting.sun?.elevationDeg).toBe(KITE_SUN.elevationDeg);
      expect(Object.keys(p.params ?? {}).sort(), p.id).toEqual(Object.keys(look.params).sort());
    }
  });
});
