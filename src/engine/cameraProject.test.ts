import { describe, expect, it } from "vitest";
import { clampToStage, projectToStage, viewBasis, worldPerPixel } from "./cameraProject";
import type { CameraPose } from "./cameraTrack";

const STAGE = { width: 1600, height: 900 };
const base: CameraPose = { position: [0, 0, 5], lookAt: [0, 0, 0], fov: 45 };

describe("projectToStage", () => {
  it("puts the look point dead centre", () => {
    const p = projectToStage([0, 0, 0], base, STAGE);
    expect(p.x).toBeCloseTo(800, 9);
    expect(p.y).toBeCloseTo(450, 9);
    expect(p.clipped).toBe(false);
    expect(p.depth).toBeCloseTo(5, 12);
  });

  it("lands a known off-axis point on the frame edge", () => {
    // At depth 5 and fov 45, the half-height is 5·tan(22.5°); a point exactly
    // that high projects to the top of the frame.
    const halfH = 5 * Math.tan((22.5 * Math.PI) / 180);
    expect(projectToStage([0, halfH, 0], base, STAGE).y).toBeCloseTo(0, 9);
    const halfW = halfH * (16 / 9);
    expect(projectToStage([halfW, 0, 0], base, STAGE).x).toBeCloseTo(1600, 9);
  });

  it("aspect moves x, never y", () => {
    const wide = projectToStage([1, 1, 0], base, STAGE, 16 / 9);
    const square = projectToStage([1, 1, 0], base, { width: 900, height: 900 }, 1);
    expect(wide.y / STAGE.height).toBeCloseTo(square.y / 900, 12);
    expect(wide.x / STAGE.width).not.toBeCloseTo(square.x / 900, 3);
  });

  it("reports a point behind the camera as clipped, keeping its lateral side", () => {
    const behind = projectToStage([2, 0, 9], base, STAGE);
    expect(behind.clipped).toBe(true);
    expect(behind.depth).toBeLessThan(0);
    expect(behind.x).toBeGreaterThan(STAGE.width);
    expect(projectToStage([-2, 0, 9], base, STAGE).x).toBeLessThan(0);
  });

  it("roll rotates the projection about the centre", () => {
    const up = projectToStage([0, 1, 0], base, STAGE);
    const rolled = projectToStage([0, 1, 0], { ...base, rollDeg: 90 }, STAGE);
    // A point straight up moves to one side once the camera banks 90 degrees.
    expect(Math.abs(rolled.y - 450)).toBeLessThan(1e-6);
    expect(Math.abs(rolled.x - 800)).toBeGreaterThan(1);
    expect(Math.abs(up.y - 450)).toBeGreaterThan(1);
  });

  it("survives looking straight down, where world up is degenerate", () => {
    const overhead: CameraPose = { position: [0, 6, 0], lookAt: [0, 0, 0], fov: 45 };
    const p = projectToStage([0, 0, 0], overhead, STAGE);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(p.x).toBeCloseTo(800, 9);
  });
});

describe("viewBasis", () => {
  it("is orthonormal with z pointing back along the view", () => {
    const b = viewBasis({ position: [3, 2, 4], lookAt: [0, 0, 0], fov: 50, rollDeg: 17 });
    const len = (v: number[]) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    const dot = (a: number[], c: number[]) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    expect(len(b.x)).toBeCloseTo(1, 12);
    expect(len(b.y)).toBeCloseTo(1, 12);
    expect(len(b.z)).toBeCloseTo(1, 12);
    expect(dot(b.x, b.y)).toBeCloseTo(0, 12);
    expect(dot(b.x, b.z)).toBeCloseTo(0, 12);
    expect(b.z[2]).toBeGreaterThan(0); // camera is at +z looking at the origin
  });
});

describe("worldPerPixel", () => {
  it("scales linearly with depth and inversely with stage height", () => {
    const a = worldPerPixel(base, 900, 5);
    expect(worldPerPixel(base, 900, 10)).toBeCloseTo(a * 2, 12);
    expect(worldPerPixel(base, 1800, 5)).toBeCloseTo(a / 2, 12);
    // A full stage height at the look point spans the visible world height.
    expect(a * 900).toBeCloseTo(2 * 5 * Math.tan((22.5 * Math.PI) / 180), 12);
  });
});

describe("clampToStage", () => {
  it("pulls an off-stage marker back inside the inset", () => {
    const p = clampToStage({ x: -400, y: 2000, clipped: true, depth: -1 }, STAGE, 10);
    expect(p.x).toBe(10);
    expect(p.y).toBe(890);
    expect(p.clipped).toBe(true);
  });
});
