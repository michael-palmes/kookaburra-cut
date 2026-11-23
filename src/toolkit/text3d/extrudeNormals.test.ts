import { ExtrudeGeometry, Shape } from "three";
import { describe, expect, it } from "vitest";
import { smoothExtrudeNormals } from "./extrudeNormals";

function slab(): ExtrudeGeometry {
  const shape = new Shape();
  shape.moveTo(-1, -1);
  shape.lineTo(1, -1);
  shape.lineTo(1, 1);
  shape.lineTo(-1, 1);
  shape.closePath();
  return new ExtrudeGeometry(shape, {
    depth: 0.5,
    bevelEnabled: true,
    bevelSize: 0.1,
    bevelThickness: 0.1,
    bevelSegments: 6,
  });
}

describe("smoothExtrudeNormals", () => {
  it("keeps the front and back planes flat", () => {
    const geometry = smoothExtrudeNormals(slab());
    const box = geometry.boundingBox;
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    let front = 0;
    let back = 0;
    for (let i = 0; i < positions.count; i++) {
      const z = positions.getZ(i);
      if (Math.abs(z - (box?.max.z ?? 0)) < 1e-6) {
        expect([normals.getX(i), normals.getY(i), normals.getZ(i)]).toEqual([0, 0, 1]);
        front++;
      } else if (Math.abs(z - (box?.min.z ?? 0)) < 1e-6) {
        expect([normals.getX(i), normals.getY(i), normals.getZ(i)]).toEqual([0, 0, -1]);
        back++;
      }
    }
    expect(front).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(0);
  });

  it("turns the bevel's normals smoothly from the face to the side", () => {
    const geometry = smoothExtrudeNormals(slab());
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    let leaning = 0;
    for (let i = 0; i < positions.count; i++) {
      const length = Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i));
      expect(length).toBeCloseTo(1, 5);
      const nz = Math.abs(normals.getZ(i));
      if (nz > 0.05 && nz < 0.95) leaning++;
    }
    expect(leaning).toBeGreaterThan(0);
  });
});
