import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { goboSunDirection } from "../../kit/gobo";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import {
  SUNROOM_DAY_S,
  SUNROOM_FLOOR_Y,
  SUNROOM_THROW,
  sunroomRoom,
  sunroomSlats,
  sunroomSunAngles,
  sunroomWindow,
  traceSunroomWindow,
} from "./room";
import { FLOOR_FRAGMENT, WALL_FRAGMENT } from "./shaders";

const p = look.params;
const corners = [p.sunSide.min, p.sunSide.max].flatMap((sunSide) =>
  [p.sunHeight.min, p.sunHeight.max].flatMap((sunHeight) =>
    [p.wallDistance.min, p.wallDistance.max].flatMap((wallDistance) =>
      [p.patch.min, p.patch.max].map((patch) => ({ sunSide, sunHeight, wallDistance, patch })),
    ),
  ),
);
const cases = [...corners, ...presets.map((preset) => preset.params as (typeof corners)[number])];
const windowFor = (c: (typeof corners)[number]) =>
  sunroomWindow({
    sunAzimuthDeg: c.sunSide,
    sunElevationDeg: c.sunHeight,
    wallDistance: c.wallDistance,
    patch: c.patch,
  });

describe("sunroom", () => {
  it("lights devices from the blind's side at each preset's sun", () => {
    for (const preset of presets) {
      expect(preset.lighting?.sun?.azimuthDeg, preset.id).toBe(preset.params?.sunSide);
      expect(preset.lighting?.sun?.elevationDeg, preset.id).toBe(preset.params?.sunHeight);
      expect(companionLightingProblem(preset.lighting ?? {}), preset.id).toBeNull();
    }
  });

  it("builds sound look materials", () => {
    for (const [part, fragmentShader] of [
      ["wall", WALL_FRAGMENT],
      ["floor", FLOOR_FRAGMENT],
    ]) {
      expect(lookMaterialProblem({ key: `sunroom/${part}`, fragmentShader }), part).toBeNull();
    }
  });

  it("swings the sun round its mean and loops exactly each day", () => {
    const path = { azimuthDeg: -40, elevationDeg: 26, driftDeg: 3, periodS: SUNROOM_DAY_S };
    expect(sunroomSunAngles(path, 0)).toEqual([-40, 26]);
    expect(sunroomSunAngles(path, 37)).toEqual(sunroomSunAngles(path, 37 + 5 * SUNROOM_DAY_S));
    const [az, el] = sunroomSunAngles(path, SUNROOM_DAY_S / 4);
    expect(az).toBeCloseTo(-37, 9);
    expect(el).toBeLessThan(26);
    expect(sunroomSunAngles({ ...path, driftDeg: 0 }, 50)).toEqual([-40, 26]);
  });

  it("keeps the back wall behind the content volume and the side walls out of the default frame", () => {
    for (let d = p.wallDistance.min; d <= p.wallDistance.max; d += 0.5) {
      const room = sunroomRoom(d);
      expect(room.wallZ).toBeGreaterThan(6);
      expect(room.sideX).toBeGreaterThan(Math.tan((22.5 * Math.PI) / 180) * (16 / 9) * (d + 5));
    }
  });

  it("centres the patch on the wall where the mean sun lands the blind's centre", () => {
    for (const c of cases) {
      const w = windowFor(c);
      const sun = goboSunDirection(c.sunSide, c.sunHeight);
      const anchor: [number, number, number] = [
        w.centre[0] - SUNROOM_THROW * sun[0],
        w.centre[1] - SUNROOM_THROW * sun[1],
        w.centre[2] - SUNROOM_THROW * sun[2],
      ];
      expect(anchor[2]).toBeCloseTo(-sunroomRoom(c.wallDistance).wallZ, 9);
      const hit = traceSunroomWindow(anchor, sun, w);
      expect(hit?.u ?? Number.NaN).toBeCloseTo(0, 6);
      expect(hit?.v ?? Number.NaN).toBeCloseTo(0, 6);
      expect(hit?.dist ?? Number.NaN).toBeCloseTo(SUNROOM_THROW, 6);
    }
  });

  it("faces the blind into the sun and never cuts its light where the floor crosses its plane", () => {
    for (const c of cases) {
      const w = windowFor(c);
      const sun = goboSunDirection(c.sunSide, c.sunHeight);
      const dot = (a: readonly number[], b: readonly number[]) =>
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      expect(dot(sun, w.normal), JSON.stringify(c)).toBeGreaterThan(0.3);
      expect(w.centre[1] - w.halfHeight, JSON.stringify(c)).toBeGreaterThan(SUNROOM_FLOOR_Y);
      const { wallZ } = sunroomRoom(c.wallDistance);
      for (let x = -40; x <= 40; x += 2) {
        for (let z = -wallZ; z <= 40; z += 2) {
          const q = [x - w.centre[0], SUNROOM_FLOOR_Y - w.centre[1], z - w.centre[2]];
          const s = -dot(q, w.normal) / dot(sun, w.normal);
          const hit = [q[0] + s * sun[0], q[1] + s * sun[1], q[2] + s * sun[2]];
          const inside = Math.abs(dot(hit, w.u)) <= w.halfWidth && Math.abs(hit[1]) <= w.halfHeight;
          if (inside) expect(s, `${JSON.stringify(c)} ${x} ${z}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("filters slats to their exact open share and holds crisp gaps at pixel width", () => {
    for (const g of [0.3, 0.6, 0.85]) {
      for (const x of [0, 0.13, 0.5, 0.77, 3.4]) {
        expect(sunroomSlats(x, 4, g), `${g} ${x}`).toBeCloseTo(g, 6);
      }
      expect(sunroomSlats(0.5, 0.01, g)).toBeCloseTo(1, 6);
      expect(sunroomSlats(0, 0.01, g)).toBeCloseTo(0, 6);
    }
  });
});
