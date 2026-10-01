import { describe, expect, it } from "vitest";
import { LIGHT_RADIUS, sunPosition } from "../../../../engine/orbit";
import { normalizeLighting } from "../../../../engine/sceneLighting";
import { glslFloat } from "./glsl";
import {
  GOBO_PENUMBRA,
  goboCompanionSun,
  goboPenumbra,
  goboSunAzimuth,
  goboSunDirection,
  LOOK_GLSL_GOBO,
  traceGoboCylinder,
  traceGoboPlane,
  writeGoboSun,
} from "./gobo";

const radius = (p: readonly number[]) => Math.hypot(p[0], p[2]);

describe("gobo sun", () => {
  it("points where the v9 sun sits, so a companion sun lights from the same side", () => {
    for (const az of [-150, -60, 0, 45, 180, 210]) {
      for (const el of [5, 22, 60]) {
        const dir = goboSunDirection(az, el);
        const pos = sunPosition(az, el);
        for (let i = 0; i < 3; i++) expect(dir[i]).toBeCloseTo(pos[i] / LIGHT_RADIUS, 12);
      }
    }
    const behind = goboSunDirection(180, 22);
    expect(behind[2]).toBeLessThan(0);
    expect(behind[1]).toBeGreaterThan(0);
  });

  it("sways in closed form and loops exactly, negative-safe", () => {
    const path = { azimuthDeg: 180, elevationDeg: 22, swayDeg: 15, periodS: 80 };
    expect(goboSunAzimuth(path, 0)).toBe(180);
    expect(goboSunAzimuth(path, 20)).toBeCloseTo(195, 10);
    expect(goboSunAzimuth(path, 60)).toBeCloseTo(165, 10);
    expect(goboSunAzimuth(path, 20 + 80 * 40)).toBeCloseTo(195, 10);
    expect(goboSunAzimuth(path, -60)).toBeCloseTo(195, 10);
    expect(goboSunAzimuth({ azimuthDeg: 30, elevationDeg: 40 }, 17)).toBe(30);
  });

  it("writes the swayed direction into a vector without allocating one", () => {
    const path = { azimuthDeg: 180, elevationDeg: 22, swayDeg: 15, periodS: 80 };
    const out = {
      v: [0, 0, 0],
      set(x: number, y: number, z: number) {
        this.v = [x, y, z];
      },
    };
    writeGoboSun(out, path, 20);
    const want = goboSunDirection(195, 22);
    for (let i = 0; i < 3; i++) expect(out.v[i]).toBeCloseTo(want[i], 12);
  });

  it("builds a companion sun that normalizeLighting keeps verbatim", () => {
    const sun = goboCompanionSun(
      { azimuthDeg: 180, elevationDeg: 22, swayDeg: 15, periodS: 80 },
      { intensity: 2, kelvin: 3100, angularDeg: 2 },
    );
    expect(sun).toEqual({
      azimuthDeg: 180,
      elevationDeg: 22,
      intensity: 2,
      kelvin: 3100,
      angularDeg: 2,
    });
    const lighting = { sun, ambient: 0.4 };
    expect(normalizeLighting(lighting, "gobo")).toEqual(lighting);
  });
});

describe("gobo tracers", () => {
  it("leave a drum through its wall from anywhere inside it", () => {
    const sun = goboSunDirection(180, 22);
    const hit = traceGoboCylinder([0, -2, 0], sun, 15);
    expect(hit).not.toBeNull();
    expect(hit?.point[2]).toBeCloseTo(-15, 9);
    expect(hit?.point[1]).toBeCloseTo(-2 + 15 * Math.tan((22 * Math.PI) / 180), 9);
    for (const p of [
      [6, -2, 3],
      [-9, -2, -4],
      [2, 5, 11],
    ] as const) {
      const h = traceGoboCylinder(p, goboSunDirection(165, 30), 15);
      expect(h).not.toBeNull();
      expect(radius(h?.point ?? [0, 0, 0])).toBeCloseTo(15, 9);
      expect(h?.dist ?? -1).toBeGreaterThan(0);
    }
  });

  it("miss a drum when the sun is overhead", () => {
    expect(traceGoboCylinder([1, 0, 1], [0, 1, 0], 15)).toBeNull();
  });

  it("meet a plane ahead of the receiver, never behind or parallel", () => {
    const roof = traceGoboPlane([3, -2, 1], goboSunDirection(0, 60), [0, 16, 0], [0, 1, 0]);
    expect(roof?.point[1]).toBeCloseTo(16, 9);
    expect(roof?.dist).toBeCloseTo(18 / Math.sin(Math.PI / 3), 9);
    expect(traceGoboPlane([0, 20, 0], goboSunDirection(0, 60), [0, 16, 0], [0, 1, 0])).toBeNull();
    expect(traceGoboPlane([0, 0, 0], [1, 0, 0], [0, 16, 0], [0, 1, 0])).toBeNull();
  });

  it("widen the penumbra with distance from the occluder", () => {
    expect(goboPenumbra(0)).toBe(GOBO_PENUMBRA.min);
    expect(goboPenumbra(20)).toBeGreaterThan(goboPenumbra(5));
    expect(goboPenumbra(10, 0.02, 0.1)).toBeCloseTo(0.3, 12);
  });
});

describe("gobo GLSL", () => {
  it("is guarded, balanced and free of float hashes", () => {
    expect(LOOK_GLSL_GOBO).toContain("#ifndef KK_LOOK_GOBO");
    const opens = (LOOK_GLSL_GOBO.match(/^#if(n?def)?\b/gm) ?? []).length;
    const closes = (LOOK_GLSL_GOBO.match(/^#endif\b/gm) ?? []).length;
    expect(opens).toBe(closes);
    expect(/fract\s*\(\s*sin/.test(LOOK_GLSL_GOBO)).toBe(false);
    expect(LOOK_GLSL_GOBO.includes("gl_FragCoord")).toBe(false);
  });

  it("declares the public helpers and bakes the penumbra defaults", () => {
    for (const fn of [
      "goboPlane",
      "goboCylinder",
      "goboPenumbra",
      "goboReach",
      "goboClearing",
      "goboTurns",
      "goboTurnsWidth",
      "goboEdge",
    ]) {
      expect(new RegExp(`\\b${fn}\\s*\\(`).test(LOOK_GLSL_GOBO), fn).toBe(true);
    }
    expect(LOOK_GLSL_GOBO).toContain(
      `goboPenumbra(dist, ${glslFloat(GOBO_PENUMBRA.spread)}, ${glslFloat(GOBO_PENUMBRA.min)})`,
    );
  });
});
