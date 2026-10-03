import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { companionLightingProblem } from "../../kit/companion";
import { lookMaterialProblem } from "../../kit/material";
import { presets } from "./index";
import {
  ORIGAMI,
  origamiColumns,
  origamiFold,
  origamiGrid,
  origamiPhase,
  origamiRows,
  origamiSun,
  origamiVertex,
} from "./origami";
import { WALL_FRAGMENT, WALL_VERTEX } from "./shaders";

const TAU = Math.PI * 2;

describe("origami tide wall", () => {
  it("uses an even column count so the depth zigzag closes round the ring", () => {
    for (const r of [10, 13, 17.5, 20]) {
      for (const pleat of [0.5, 0.85, 1.4]) {
        const n = origamiColumns(r, pleat);
        expect(n % 2, `${r} ${pleat}`).toBe(0);
        expect(n).toBeLessThanOrEqual(ORIGAMI.maxColumns);
      }
    }
    expect(origamiColumns(13, 0.85)).toBe(96);
  });

  it("closes the seam at every fold and spans the foot to the wall top", () => {
    const n = origamiColumns(13, 0.85);
    const { rows, pitch } = origamiRows(6.8, 0.85);
    expect(rows).toBe(12);
    expect(ORIGAMI.bottom + rows * pitch).toBeCloseTo(6.8, 9);
    for (const f of [0, 0.5, 1]) {
      for (const j of [0, 1, rows]) {
        const a = origamiVertex(0, j, f, 13, 0.85, pitch, n);
        const b = origamiVertex(n, j, f, 13, 0.85, pitch, n);
        for (let k = 0; k < 3; k++) expect(b[k]).toBeCloseTo(a[k], 9);
      }
    }
    expect(origamiRows(99, 0.5).rows).toBeLessThanOrEqual(ORIGAMI.maxRows);
  });

  it("winds every cell to face the stage axis", () => {
    const n = origamiColumns(13, 0.85);
    const { pitch } = origamiRows(6.8, 0.85);
    const { ij, index } = origamiGrid(n, 2);
    expect(index.length).toBe(n * 2 * 6);
    const p = (v: number) =>
      new Vector3(...origamiVertex(ij[v * 2], ij[v * 2 + 1], 0, 13, 0.85, pitch, n));
    for (let t = 0; t < index.length; t += 6 * 7) {
      const a = p(index[t]);
      const normal = p(index[t + 1])
        .sub(a)
        .cross(p(index[t + 2]).sub(a));
      expect(normal.dot(new Vector3(-a.x, 0, -a.z)), `${t}`).toBeGreaterThan(0);
    }
  });

  it("folds deeper as the tide rises", () => {
    const n = origamiColumns(13, 0.85);
    const { pitch } = origamiRows(6.8, 0.85);
    const depth = (f: number) =>
      13 - Math.hypot(...origamiVertex(1, 4, f, 13, 0.85, pitch, n).filter((_, k) => k !== 1));
    expect(depth(0)).toBeCloseTo(0, 9);
    expect(depth(1)).toBeGreaterThan(0.75);
  });
});

describe("origami tide motion", () => {
  it("loops exactly, wraps seamlessly in angle and stays in 0..1", () => {
    for (const phi of [0, 1.1, 3.4, 5.9]) {
      for (const y of [-2, 1, 5]) {
        expect(origamiFold(phi, y, 1, 0.8)).toBeCloseTo(origamiFold(phi, y, 0, 0.8), 9);
        expect(origamiFold(phi + TAU, y, 0.3, 0.8)).toBeCloseTo(origamiFold(phi, y, 0.3, 0.8), 9);
        const f = origamiFold(phi, y, 0.37, 1);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
    expect(origamiPhase(120 * 4 + 30, 120)).toBeCloseTo(0.25, 12);
  });

  it("passes visible chevrons at a point within a few seconds", () => {
    let swing = 0;
    const base = origamiFold(2, 3, 0, 0.8);
    for (let s = 0; s <= 5; s += 0.5) {
      swing = Math.max(swing, Math.abs(origamiFold(2, 3, origamiPhase(s, 120), 0.8) - base));
    }
    expect(swing).toBeGreaterThan(0.1);
  });

  it("rakes the sun from +x, swaying either side", () => {
    const v = new Vector3();
    origamiSun(0, 30, v);
    expect(v.length()).toBeCloseTo(1, 12);
    expect(v.z).toBeCloseTo(0, 12);
    expect(v.x).toBeGreaterThan(0.8);
    origamiSun(0.25, 30, v);
    expect(Math.atan2(v.x, v.z)).toBeCloseTo(((90 + 30) * Math.PI) / 180, 9);
  });
});

describe("origami tide presets", () => {
  it("carry a cheap companion key at the virtual sun's mean seat", () => {
    for (const p of presets) {
      expect(companionLightingProblem(p.lighting ?? {}), p.id).toBeNull();
      expect(p.lighting?.sun?.azimuthDeg, p.id).toBe(ORIGAMI.sunAzimuthDeg);
      expect(p.lighting?.sun?.elevationDeg, p.id).toBe(ORIGAMI.sunElevationDeg);
    }
  });

  it("build a sound look material", () => {
    expect(
      lookMaterialProblem({
        key: "origami-tide/wall",
        vertexShader: WALL_VERTEX,
        fragmentShader: WALL_FRAGMENT,
      }),
    ).toBeNull();
  });
});
