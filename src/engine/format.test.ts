import { describe, expect, it } from "vitest";
import { fade } from "../toolkit/transitions/fade";
import type { SceneTime } from "../toolkit/types";
import { type AspectName, aspectLabel, computeFormat, FORMATS } from "./format";

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

  it("derives the photographic pair at a 2160 short edge", () => {
    expect(computeFormat(FORMATS["3:2"]).aspect).toBeCloseTo(3 / 2, 5);
    expect(FORMATS["3:2"].height).toBe(2160);
    expect(computeFormat(FORMATS["2:3"]).aspect).toBeCloseTo(2 / 3, 5);
    expect(FORMATS["2:3"].width).toBe(2160);
  });

  it("derives 5:4 as the landscape counterpart of 4:5 at a 2160 short edge", () => {
    expect(computeFormat(FORMATS["5:4"]).aspect).toBeCloseTo(5 / 4, 5);
    expect(FORMATS["5:4"].width).toBe(2700);
    expect(FORMATS["5:4"].height).toBe(2160);
  });

  it("derives the phone pair from the native panel (1206x2622, exactly 437:201)", () => {
    expect(FORMATS.phone.width).toBe(1206);
    expect(FORMATS.phone.height).toBe(2622);
    expect(FORMATS["phone-landscape"].width).toBe(2622);
    expect(FORMATS["phone-landscape"].height).toBe(1206);
    expect(computeFormat(FORMATS.phone).aspect).toBeCloseTo(201 / 437, 5);
    expect(computeFormat(FORMATS["phone-landscape"]).aspect).toBeCloseTo(437 / 201, 5);
  });

  it("labels the phone pair but leaves ratio names alone", () => {
    expect(aspectLabel("phone")).toBe("Phone");
    expect(aspectLabel("phone-landscape")).toBe("Phone Landscape");
    expect(aspectLabel("16:9")).toBe("16:9");
    expect(aspectLabel("4:5")).toBe("4:5");
  });

  it("keeps every aspect id slug-safe once the export path swaps the colon", () => {
    for (const name of Object.keys(FORMATS) as AspectName[]) {
      expect(name.replace(":", "x")).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("keeps a constant visible world HEIGHT across aspects (vertical FOV)", () => {
    const h = computeFormat(FORMATS["16:9"]).frame.height;
    expect(computeFormat(FORMATS["9:16"]).frame.height).toBeCloseTo(h, 5);
    expect(computeFormat(FORMATS["1:1"]).frame.height).toBeCloseTo(h, 5);
    expect(computeFormat(FORMATS["3:2"]).frame.height).toBeCloseTo(h, 5);
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
