import { describe, expect, it } from "vitest";
import { buildAreaSolid, buildRibbonSolid, type ChartPoint2 } from "./geometry3d";
import { chart3dSpace, chartWorldX, chartWorldY } from "./space3d";

const positionsOf = (geometry: { getAttribute: (n: string) => { array: ArrayLike<number> } }) =>
  Array.from(geometry.getAttribute("position").array);

/** Every triangle's winding must agree with the normal it carries, or half the solid renders inside out. */
function windingAgrees(geometry: ReturnType<typeof buildAreaSolid>): boolean {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  for (let t = 0; t < position.count; t += 3) {
    const ax = position.getX(t);
    const ay = position.getY(t);
    const az = position.getZ(t);
    const ux = position.getX(t + 1) - ax;
    const uy = position.getY(t + 1) - ay;
    const uz = position.getZ(t + 1) - az;
    const vx = position.getX(t + 2) - ax;
    const vy = position.getY(t + 2) - ay;
    const vz = position.getZ(t + 2) - az;
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    if (Math.hypot(gx, gy, gz) < 1e-9) continue; // degenerate slivers carry no facing
    const dot = gx * normal.getX(t) + gy * normal.getY(t) + gz * normal.getZ(t);
    if (dot < 0) return false;
  }
  return true;
}

const line: ChartPoint2[] = [
  { x: -2, y: 0.5 },
  { x: -1, y: 1.4 },
  { x: 0, y: 0.9 },
  { x: 1, y: 2.1 },
  { x: 2, y: 1.6 },
];
const baseline: ChartPoint2[] = line.map((p) => ({ x: p.x, y: 0 }));

describe("buildAreaSolid", () => {
  it("emits four walls per segment plus two caps, all as triangles", () => {
    const geometry = buildAreaSolid(line, baseline, 0.1);
    const segments = line.length - 1;
    expect(geometry.getAttribute("position").count).toBe((segments * 4 + 2) * 6);
  });

  it("winds every triangle to match its normal", () => {
    expect(windingAgrees(buildAreaSolid(line, baseline, 0.1))).toBe(true);
  });

  it("carries unit normals", () => {
    const normal = buildAreaSolid(line, baseline, 0.1).getAttribute("normal");
    for (let i = 0; i < normal.count; i++) {
      expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 6);
    }
  });

  it("spans the extrusion depth either side of z 0", () => {
    const z = positionsOf(buildAreaSolid(line, baseline, 0.25)).filter((_, i) => i % 3 === 2);
    expect(Math.min(...z)).toBeCloseTo(-0.25, 6);
    expect(Math.max(...z)).toBeCloseTo(0.25, 6);
  });

  it("is byte-identical across calls", () => {
    expect(positionsOf(buildAreaSolid(line, baseline, 0.1))).toEqual(
      positionsOf(buildAreaSolid(line, baseline, 0.1)),
    );
  });

  it("degrades to empty geometry below two points", () => {
    expect(buildAreaSolid([line[0]], [baseline[0]], 0.1).getAttribute("position").count).toBe(0);
  });
});

describe("buildRibbonSolid", () => {
  it("emits four faces per segment plus two caps", () => {
    const geometry = buildRibbonSolid(line, 0.08, 0.1);
    const segments = line.length - 1;
    expect(geometry.getAttribute("position").count).toBe((segments * 4 + 2) * 6);
  });

  it("winds every triangle to match its normal", () => {
    expect(windingAgrees(buildRibbonSolid(line, 0.08, 0.1))).toBe(true);
  });

  it("keeps the sweep within half a thickness of the polyline", () => {
    const thickness = 0.08;
    const geometry = buildRibbonSolid(line, thickness, 0.1);
    const position = geometry.getAttribute("position");
    let worst = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      let nearest = Number.POSITIVE_INFINITY;
      for (const p of line) nearest = Math.min(nearest, Math.hypot(x - p.x, y - p.y));
      worst = Math.max(worst, nearest);
    }
    // Mitred joints widen the offset a little; never past the miter cap.
    expect(worst).toBeLessThan(thickness);
  });

  it("degrades to empty geometry below two points", () => {
    expect(buildRibbonSolid([line[0]], 0.08, 0.1).getAttribute("position").count).toBe(0);
  });
});

describe("chart3dSpace", () => {
  it("puts the floor at y 0 and centres the plot on x", () => {
    const space = chart3dSpace(0.5, 6, 3);
    expect(chartWorldY(space, 0)).toBe(0);
    expect(chartWorldY(space, 1)).toBe(3);
    expect(chartWorldX(space, 0)).toBe(-3);
    expect(chartWorldX(space, 1)).toBe(3);
  });

  it("keeps the gridline wall behind the marks and labels in front", () => {
    const space = chart3dSpace(1, 6, 3);
    expect(space.wallZ).toBeLessThan(-space.halfDepth);
    expect(space.frontZ).toBeGreaterThan(space.halfDepth);
  });

  it("scales depth with the plot's short side", () => {
    expect(chart3dSpace(0, 6, 3).depth).toBeLessThan(chart3dSpace(1, 6, 3).depth);
    expect(chart3dSpace(1, 6, 3).depth).toBeCloseTo(chart3dSpace(1, 3, 6).depth, 12);
  });

  it("survives degenerate sizes", () => {
    const space = chart3dSpace(Number.NaN, 0, -4);
    expect(Number.isFinite(space.depth)).toBe(true);
    expect(space.unit).toBeGreaterThan(0);
  });
});
