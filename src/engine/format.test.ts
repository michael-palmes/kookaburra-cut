import { describe, expect, it } from "vitest";
import { fade } from "../toolkit/transitions/fade";
import type { SceneTime } from "../toolkit/types";
import { computeFormat, FORMATS } from "./format";

const at = (localMs: number): SceneTime => ({ localMs, globalMs: localMs, progress: 0 });

describe("computeFormat", () => {
  it("derives a 16:9 aspect for the 4K landscape format", () => {
    const info = computeFormat(FORMATS["16:9"]);
    expect(info.width).toBe(3840);
    expect(info.height).toBe(2160);
    expect(info.aspect).toBeCloseTo(16 / 9, 5);
  });

  it("derives a portrait aspect (< 1) for 9:16", () => {
    expect(computeFormat(FORMATS["9:16"]).aspect).toBeLessThan(1);
  });

  it("derives a square aspect for 1:1", () => {
    expect(computeFormat(FORMATS["1:1"]).aspect).toBeCloseTo(1, 5);
  });

  it("keeps a constant visible world HEIGHT across aspects (vertical FOV)", () => {
    const h = computeFormat(FORMATS["16:9"]).frame.height;
    expect(computeFormat(FORMATS["9:16"]).frame.height).toBeCloseTo(h, 5);
    expect(computeFormat(FORMATS["1:1"]).frame.height).toBeCloseTo(h, 5);
  });

  it("scales the visible world WIDTH with aspect", () => {
    const wide = computeFormat(FORMATS["16:9"]).frame.width;
    const tall = computeFormat(FORMATS["9:16"]).frame.width;
    expect(wide).toBeGreaterThan(tall);
    expect(computeFormat(FORMATS["16:9"]).frame.width).toBeCloseTo(
      computeFormat(FORMATS["16:9"]).frame.height * (16 / 9),
      4,
    );
  });

  it("exposes positive, equal world-space safe insets", () => {
    const { safe } = computeFormat(FORMATS["9:16"]);
    expect(safe.top).toBeGreaterThan(0);
    expect(safe.top).toBeCloseTo(safe.bottom, 6);
    expect(safe.left).toBeCloseTo(safe.right, 6);
  });
});

describe("fade — determinism contract", () => {
  it("is a pure function of time (same input → identical output)", () => {
    expect(fade(at(250), [0, 500])).toEqual(fade(at(250), [0, 500]));
  });

  it("clamps to [0, 1] outside the range", () => {
    expect(fade(at(-100), [0, 500]).opacity).toBe(0);
    expect(fade(at(999), [0, 500]).opacity).toBe(1);
    expect(fade(at(250), [0, 500]).opacity).toBeCloseTo(0.5, 5);
  });
});
