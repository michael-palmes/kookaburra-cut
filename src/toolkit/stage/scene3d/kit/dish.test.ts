import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createSeededRandom } from "../../../../engine/rng";
import {
  createDishDiscGeometry,
  DISH_FLOOR_VERTEX_SHADER,
  type DishShape,
  dishHeight,
  dishSlope,
} from "./dish";
import { lookMaterialProblem } from "./material";

const DISH: DishShape = { start: 9, span: 31, rise: 5 };

describe("dish floors", () => {
  it("stays flat round the stage and reaches `rise` one span out", () => {
    expect(dishHeight(0, DISH)).toBe(0);
    expect(dishHeight(DISH.start, DISH)).toBe(0);
    expect(dishHeight(DISH.start + DISH.span, DISH)).toBeCloseTo(DISH.rise, 12);
    expect(dishHeight(30, { ...DISH, rise: 0 })).toBe(0);
  });

  it("gives the slope as the height's derivative", () => {
    for (const r of [4, 12, 25.5, 47]) {
      const d = (dishHeight(r + 1e-5, DISH) - dishHeight(r - 1e-5, DISH)) / 2e-5;
      expect(dishSlope(r, DISH), `r ${r}`).toBeCloseTo(d, 6);
    }
  });

  it("never lets a chord between two points above the dish dip under it", () => {
    const rand = createSeededRandom(0xd15c);
    const above = () => {
      const a = rand() * Math.PI * 2;
      const r = rand() * 60;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      return new Vector3(x, dishHeight(r, DISH) + rand() * 6, z);
    };
    const p = new Vector3();
    for (let i = 0; i < 400; i++) {
      const a = above();
      const b = above();
      for (let s = 1; s < 32; s++) {
        p.lerpVectors(a, b, s / 32);
        expect(p.y).toBeGreaterThanOrEqual(dishHeight(Math.hypot(p.x, p.z), DISH) - 1e-9);
      }
    }
  });

  it("builds a unit disc whose faces point up", () => {
    const g = createDishDiscGeometry(4, 16, 50);
    const pos = g.getAttribute("position");
    const index = g.getIndex();
    expect(index).not.toBeNull();
    const ab = new Vector3();
    const ac = new Vector3();
    for (let t = 0; t < (index?.count ?? 0); t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) =>
        new Vector3().fromBufferAttribute(pos, index?.getX(t + k) ?? 0),
      );
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const ny = ab.cross(ac).y;
      if (Math.abs(ny) > 1e-9) expect(ny).toBeGreaterThan(0);
    }
    expect(g.boundingSphere?.radius).toBe(50);
    g.dispose();
  });

  it("ships a sound floor vertex shader", () => {
    expect(
      lookMaterialProblem({
        key: "kit/dish",
        vertexShader: DISH_FLOOR_VERTEX_SHADER,
        fragmentShader:
          "void main() { gl_FragColor = vec4(1.0); \n#include <colorspace_fragment>\n }",
      }),
    ).toBeNull();
  });
});
