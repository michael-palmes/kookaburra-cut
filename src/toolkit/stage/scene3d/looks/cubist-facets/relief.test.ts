import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import { CUBIST_COURSES, cubistRelief } from "./relief";
import { RELIEF_FRAGMENT, RELIEF_VERTEX, SKY_FRAGMENT } from "./shaders";

const DEFAULTS = { radius: 22, planes: 13, fold: 16, relief: 0.45 };

const corners = [
  { radius: 16, planes: 8, fold: 0, relief: 0 },
  { radius: 16, planes: 20, fold: 30, relief: 1.2 },
  { radius: 32, planes: 8, fold: 30, relief: 1.2 },
  { radius: 32, planes: 20, fold: 0, relief: 0 },
  DEFAULTS,
];

describe("cubistRelief", () => {
  it("rebuilds the approved sketch composition at the default params", () => {
    const r = cubistRelief(DEFAULTS);
    expect(r.kinds.length).toBe(46);
    expect(r.vertices).toBe(330);
    expect(r.kinds.filter((k) => k === "diag").length).toBe(30);
    expect(r.kinds.filter((k) => k === "vert").length).toBe(9);
    expect(r.kinds.filter((k) => k === "flat").length).toBe(7);
    expect(r.position[0]).toBeCloseTo(-0.59993, 4);
    expect(r.position[2]).toBeCloseTo(-21.09189, 4);
  });

  it("is a pure function of its options", () => {
    const a = cubistRelief(DEFAULTS);
    const b = cubistRelief(DEFAULTS);
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    expect(Array.from(a.seed)).toEqual(Array.from(b.seed));
  });

  it("faces every facet toward the stage axis and keeps the stage clear", () => {
    for (const o of corners) {
      const r = cubistRelief(o);
      for (let v = 0; v < r.vertices; v += 3) {
        let cx = 0;
        let cz = 0;
        for (let k = 0; k < 3; k++) {
          cx += r.position[(v + k) * 3];
          cz += r.position[(v + k) * 3 + 2];
        }
        expect(r.half[v * 3] * cx + r.half[v * 3 + 2] * cz).toBeLessThan(0);
      }
      for (let i = 0; i < r.position.length; i += 3) {
        expect(Math.hypot(r.position[i], r.position[i + 2])).toBeGreaterThan(11);
        expect(r.position[i + 1]).toBeGreaterThan(CUBIST_COURSES[0][0] - 1.5);
      }
    }
  });

  it("stores each contour edge's altitude, so bary times altitude is the world distance to it", () => {
    const r = cubistRelief(DEFAULTS);
    const p = (i: number) => [r.position[i * 3], r.position[i * 3 + 1], r.position[i * 3 + 2]];
    for (let v = 0; v < r.vertices; v += 3) {
      for (let k = 0; k < 3; k++) {
        const alt = r.edge[v * 3 + k];
        if (alt === 0) continue;
        const a = p(v + k);
        const b = p(v + ((k + 1) % 3));
        const c = p(v + ((k + 2) % 3));
        const bc = b.map((x, i) => c[i] - x);
        const ba = b.map((x, i) => a[i] - x);
        const t =
          (ba[0] * bc[0] + ba[1] * bc[1] + ba[2] * bc[2]) / (bc[0] ** 2 + bc[1] ** 2 + bc[2] ** 2);
        const foot = b.map((x, i) => x + bc[i] * t);
        expect(Math.hypot(a[0] - foot[0], a[1] - foot[1], a[2] - foot[2])).toBeCloseTo(alt, 4);
      }
    }
  });

  it("builds sound look materials and whole plane counts", () => {
    for (const [part, fragmentShader, vertexShader] of [
      ["relief", RELIEF_FRAGMENT, RELIEF_VERTEX],
      ["sky", SKY_FRAGMENT, undefined],
    ] as const) {
      expect(
        lookMaterialProblem({ key: `cubist-facets/${part}`, fragmentShader, vertexShader }),
        part,
      ).toBeNull();
    }
    expect(look.params.planes.step).toBe(1);
    for (const p of presets) expect(Number.isInteger(p.params?.planes), p.id).toBe(true);
  });
});
