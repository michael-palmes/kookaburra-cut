import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import { WHEEL_FRAGMENT, WHEEL_VERTEX } from "./shaders";
import {
  CLOCK_KIND,
  CLOCKWORK,
  type ClockWheel,
  type ClockworkParams,
  ceilingFrame,
  clockTeeth,
  clockworkLayout,
  discGap,
  LOOP_TEETH,
  toothRadius,
  wheelAngle,
} from "./train";

const BASE: ClockworkParams = { module: 0.3, ceiling: 4.8, frieze: 20, seed: 1 };
const VARIANTS: ClockworkParams[] = [
  BASE,
  { ...BASE, seed: 2 },
  { ...BASE, seed: 7 },
  { module: 0.2, ceiling: 4, frieze: 15, seed: 3 },
  { module: 0.45, ceiling: 7, frieze: 28, seed: 11 },
  ...presets.map((p) => ({
    module: p.params?.module ?? 0.3,
    ceiling: p.params?.ceiling ?? 4.8,
    frieze: p.params?.frieze ?? 20,
    seed: p.params?.seed ?? 1,
  })),
];
const SAMPLE_TEETH = [0, 0.37, 3.3, 17.9, 61.2, 119.6];

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Plane coordinates of a world point in a wheel's own (u, v) basis. */
const planar = (w: ClockWheel, p: number[]): [number, number] => {
  const d = sub(p, w.centre);
  return [dot(d, w.u), dot(d, w.v)];
};

/** How far a point sits inside the wheel's tooth outline (the shader's), negative outside. */
function depthInGear(w: ClockWheel, p: number[], teeth: number, module: number): number {
  const [x, y] = planar(w, p);
  const theta = Math.atan2(y, x) - wheelAngle(w, teeth);
  return toothRadius(theta, w.radius, w.teeth, module) - Math.hypot(x, y);
}

describe("clockworkLayout", () => {
  it("is a pure function of its params", () => {
    expect(clockworkLayout(BASE)).toEqual(clockworkLayout(BASE));
    expect(clockworkLayout({ ...BASE, seed: 2 })).not.toEqual(clockworkLayout(BASE));
  });

  it("orders the frieze first, then ceiling planes 0 to 3, with an end per prefix", () => {
    for (const p of VARIANTS) {
      const { wheels, ends } = clockworkLayout(p);
      expect(ends).toHaveLength(CLOCKWORK.maxPlanes + 1);
      expect(ends.at(-1)).toBe(wheels.length);
      wheels.forEach((w, i) => {
        const plane = ends.findIndex((e) => i < e) - 1;
        expect(w.plane, `wheel ${i}`).toBe(plane);
        expect(w.kind === CLOCK_KIND.frieze, `wheel ${i}`).toBe(plane === -1);
      });
      for (let k = 1; k < ends.length; k++) expect(ends[k]).toBeGreaterThan(ends[k - 1]);
    }
  });

  it("keeps the first planes unchanged however many are shown", () => {
    const full = clockworkLayout(BASE);
    for (let n = 1; n <= CLOCKWORK.maxPlanes; n++) {
      expect(full.wheels.slice(0, full.ends[n]).every((w) => w.plane < n)).toBe(true);
    }
  });

  it("fills every default ceiling plane and both frieze rows", () => {
    const { wheels } = clockworkLayout(BASE);
    for (let plane = 0; plane < 3; plane++) {
      const n = wheels.filter((w) => w.plane === plane && w.kind === CLOCK_KIND.wheel).length;
      expect(n, `plane ${plane}`).toBeGreaterThanOrEqual(8);
    }
    expect(wheels.filter((w) => w.kind === CLOCK_KIND.frieze).length).toBeGreaterThanOrEqual(14);
  });

  it("seats every meshing pair in one plane exactly a pitch radius apart", () => {
    for (const p of VARIANTS) {
      const { wheels, meshes } = clockworkLayout(p);
      expect(meshes.length).toBeGreaterThan(12);
      for (const [i, j] of meshes) {
        const a = wheels[i];
        const b = wheels[j];
        expect(dot(a.normal, b.normal)).toBeCloseTo(1, 9);
        const [x, y] = planar(a, b.centre);
        expect(Math.hypot(x, y)).toBeCloseTo(a.radius + b.radius, 6);
        expect(Math.sign(a.turns)).toBe(-Math.sign(b.turns));
        expect(Math.abs(a.turns * a.teeth)).toBeCloseTo(Math.abs(b.turns * b.teeth), 12);
      }
    }
  });

  it("never lets meshing teeth overlap (beyond a hundredth of a module where flanks touch), at any sampled time", () => {
    for (const p of VARIANTS) {
      const m = p.module;
      const { wheels, meshes } = clockworkLayout(p);
      for (const [i, j] of meshes) {
        const a = wheels[i];
        const b = wheels[j];
        const [bx, by] = planar(a, b.centre);
        const d = Math.hypot(bx, by);
        const dir = [bx / d, by / d];
        const pitch = (Math.PI * 2 * a.radius) / a.teeth;
        for (const teeth of SAMPLE_TEETH) {
          let hits = 0;
          for (let s = -1.5; s <= 1.5; s += 0.05) {
            for (let q = -2.4; q <= 2.4; q += 0.1) {
              const along = a.radius + q * m;
              const across = s * pitch;
              const u = dir[0] * along - dir[1] * across;
              const v = dir[1] * along + dir[0] * across;
              const world = [
                a.centre[0] + a.u[0] * u + a.v[0] * v,
                a.centre[1] + a.u[1] * u + a.v[1] * v,
                a.centre[2] + a.u[2] * u + a.v[2] * v,
              ];
              const overlap = Math.min(
                depthInGear(a, world, teeth, m),
                depthInGear(b, world, teeth, m),
              );
              if (overlap > 0.01 * m) hits++;
            }
          }
          expect(hits, `seed ${p.seed} pair ${i}-${j} at ${teeth} teeth`).toBe(0);
        }
      }
    }
  });

  it("keeps wheels of different trains apart in 3D", () => {
    for (const p of VARIANTS) {
      const m = p.module;
      const { wheels } = clockworkLayout(p);
      const disc = (w: ClockWheel) => ({
        centre: w.centre,
        normal: w.normal,
        radius: w.radius + m,
      });
      for (let i = 0; i < wheels.length; i++) {
        for (let j = 0; j < i; j++) {
          if (wheels[i].train === wheels[j].train) continue;
          expect(
            discGap(disc(wheels[i]), disc(wheels[j])),
            `seed ${p.seed} ${j}-${i}`,
          ).toBeGreaterThan(0.6 * m + 0.3 - 1e-9);
        }
      }
    }
  });

  it("keeps the ceiling overhead and the frieze hubs just under the floor line", () => {
    for (const p of VARIANTS) {
      for (const w of clockworkLayout(p).wheels) {
        const tip = w.radius + p.module;
        if (w.kind === CLOCK_KIND.frieze) {
          expect(w.centre[1]).toBeLessThan(CLOCKWORK.floorY);
          expect(w.centre[1]).toBeGreaterThan(CLOCKWORK.floorY - 1.1);
          continue;
        }
        const drop = tip * Math.sqrt(Math.max(0, 1 - w.normal[1] ** 2));
        expect(w.centre[1] - drop).toBeGreaterThanOrEqual(p.ceiling - CLOCKWORK.maxDrop - 0.05);
        expect(Math.hypot(w.centre[0], w.centre[2])).toBeLessThanOrEqual(CLOCKWORK.reach);
        expect(w.normal[1]).toBeLessThan(0);
      }
    }
  });

  it("tilts outer trains toward the stage and leaves the middle flat", () => {
    const inner = ceilingFrame([2, 2], 5);
    expect(inner.normal[1]).toBeCloseTo(-1, 9);
    const outer = ceilingFrame([0, -20], 5);
    expect(outer.normal[1]).toBeCloseTo(-Math.cos(CLOCKWORK.tilt), 9);
    expect(outer.normal[2]).toBeGreaterThan(0.5);
    expect(Math.hypot(...outer.normal)).toBeCloseTo(1, 9);
  });
});

describe("clock motion", () => {
  it("brings every wheel back to a whole turn at the loop", () => {
    for (const p of VARIANTS) {
      for (const w of clockworkLayout(p).wheels) {
        const turns = w.turns * LOOP_TEETH;
        expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-9);
      }
    }
  });

  it("passes half a tooth a second by default and wraps at the loop", () => {
    expect(clockTeeth(10, 0.5, 0)).toBeCloseTo(5, 12);
    expect(clockTeeth(240 + 10, 0.5, 0)).toBeCloseTo(5, 9);
    expect(clockTeeth(-2, 0.5, 0)).toBeCloseTo(LOOP_TEETH - 1, 9);
    expect(clockTeeth(5, 0, 0)).toBe(0);
  });

  it("locks between beats with the deadbeat tick and stays continuous", () => {
    expect(clockTeeth(2.2, 0.5, 1)).toBeCloseTo(1, 12);
    expect(clockTeeth(2.6, 0.5, 1)).toBeCloseTo(1, 12);
    let prev = clockTeeth(0, 0.5, 1);
    for (let t = 0.01; t < 20; t += 0.01) {
      const n = clockTeeth(t, 0.5, 1);
      expect(Math.abs(n - prev)).toBeLessThan(0.05);
      expect(n).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = n;
    }
  });
});

describe("skeleton clockwork def", () => {
  it("builds sound look materials", () => {
    expect(
      lookMaterialProblem({
        key: "skeleton-clockwork/wheels",
        vertexShader: WHEEL_VERTEX,
        fragmentShader: WHEEL_FRAGMENT,
      }),
    ).toBeNull();
  });

  it("shows smooth motion by default, the tick only as a param", () => {
    expect(look.params.tick.default).toBe(0);
    for (const p of presets) expect(p.params?.tick ?? 0, p.id).toBe(0);
  });
});
