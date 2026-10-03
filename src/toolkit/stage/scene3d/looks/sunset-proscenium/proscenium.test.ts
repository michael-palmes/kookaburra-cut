import { describe, expect, it } from "vitest";
import { lookMaterialProblem } from "../../kit/material";
import { look, presets } from "./index";
import {
  archPoint,
  aspectCrown,
  covePhase,
  PORTRAIT_CROWN,
  type ProsceniumParams,
  prosceniumArrays,
  prosceniumRibs,
  RIB_DEPTH,
  RIB_SEGMENTS,
} from "./proscenium";
import { FLOOR_FRAGMENT, RIB_FRAGMENT, RIB_VERTEX } from "./shaders";

type V3 = [number, number, number];
const TAN_HALF_FOV = Math.tan((45 * Math.PI) / 360);

/** NDC of a world point from a camera at `eye` looking at `target` (vertical fov 45, like the app camera). */
function ndc(p: V3, eye: V3, target: V3, aspect: number): [number, number] {
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a: V3): V3 => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a: V3, b: V3): V3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const f = norm(sub(target, eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const d = sub(p, eye);
  const z = dot(d, f);
  return [dot(d, r) / z / TAN_HALF_FOV / aspect, dot(d, u) / z / TAN_HALF_FOV];
}

function orbitEye(azimuthDeg: number, elevationDeg: number, distance: number): V3 {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [
    distance * Math.cos(e) * Math.sin(a),
    distance * Math.sin(e),
    distance * Math.cos(e) * Math.cos(a),
  ];
}

const paramsOf = (p: (typeof presets)[number]): ProsceniumParams => ({
  ribs: p.params?.ribs ?? 7,
  setBack: p.params?.setBack ?? 9,
  innerWidth: p.params?.innerWidth ?? 16,
  crown: p.params?.crown ?? 6.3,
});

/** True when the inner arch (rib 0) leaves the stage-depth box clear: no arch point lands inside it on screen and the crown sits above it. */
function openingContains(
  params: ProsceniumParams,
  eye: V3,
  box: { halfWidth: number; bottom: number; top: number },
  aspect: number,
): boolean {
  const [inner] = prosceniumRibs(params);
  const target: V3 = [0, 0, 0];
  const corners: V3[] = [
    [-box.halfWidth, box.bottom, 0],
    [box.halfWidth, box.bottom, 0],
    [-box.halfWidth, box.top, 0],
    [box.halfWidth, box.top, 0],
  ].map((c) => c as V3);
  const projected = corners.map((c) => ndc(c, eye, target, aspect));
  const xs = projected.map((c) => c[0]);
  const ys = projected.map((c) => c[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let i = 0; i <= 200; i++) {
    const [x, y] = archPoint(inner, (i / 200) * Math.PI);
    const [sx, sy] = ndc([x, y, inner.z], eye, target, aspect);
    if (sx > x0 && sx < x1 && sy > y0 && sy < y1) return false;
  }
  const crown = ndc([0, archPoint(inner, Math.PI / 2)[1], inner.z], eye, target, aspect);
  return crown[1] > y1;
}

describe("sunset-proscenium ribs", () => {
  it("reproduces the approved sketch at the defaults", () => {
    const ribs = prosceniumRibs({ ribs: 7, setBack: 9, innerWidth: 16, crown: 6.3 });
    expect(ribs).toHaveLength(7);
    expect(ribs[0].z).toBeCloseTo(-16.2, 6);
    expect(ribs[6].z).toBeCloseTo(-9, 6);
    expect(ribs[0].halfWidth).toBeCloseTo(16.2, 0);
    expect(archPoint(ribs[0], Math.PI / 2)[1]).toBeCloseTo(6.3, 6);
    expect(ribs[6].halfWidth - ribs[0].halfWidth).toBeCloseTo(6 * 0.35, 6);
  });

  it("holds the inner opening's screen size whatever the rib count and set back", () => {
    const angle = (p: ProsceniumParams) => {
      const [inner] = prosceniumRibs(p);
      const distance = 5 - inner.z;
      return [inner.halfWidth / distance, archPoint(inner, Math.PI / 2)[1] / distance];
    };
    const base = angle({ ribs: 7, setBack: 9, innerWidth: 16, crown: 6.3 });
    for (const [ribs, setBack] of [
      [4, 7],
      [10, 14],
      [6, 12],
    ]) {
      const a = angle({ ribs, setBack, innerWidth: 16, crown: 6.3 });
      expect(a[0]).toBeCloseTo(base[0], 6);
      expect(a[1]).toBeCloseTo(base[1], 6);
    }
  });

  it("keeps the headline zone inside every preset's inner opening in 16:9", () => {
    const sketchHeadline = { halfWidth: 3, bottom: -0.5, top: 0.8 };
    const atlasHeadline = { halfWidth: 1.6, bottom: 1.55, top: 1.85 };
    const atlasPoses: [number, number, number][] = [
      [-18, 8, 7],
      [0, 7, 6.75],
      [18, 6, 6.5],
    ];
    for (const p of presets) {
      const params = paramsOf(p);
      expect(openingContains(params, [0, 0, 5], sketchHeadline, 16 / 9), p.id).toBe(true);
      for (const [az, el, dist] of atlasPoses) {
        const eye = orbitEye(az, el, dist);
        expect(openingContains(params, eye, atlasHeadline, 16 / 9), `${p.id} ${az}`).toBe(true);
      }
    }
  });

  it("sets the crown just above a 9:16 headline", () => {
    const portraitHeadlineTop = 2;
    for (const p of presets) {
      const params = paramsOf(p);
      const [inner] = prosceniumRibs({ ...params, crown: aspectCrown(params.crown, 9 / 16) });
      const crownY = archPoint(inner, Math.PI / 2)[1];
      for (const [az, el, dist] of [
        [-18, 8, 7],
        [0, 7, 6.75],
        [18, 6, 6.5],
      ]) {
        const eye = orbitEye(az, el, dist);
        const crown = ndc([0, crownY, inner.z], eye, [0, 0, 0], 9 / 16)[1];
        const headline = ndc([0, portraitHeadlineTop, 0], eye, [0, 0, 0], 9 / 16)[1];
        expect(crown - headline, `${p.id} ${az}`).toBeGreaterThan(0.02);
        expect(crown, `${p.id} ${az}`).toBeLessThan(0.92);
      }
    }
  });

  it("builds the 16:9 crown as set and eases it down for portrait", () => {
    expect(aspectCrown(6.6, 16 / 9)).toBe(6.6);
    expect(aspectCrown(6.6, 1)).toBe(6.6);
    expect(aspectCrown(6.6, 9 / 16)).toBeCloseTo(6.6 * PORTRAIT_CROWN, 9);
    expect(aspectCrown(6.6, 4 / 5)).toBeGreaterThan(aspectCrown(6.6, 9 / 16));
  });
});

describe("sunset-proscenium mesh", () => {
  it("builds a soffit and a riser per rib, mirrored past the far side", () => {
    const ribs = prosceniumRibs({ ribs: 7, setBack: 9, innerWidth: 16, crown: 6.3 });
    const a = prosceniumArrays(ribs);
    const strip = (RIB_SEGMENTS + 1) * 2;
    expect(a.position.length / 3).toBe(2 * 7 * 2 * strip);
    expect(a.index.length / 3).toBe(2 * 7 * 2 * RIB_SEGMENTS * 2);
    expect(Math.max(...a.index)).toBeLessThan(a.position.length / 3);
    const half = a.position.length / 2;
    for (let i = 2; i < half; i += 3) {
      expect(a.position[half + i]).toBeCloseTo(-a.position[i], 6);
    }
    const zs = Array.from(a.position.subarray(0, half)).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(ribs[0].z - RIB_DEPTH, 5);
    expect(Math.max(...zs)).toBeCloseTo(ribs[6].z, 5);
  });

  it("fits the densest slider value in a 16-bit index", () => {
    const ribs = prosceniumRibs({ ribs: 10, setBack: 14, innerWidth: 20, crown: 9 });
    expect(prosceniumArrays(ribs).position.length / 3).toBeLessThan(65536);
  });

  it("starts the cove pulse at the innermost rib and rises outward", () => {
    for (let k = 0; k < 7; k++) {
      expect(covePhase(0.5 + (k * 0.6) / 8, k, 0, 7), `${k}`).toBeCloseTo(0.5, 9);
    }
    expect(covePhase(0.5, 0, 1, 7)).toBeLessThan(0.5);
  });
});

describe("sunset-proscenium look", () => {
  it("builds sound look materials", () => {
    expect(
      lookMaterialProblem({
        key: "sunset-proscenium/ribs",
        vertexShader: RIB_VERTEX,
        fragmentShader: RIB_FRAGMENT,
      }),
    ).toBeNull();
    expect(
      lookMaterialProblem({ key: "sunset-proscenium/floor", fragmentShader: FLOOR_FRAGMENT }),
    ).toBeNull();
  });

  it("keeps whole rib and step counts", () => {
    expect(look.params.ribs.step).toBe(1);
    expect(look.params.steps.step).toBe(1);
    for (const p of presets) {
      expect(Number.isInteger(p.params?.ribs), p.id).toBe(true);
      expect(Number.isInteger(p.params?.steps), p.id).toBe(true);
    }
  });
});
