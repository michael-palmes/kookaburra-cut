import { describe, expect, it } from "vitest";
import { slabGeometry } from "./slabGeometry";

describe("slabGeometry", () => {
  it("fills its width, height and depth exactly, centred", () => {
    const geometry = slabGeometry(2, 0.5, 0.3, 0.25, 0.05);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box?.min.x).toBeCloseTo(-1, 4);
    expect(box?.max.x).toBeCloseTo(1, 4);
    expect(box?.min.y).toBeCloseTo(-0.25, 4);
    expect(box?.max.y).toBeCloseTo(0.25, 4);
    expect(box?.min.z).toBeCloseTo(-0.15, 4);
    expect(box?.max.z).toBeCloseTo(0.15, 4);
  });

  it("keeps its faces flat under the smoothed bevel", () => {
    const geometry = slabGeometry(2, 0.5, 0.3, 0.25, 0.05);
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    for (let i = 0; i < positions.count; i++) {
      if (Math.abs(positions.getZ(i) - 0.15) < 1e-6) expect(normals.getZ(i)).toBe(1);
    }
  });

  it("caps an oversized radius at a capsule and an oversized edge below the half depth", () => {
    const geometry = slabGeometry(2, 0.5, 0.1, 9, 9);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.max.y).toBeCloseTo(0.25, 4);
    expect(geometry.boundingBox?.max.z).toBeCloseTo(0.05, 4);
  });
});
