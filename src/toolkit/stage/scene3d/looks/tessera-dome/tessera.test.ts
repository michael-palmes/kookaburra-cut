import { Euler, Matrix4, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { look } from "./index";
import {
  TESSERA,
  TESSERA_CAPACITY,
  TESSERA_LIGHT_WEIGHTS,
  tesseraLights,
  tesseraShape,
  tesseraSpring,
  tesseraTileCount,
  tesseraTiles,
} from "./tessera";

const DEFAULTS = { rimRadius: 35, rise: 24, tileSize: 0.8, tilt: 6 };

describe("tessera dome layout", () => {
  it("springs the cap from y 4 at the rim radius and peaks `rise` above it", () => {
    const s = tesseraShape(35, 24);
    expect(Math.sin(s.phiMax) * s.radius).toBeCloseTo(35, 9);
    expect(s.centreY + Math.cos(s.phiMax) * s.radius).toBeCloseTo(TESSERA.springY, 9);
    expect(s.centreY + s.radius).toBeCloseTo(TESSERA.springY + 24, 9);
  });

  it("lays about 8.7k tiles at the defaults, the same every time", () => {
    const a = tesseraTiles(DEFAULTS);
    const b = tesseraTiles(DEFAULTS);
    expect(a).toEqual(b);
    expect(a.length).toBe(tesseraTileCount(DEFAULTS));
    expect(a.length).toBeGreaterThan(8000);
    expect(a.length).toBeLessThan(9500);
  });

  it("fits the densest slider corner inside the instance capacity", () => {
    const { rimRadius, rise, tileSize } = look.params;
    for (const r of [rimRadius.min, rimRadius.default, rimRadius.max])
      for (const h of [rise.min, rise.default, rise.max])
        for (const s of [tileSize.min, tileSize.max])
          expect(tesseraTileCount({ rimRadius: r, rise: h, tileSize: s })).toBeLessThanOrEqual(
            TESSERA_CAPACITY,
          );
  });

  it("keeps every tile on the dome, above the springing line and facing the centre within its tilt", () => {
    const tiles = tesseraTiles({ ...DEFAULTS, tilt: 12 });
    const { radius, centreY } = tesseraShape(35, 24);
    const m = new Matrix4();
    const z = new Vector3();
    const inward = new Vector3();
    for (const t of tiles) {
      expect(Math.hypot(t.x, t.y - centreY, t.z)).toBeCloseTo(radius, 6);
      expect(t.y).toBeGreaterThanOrEqual(TESSERA.springY);
      m.makeRotationFromEuler(new Euler(t.rx, t.ry, t.rz));
      z.set(0, 0, 1).applyMatrix4(m);
      inward.set(-t.x, centreY - t.y, -t.z).normalize();
      expect(z.dot(inward)).toBeGreaterThan(Math.cos(((12 * Math.SQRT2 + 6) * Math.PI) / 180));
      expect(t.sx).toBeGreaterThan(0);
      expect(t.sy).toBeGreaterThan(0);
    }
  });

  it("sets a medallion at the apex, dark rings and ribs, and gold between", () => {
    const tiles = tesseraTiles(DEFAULTS);
    expect(tiles[0].kind).toBe(2);
    const kinds = [0, 1, 2].map((k) => tiles.filter((t) => t.kind === k).length);
    expect(kinds[0]).toBeGreaterThan(kinds[1]);
    expect(kinds[1]).toBeGreaterThan(kinds[2]);
    expect(kinds[2]).toBeGreaterThan(0);
  });
});

describe("tessera dome glint and fade", () => {
  const lights = () => TESSERA_LIGHT_WEIGHTS.map(() => new Vector3());

  it("circles the drum-window lights below the horizon, evenly spaced, looping exactly", () => {
    const a = lights();
    const b = lights();
    tesseraLights(12.5, 60, a);
    tesseraLights(72.5, 60, b);
    a.forEach((v, k) => {
      expect(v.toArray()).toEqual(b[k].toArray());
      expect(v.length()).toBeCloseTo(1, 9);
      expect(v.y).toBeLessThan(-0.7);
    });
    const az = a.map((v) => Math.atan2(v.z, v.x));
    const gap = (i: number, j: number) => {
      const d = Math.abs(az[i] - az[j]) % (Math.PI * 2);
      return Math.min(d, Math.PI * 2 - d);
    };
    expect(gap(0, 1)).toBeCloseTo((Math.PI * 2) / 3, 9);
    expect(gap(1, 2)).toBeCloseTo((Math.PI * 2) / 3, 9);
  });

  it("moves the bands visibly within a few seconds", () => {
    const a = lights();
    const b = lights();
    tesseraLights(4, 60, a);
    tesseraLights(8, 60, b);
    expect(a[0].angleTo(b[0])).toBeGreaterThan((10 * Math.PI) / 180);
  });

  it("starts the springing fade just above y 4 in landscape and lifts it in portrait", () => {
    expect(tesseraSpring(3.7, 16 / 9)).toEqual([4.3, 3.7]);
    const [start, width] = tesseraSpring(3.7, 9 / 16);
    expect(start).toBeCloseTo(4.3 + 1.85, 9);
    expect(width).toBeGreaterThan(3.7);
  });
});
