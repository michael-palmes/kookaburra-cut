import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { lookMaterialProblem } from "../../kit/material";
import {
  COURT_BASE,
  COURT_FLOOR_Y,
  COURT_MAX_WALLS,
  COURT_REACH,
  COURT_SLOT,
  COURT_SLOT_WALL,
  courtLayout,
  courtSunAzimuth,
  courtWallGap,
  courtWallReach,
} from "./court";
import { look, presets } from "./index";
import { FLOOR_FRAGMENT, WALL_FRAGMENT, WALL_VERTEX } from "./shaders";

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

describe("courtLayout", () => {
  it("keeps the sketch's hand layout at seed 1", () => {
    expect(courtLayout(1)).toEqual(COURT_BASE);
    expect(COURT_BASE).toHaveLength(COURT_MAX_WALLS);
    expect(look.params.walls.max).toBe(COURT_MAX_WALLS);
  });

  it("is a pure function of the seed", () => {
    for (const s of SEEDS) expect(courtLayout(s)).toEqual(courtLayout(s));
    expect(courtLayout(3)).not.toEqual(courtLayout(5));
  });

  it("keeps every wall in reach of the stage and clear of the others, for every seed", () => {
    for (const s of SEEDS) {
      const walls = courtLayout(s);
      walls.forEach((w, i) => {
        const reach = courtWallReach(w);
        expect(reach, `seed ${s} wall ${i}`).toBeGreaterThanOrEqual(COURT_REACH.near);
        expect(reach, `seed ${s} wall ${i}`).toBeLessThanOrEqual(COURT_REACH.far);
        for (let j = 0; j < i; j++) {
          expect(courtWallGap(w, walls[j]), `seed ${s} walls ${j} and ${i}`).toBeGreaterThan(0.5);
        }
      });
    }
  });

  it("always stands a wall behind the stage and keeps the slot wall and its slot", () => {
    for (const s of SEEDS) {
      const walls = courtLayout(s);
      const back = walls[0];
      const a = (back.angleDeg * Math.PI) / 180;
      const t = -back.x / Math.cos(a);
      expect(Math.abs(t), `seed ${s}`).toBeLessThan(back.width / 2);
      expect(back.z + t * Math.sin(a), `seed ${s}`).toBeLessThan(-12);
      expect(walls[COURT_SLOT_WALL].height).toBe(COURT_BASE[COURT_SLOT_WALL].height);
    }
    expect(COURT_FLOOR_Y + COURT_SLOT.bottom).toBeGreaterThan(2.5);
    expect(COURT_SLOT.top).toBeLessThan(COURT_BASE[COURT_SLOT_WALL].height);
  });

  it("mirrors the sun with the layout", () => {
    expect(courtSunAzimuth(1)).toBe(135);
    expect(courtSunAzimuth(2)).toBe(225);
  });
});

describe("colour-court presets", () => {
  it("lights devices from the virtual sun's mean, at each preset's own elevation", () => {
    for (const p of presets) {
      const params = p.params ?? {};
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(courtSunAzimuth(params.layoutSeed));
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(params.sunElevation);
      expect(p.lighting?.lights, p.id).toBeUndefined();
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      expect(Number.isInteger(params.layoutSeed), p.id).toBe(true);
      expect(Number.isInteger(params.walls), p.id).toBe(true);
    }
  });

  it("builds sound look materials", () => {
    expect(
      lookMaterialProblem({
        key: "colour-court/wall",
        vertexShader: WALL_VERTEX,
        fragmentShader: WALL_FRAGMENT,
      }),
    ).toBeNull();
    expect(
      lookMaterialProblem({ key: "colour-court/floor", fragmentShader: FLOOR_FRAGMENT }),
    ).toBeNull();
  });
});
