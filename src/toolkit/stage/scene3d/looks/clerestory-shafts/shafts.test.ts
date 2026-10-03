import { type Euler, Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { createInstanceScratch } from "../../kit/instanced";
import { lookMaterialProblem } from "../../kit/material";
import { smoothstep } from "../../kit/math";
import { tinyHash } from "../../kit/tinyTextures";
import { clerestorySunAzimuth, look, presets } from "./index";
import { DUST_MEAN, FLOOR_FRAGMENT, SHAFT_FRAGMENT, SHAFT_VERTEX, SLOT_FRAGMENT } from "./shaders";
import {
  CLERESTORY,
  clerestoryLayout,
  DUST_NOISE,
  fallShift,
  shaftAzimuth,
  shaftBreath,
  shaftClearance,
  shaftDirection,
  shaftDrop,
  shaftPose,
  WISP_NOISE,
} from "./shafts";

function vnoise3(x: number, y: number, z: number): number {
  const [ix, iy, iz] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [ux, uy, uz] = [x - ix, y - iy, z - iz].map((f) => f * f * (3 - 2 * f));
  const h = (dx: number, dy: number, dz: number) => tinyHash(ix + dx, iy + dy, iz + dz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (dz: number) =>
    lerp(lerp(h(0, 0, dz), h(1, 0, dz), ux), lerp(h(0, 1, dz), h(1, 1, dz), ux), uy);
  return lerp(plane(0), plane(1), uz);
}

describe("clerestory shafts layout", () => {
  it("is seeded and capped at the mounted capacity", () => {
    expect(clerestoryLayout(8, 28, 8)).toEqual(clerestoryLayout(8, 28, 8));
    expect(clerestoryLayout(99, 28, 8)).toHaveLength(CLERESTORY.maxShafts);
    expect(look.params.shaftCount.max).toBe(CLERESTORY.maxShafts);
  });

  it("keeps every shaft and pool clear of the content volume through the sweep, at every preset and slider extreme", () => {
    const cases = presets.map((p) => [p.params?.shaftCount, p.params?.tilt, p.params?.sweep]);
    for (const n of [3, 12])
      for (const tilt of [10, 40]) for (const sweep of [0, 15]) cases.push([n, tilt, sweep]);
    for (const [n = 8, tilt = 28, sweep = 8] of cases) {
      for (const s of clerestoryLayout(n, tilt, sweep)) {
        expect(shaftClearance(s, tilt, sweep), `${n} ${tilt} ${sweep}`).toBeGreaterThanOrEqual(
          CLERESTORY.clearance,
        );
      }
    }
  });

  it("orders the box columns for a positive determinant, so BackSide still culls the near faces", () => {
    const scratch = createInstanceScratch();
    const m = new Matrix4();
    for (const s of clerestoryLayout(12, 40, 15)) {
      shaftPose(s, 0, scratch.pose);
      const q = new Quaternion().setFromEuler(scratch.pose.rotation as Euler);
      m.compose(scratch.pose.position, q, scratch.pose.scale);
      expect(m.determinant()).toBeGreaterThan(0);
      const across = new Vector3().setFromMatrixColumn(m, 0);
      const along = new Vector3().setFromMatrixColumn(m, 2);
      expect(across.length()).toBeCloseTo(s.width);
      expect(along.length()).toBeCloseTo(s.length);
      for (const az of [shaftAzimuth(10, 15), shaftAzimuth(30, 15)]) {
        const d = shaftDirection(40, az);
        const up = new Vector3(d[0], d[1], d[2]).multiplyScalar(-shaftDrop(s) / -d[1]);
        expect(new Matrix4().makeBasis(across, up, along).determinant()).toBeGreaterThan(0);
      }
    }
  });
});

describe("clerestory shafts motion", () => {
  it("loops the sweep and the dust at 40 s and the breath at 20 s", () => {
    const [s] = clerestoryLayout(8, 28, 8);
    for (const t of [3.3, 17.9, 1234.5]) {
      expect(shaftAzimuth(t + 40, 8)).toBeCloseTo(shaftAzimuth(t, 8), 9);
      expect(shaftBreath(s, t + 20)).toBeCloseTo(shaftBreath(s, t), 9);
      for (const noise of [DUST_NOISE, WISP_NOISE]) {
        expect(noise.period / (noise.cells * CLERESTORY.dustSpeed)).toBeCloseTo(
          CLERESTORY.sweepPeriod,
          9,
        );
        const a = fallShift(t, noise);
        const b = fallShift(t + CLERESTORY.sweepPeriod, noise);
        expect(Math.min(Math.abs(a - b), noise.period - Math.abs(a - b))).toBeLessThan(1e-6);
      }
    }
  });

  it("breathes between 60 and 100%", () => {
    for (const s of clerestoryLayout(12, 28, 8)) {
      for (let t = 0; t < 20; t += 0.5) {
        const b = shaftBreath(s, t);
        expect(b).toBeGreaterThanOrEqual(0.6 - 1e-9);
        expect(b).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("settles guarded dust to the thresholded noise's own mean", () => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 40; i++)
      for (let j = 0; j < 40; j++)
        for (let k = 0; k < 10; k++) {
          sum += smoothstep(0.68, 0.86, vnoise3(i * 0.37 + 0.11, j * 0.41 + 0.07, k * 0.53 + 0.29));
          n++;
        }
    expect(Math.abs(sum / n - DUST_MEAN)).toBeLessThan(0.01);
  });
});

describe("clerestory shafts presets", () => {
  it("light devices from up the shafts, at each preset's own sun lean", () => {
    for (const p of presets) {
      expect(p.lighting, p.id).toBeDefined();
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(clerestorySunAzimuth());
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(90 - (p.params?.tilt ?? 0));
    }
    const d = shaftDirection(28, CLERESTORY.azimuthDeg);
    const az = (clerestorySunAzimuth() * Math.PI) / 180;
    expect(Math.sin(az)).toBeCloseTo(-d[0] / Math.hypot(d[0], d[2]));
    expect(Math.cos(az)).toBeCloseTo(-d[2] / Math.hypot(d[0], d[2]));
  });

  it("builds sound look materials", () => {
    const specs: [string, string, string?][] = [
      ["shaft", SHAFT_FRAGMENT, SHAFT_VERTEX],
      ["slot", SLOT_FRAGMENT],
      ["floor", FLOOR_FRAGMENT],
    ];
    for (const [part, fragmentShader, vertexShader] of specs) {
      expect(
        lookMaterialProblem({ key: `clerestory-shafts/${part}`, fragmentShader, vertexShader }),
        part,
      ).toBeNull();
    }
  });
});
