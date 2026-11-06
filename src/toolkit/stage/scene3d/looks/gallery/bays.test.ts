import { Box3, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { lookMaterialProblem } from "../../kit/material";
import {
  BAY_RANGE,
  bayCentres,
  bayClearArea,
  CLOUD_LOOP,
  CONTENT_BOX,
  GALLERY,
  LAMP,
  LAMP_HEIGHT_RANGE,
  lampExtent,
  MAX_LAMPS,
  MAX_PIERS,
  PIER_DEPTH_RANGE,
  pierCentres,
  writeCloudPhases,
} from "./bays";
import { lampGeometries } from "./Gallery";
import { look, presets } from "./index";
import {
  BRASS_FRAGMENT,
  BRASS_VERTEX,
  FLAT_FRAGMENT,
  FLOOR_FRAGMENT,
  GLASS_FRAGMENT,
  PIER_FRAGMENT,
  WALL_FRAGMENT,
} from "./shaders";

const PITCHES = Array.from(
  { length: (BAY_RANGE.max - BAY_RANGE.min) / 0.5 + 1 },
  (_, i) => BAY_RANGE.min + i * 0.5,
);

describe("gallery bays", () => {
  it("centres a bay on the stage and spaces bays and piers one bay width apart", () => {
    for (const pitch of PITCHES) {
      const bays = bayCentres(pitch);
      const piers = pierCentres(pitch);
      expect(bays, `${pitch}`).toContain(0);
      expect(piers, `${pitch}`).toHaveLength(bays.length + 1);
      bays.forEach((x, i) => {
        expect(piers[i], `${pitch}`).toBeCloseTo(x - pitch / 2, 9);
        expect(piers[i + 1], `${pitch}`).toBeCloseTo(x + pitch / 2, 9);
      });
      expect(Math.max(...piers.map(Math.abs)) + GALLERY.pierWidth / 2).toBeLessThanOrEqual(
        GALLERY.halfLength,
      );
    }
  });

  it("fits every bay width inside the instance capacities", () => {
    for (const pitch of PITCHES) {
      expect(bayCentres(pitch).length, `${pitch}`).toBeLessThanOrEqual(MAX_LAMPS);
      expect(pierCentres(pitch).length, `${pitch}`).toBeLessThanOrEqual(MAX_PIERS);
    }
  });

  it("matches the bounds to the look's sliders", () => {
    expect(look.params.bayWidth).toMatchObject(BAY_RANGE);
    expect(look.params.pierDepth).toMatchObject(PIER_DEPTH_RANGE);
    expect(look.params.lampHeight).toMatchObject(LAMP_HEIGHT_RANGE);
  });

  it("keeps the wall, the piers and the lamps behind the content volume at every slider value", () => {
    const zMax = GALLERY.wallZ + Math.max(PIER_DEPTH_RANGE.max, lampExtent().out);
    expect(zMax).toBeLessThan(CONTENT_BOX.zMin - 0.25);
    expect(GALLERY.floorY).toBeLessThan(-CONTENT_BOX.y - 1);
    expect(GALLERY.ceilingY).toBeGreaterThan(CONTENT_BOX.y + 4);
    expect(GALLERY.frontZ).toBeGreaterThan(CONTENT_BOX.zMax + 15);
  });

  it("keeps the highest lamp under the clerestory sill", () => {
    expect(LAMP_HEIGHT_RANGE.max + LAMP.armRise + LAMP.plate[1] / 2).toBeLessThan(GALLERY.sillY);
  });

  it("states the lamp's reach from its real geometry", () => {
    const box = new Box3();
    const parts = lampGeometries();
    for (const g of Object.values(parts)) {
      g.computeBoundingBox();
      if (g.boundingBox) box.union(g.boundingBox);
    }
    const extent = lampExtent();
    expect(-box.min.y).toBeLessThanOrEqual(extent.below + 1e-6);
    expect(box.max.z).toBeLessThanOrEqual(extent.out + 1e-6);
    expect(box.min.z).toBeGreaterThanOrEqual(0);
    for (const g of Object.values(parts)) g.dispose();
  });

  it("leaves every bay clear across the stage height at the default lamp height", () => {
    const area = bayClearArea(look.params.bayWidth.default, look.params.lampHeight.default);
    expect(area.halfWidth).toBeGreaterThanOrEqual(3.5);
    expect(area.bottom).toBeLessThan(-CONTENT_BOX.y);
    expect(area.top).toBeGreaterThan(CONTENT_BOX.y + 0.4);
  });

  it("loops the passing cloud exactly", () => {
    const a = new Vector3();
    const b = new Vector3();
    for (const t of [0, 7.25, 119.5, 1234.5]) {
      writeCloudPhases(a, t);
      writeCloudPhases(b, t + CLOUD_LOOP);
      expect(b.distanceTo(a), `${t}`).toBeLessThan(1e-9);
    }
  });
});

describe("gallery presets", () => {
  it("keeps every preset's bays at the default width, so hung works stay put", () => {
    for (const p of presets) {
      expect(p.params?.bayWidth, p.id).toBe(look.params.bayWidth.default);
      expect(p.params?.lampHeight, p.id).toBe(look.params.lampHeight.default);
    }
  });

  it("carries a cheap soft top light", () => {
    for (const p of presets) {
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      expect(p.lighting?.sun?.elevationDeg, p.id).toBeGreaterThanOrEqual(60);
      expect(p.lighting?.lights, p.id).toBeUndefined();
    }
  });

  it("builds sound look materials", () => {
    for (const [key, fragmentShader] of [
      ["gallery/wall", WALL_FRAGMENT],
      ["gallery/pier", PIER_FRAGMENT],
      ["gallery/floor", FLOOR_FRAGMENT],
      ["gallery/flat", FLAT_FRAGMENT],
      ["gallery/glass", GLASS_FRAGMENT],
    ]) {
      expect(lookMaterialProblem({ key, fragmentShader }), key).toBeNull();
    }
    expect(
      lookMaterialProblem({
        key: "gallery/can",
        vertexShader: BRASS_VERTEX,
        fragmentShader: BRASS_FRAGMENT,
      }),
    ).toBeNull();
  });
});
