import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  createMezzoLandGeometry,
  createMezzoMistGeometry,
  MEZZO_LAND,
  MEZZO_LAND_RADIUS,
  MEZZO_RIDGES,
  MEZZO_STRATA,
  MEZZO_STRATUM_GRID,
  mezzoLandCrest,
  mezzoLandHeight,
  mezzoLandRingRadius,
} from "./land";

const TAU = Math.PI * 2;
const worldY = (h: number, relief = MEZZO_LAND.reliefMax) => MEZZO_LAND.floorY + h * relief;

/** Highest land at relief max over a polar sweep between two radii. */
function peak(from: number, to: number): number {
  let top = 0;
  for (let r = from; r <= to; r += 0.25) {
    for (let j = 0; j < 720; j++) {
      const a = (j / 720) * TAU;
      top = Math.max(top, mezzoLandHeight(Math.cos(a) * r, Math.sin(a) * r));
    }
  }
  return worldY(top);
}

describe("mezzotint sky land", () => {
  it("stays under the content volume at full relief, flat in the stage clearing", () => {
    let top = Number.NEGATIVE_INFINITY;
    for (let x = -4.5; x <= 4.5; x += 0.25) {
      for (let z = -6.5; z <= 9.5; z += 0.25) top = Math.max(top, worldY(mezzoLandHeight(x, z)));
    }
    expect(top).toBeLessThan(-2.05);
    expect(mezzoLandHeight(0, 0)).toBe(0);
    expect(mezzoLandHeight(3, -3)).toBe(0);
  });

  it("stays well under an eye-level camera anywhere in the 50-unit reach", () => {
    expect(peak(0, MEZZO_LAND.reach[0] - 3)).toBeLessThan(-0.5);
  });

  it("rises to taller ranges past the reach and flattens out to the rim", () => {
    expect(peak(70, 160)).toBeGreaterThan(3);
    expect(peak(MEZZO_LAND.flatten[1], MEZZO_LAND_RADIUS)).toBe(MEZZO_LAND.floorY);
    expect(MEZZO_RIDGES.map((g) => g.radius)).toEqual(
      [...MEZZO_RIDGES.map((g) => g.radius)].sort((a, b) => a - b),
    );
  });

  it("meets the dome sphere at its rim, so no pose sees a gap", () => {
    expect(MEZZO_LAND_RADIUS ** 2 + MEZZO_LAND.floorY ** 2).toBeCloseTo(
      MEZZO_LAND.domeRadius ** 2,
      6,
    );
    expect(mezzoLandRingRadius(MEZZO_LAND.rings)).toBeCloseTo(MEZZO_LAND_RADIUS, 9);
    expect(mezzoLandRingRadius(0)).toBe(MEZZO_LAND.inner);
  });

  it("weights crests 1 on a full ridge line and 0 in the clearing", () => {
    let best = 0;
    for (let j = 0; j < 720; j++) {
      const a = (j / 720) * TAU;
      for (let r = 14; r < 30; r += 0.1)
        best = Math.max(best, mezzoLandCrest(Math.cos(a) * r, Math.sin(a) * r));
    }
    expect(best).toBeGreaterThan(0.95);
    expect(mezzoLandCrest(2, 2)).toBe(0);
  });

  it("lays each mist stratum in a valley: over some land, under the crests round it", () => {
    for (const s of MEZZO_STRATA) {
      const mid = (s.from + s.to) / 2;
      let under = 0;
      for (let j = 0; j < 360; j++) {
        const a = (j / 360) * TAU;
        if (mezzoLandHeight(Math.cos(a) * mid, Math.sin(a) * mid) < s.height) under++;
      }
      expect(under / 360, `${s.from}-${s.to}`).toBeGreaterThan(0.3);
      expect(s.from).toBeLessThan(s.to);
    }
  });

  it("builds the heightfield faces up with the slope and crest per vertex", () => {
    const g = createMezzoLandGeometry();
    const { rings, columns } = MEZZO_LAND;
    expect(g.getAttribute("position").count).toBe(1 + (rings + 1) * columns);
    expect(g.getAttribute("aLand").itemSize).toBe(3);
    const pos = g.getAttribute("position");
    const index = g.getIndex();
    if (!index) throw new Error("indexed");
    const at = (i: number) => new Vector3().fromBufferAttribute(pos, index.getX(i));
    for (const tri of [0, columns, columns + 7 * columns * 2, index.count / 3 - 1]) {
      const [a, b, c] = [at(tri * 3), at(tri * 3 + 1), at(tri * 3 + 2)];
      const n = b.sub(a).cross(c.sub(a));
      expect(n.y, `triangle ${tri}`).toBeGreaterThan(0);
    }
    g.dispose();
  });

  it("orders the mist strata far to near and records the land under each vertex", () => {
    const g = createMezzoMistGeometry();
    const { rows, columns } = MEZZO_STRATUM_GRID;
    const per = (rows + 1) * columns;
    expect(g.getAttribute("position").count).toBe(MEZZO_STRATA.length * per);
    const mist = g.getAttribute("aMist");
    const pos = g.getAttribute("position");
    const firstFrom = mist.getZ(0);
    const lastFrom = mist.getZ(mist.count - 1);
    expect(firstFrom).toBeGreaterThan(lastFrom);
    const v = per + 5 * columns + 17;
    expect(mist.getX(v)).toBeCloseTo(mezzoLandHeight(pos.getX(v), pos.getZ(v)), 4);
    g.dispose();
  });
});
