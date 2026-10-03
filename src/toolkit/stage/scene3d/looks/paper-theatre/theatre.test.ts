import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { inkRibbonMaterial } from "../../kit/inkRibbon";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import {
  CLOUD_FRAGMENT,
  CLOUD_VERTEX,
  FLAT_FRAGMENT,
  FLAT_VERTEX,
  FLOOR_FRAGMENT,
  SUN_FRAGMENT,
  SUN_VERTEX,
  WIRE_FRAGMENT,
  WIRE_PATH,
} from "./shaders";
import {
  THEATRE_CLOUDS,
  THEATRE_MAX_RINGS,
  THEATRE_RINGS,
  THEATRE_SUN,
  theatreCasters,
  theatreCloudTurn,
  theatreLayout,
  theatreStepTime,
  theatreSunAzimuth,
  theatreSunElevationDeg,
  theatreSunTurn,
  theatreVisibleRings,
  theatreWires,
} from "./theatre";

const DEG = Math.PI / 180;

describe("paper-theatre", () => {
  it("keeps the near hills and tall ranges at every Rings value, near to far", () => {
    expect(theatreVisibleRings(2)).toEqual([0, 3]);
    expect(theatreVisibleRings(3)).toEqual([0, 1, 3]);
    expect(theatreVisibleRings(4)).toEqual([0, 1, 2, 3]);
    expect(theatreVisibleRings(5)).toEqual([0, 1, 2, 3, 4]);
    expect(theatreVisibleRings(9)).toHaveLength(THEATRE_MAX_RINGS);
    expect(theatreCasters([0, 3], [] as number[])).toEqual([-1, 0, 0, 0, 3]);
    for (const [k, r] of THEATRE_RINGS.entries()) {
      if (k > 0) expect(r.radius, `ring ${k}`).toBeGreaterThan(THEATRE_RINGS[k - 1].radius);
    }
  });

  it("stands every flat outside the content volume, facing the stage, from one seeded layout", () => {
    const a = theatreLayout();
    const b = theatreLayout();
    expect(a.flats.pivot).toEqual(b.flats.pivot);
    const quads = THEATRE_RINGS.reduce((n, r) => n + r.wings, 0);
    expect(a.flats.position).toHaveLength(quads * 12);
    expect(Math.max(...a.flats.index)).toBe(quads * 4 - 1);
    const p = a.flats.position;
    for (let v = 0; v < quads * 4; v++) {
      expect(Math.hypot(p[v * 3], p[v * 3 + 2])).toBeGreaterThan(11);
    }
    expect(a.clouds).toHaveLength(THEATRE_CLOUDS.count);
    for (const c of a.clouds) expect(c.y).toBeGreaterThan(4);
    const cycles = a.flats.info.filter((_, i) => i % 4 === 3);
    for (const n of cycles) expect(Number.isInteger(n) && n >= 16 && n <= 30).toBe(true);
  });

  it("hangs two wires per cloud and one brass wire for the disc", () => {
    const wires = theatreWires(theatreLayout().clouds);
    expect(wires).toHaveLength(THEATRE_CLOUDS.count * 2 + 1);
    expect(wires.filter((w) => w[6] === 1)).toHaveLength(1);
  });

  it("holds stop-motion steps and loops the clouds and sun exactly", () => {
    expect(theatreStepTime(1.234, 0)).toBe(1.234);
    expect(theatreStepTime(1.234, 8)).toBe(1.125);
    expect(theatreCloudTurn(3, 1)).toBeCloseTo(theatreCloudTurn(3 + THEATRE_CLOUDS.lapS, 1), 9);
    expect(theatreSunAzimuth(10)).toBeCloseTo(theatreSunAzimuth(10 + THEATRE_SUN.periodS), 9);
    expect(Math.abs(theatreCloudTurn(4, 1)) / DEG).toBeGreaterThan(2.5);
  });

  it("turns the disc to its bearing and keeps it beside the default headline", () => {
    for (const az of [THEATRE_SUN.azimuthDeg - THEATRE_SUN.swayDeg, THEATRE_SUN.azimuthDeg]) {
      const a = theatreSunTurn(az);
      // three's rotation.y carries (0, 0, -1) to (-sin a, 0, -cos a).
      expect(-Math.sin(a)).toBeCloseTo(Math.sin(az * DEG), 9);
      expect(-Math.cos(a)).toBeCloseTo(Math.cos(az * DEG), 9);
      const x = THEATRE_SUN.distance * Math.sin(az * DEG);
      const z = THEATRE_SUN.distance * Math.cos(az * DEG);
      const scale = 5 / (5 - z);
      // The disc's right edge at stage depth from the default camera clears a 5.2 wide headline.
      expect(x * scale + THEATRE_SUN.size * scale, `${az}`).toBeLessThan(-2.6);
    }
  });

  it("lights devices from the disc's bearing with a cheap rig", () => {
    for (const p of presets) {
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(THEATRE_SUN.azimuthDeg);
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(theatreSunElevationDeg());
    }
  });

  it("gives every preset whole ring and stop-motion counts", () => {
    for (const p of presets) {
      expect(Number.isInteger(p.params?.rings), p.id).toBe(true);
      expect(Number.isInteger(p.params?.stopMotion), p.id).toBe(true);
    }
    expect(look.params.rings.step).toBe(1);
  });

  it("builds sound look materials", () => {
    const parts: [string, string, string?][] = [
      ["flats", FLAT_FRAGMENT, FLAT_VERTEX],
      ["clouds", CLOUD_FRAGMENT, CLOUD_VERTEX],
      ["sun", SUN_FRAGMENT, SUN_VERTEX],
      ["floor", FLOOR_FRAGMENT],
    ];
    for (const [part, fragmentShader, vertexShader] of parts) {
      expect(
        lookMaterialProblem({ key: `paper-theatre/${part}`, fragmentShader, vertexShader }),
        part,
      ).toBeNull();
    }
    const wires = inkRibbonMaterial({
      key: "paper-theatre/wires",
      path: WIRE_PATH,
      fragmentShader: WIRE_FRAGMENT,
    });
    expect(lookMaterialProblem(wires)).toBeNull();
  });
});
