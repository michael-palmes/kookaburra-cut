import { describe, expect, it } from "vitest";
import { collectParseWarnings } from "../engine/parseWarnings";
import { parseSatinBackdrop } from "./satinBackdrop";
import { parseBackdropSpec } from "./schema";

const FULL = {
  type: "satin",
  color: "#3A2C22",
  roughness: 0.32,
  specular: 0.6,
  centre: [-2, 0.3],
  fade: [3, 11],
  reflection: { strength: 0.7, blur: 30, heightBlur: 0.6, contact: 0.55 },
  glitter: {
    scale: 30,
    density: 0.2,
    roughness: 0.15,
    tilt: 0.5,
    weight: 0.8,
    grain: 0.6,
    seed: 5,
  },
  pools: [
    { at: [-2.6, 0.9], radius: [0.9, 0.35], angleDeg: -20, color: "#ffb070", intensity: 0.15 },
  ],
};

describe("parseSatinBackdrop", () => {
  it("keeps a full block and round-trips through the backdrop parser", () => {
    const once = parseBackdropSpec(FULL, "t");
    expect(once?.type === "satin" && once.color).toBe("#3a2c22");
    expect(once?.type === "satin" && once.pools?.[0]?.angleDeg).toBe(-20);
    expect(parseBackdropSpec(once, "t")).toEqual(once);
  });

  it("clamps numbers and keeps only what was authored", () => {
    expect(
      parseSatinBackdrop({ color: "#000000", roughness: 9, reflection: { blur: -4 } }, "t"),
    ).toEqual({ type: "satin", color: "#000000", roughness: 1, reflection: { blur: 0 } });
  });

  it("drops malformed pieces but keeps the floor", () => {
    expect(
      parseSatinBackdrop(
        {
          color: "#101010",
          fade: [8, 2],
          reflection: "on",
          pools: [{ at: [0, 0], radius: [0, 1], color: "#ffffff", intensity: 1 }],
        },
        "t",
      ),
    ).toEqual({ type: "satin", color: "#101010" });
  });

  it("turns the reflection off, caps pools at four and needs a hex colour", () => {
    const pool = { at: [0, 0], radius: [1, 1], color: "#ffffff", intensity: 1 };
    const v = parseSatinBackdrop(
      { color: "#101010", reflection: false, pools: Array(6).fill(pool) },
      "t",
    );
    expect(v?.reflection).toBe(false);
    expect(v?.pools).toHaveLength(4);
    expect(parseSatinBackdrop({ color: "walnut" }, "t")).toBeUndefined();
    expect(parseSatinBackdrop({ color: "#FFF" }, "t")?.color).toBe("#fff");
  });

  it("keeps the soft shadow and the rough reflection, clamped", () => {
    const v = parseSatinBackdrop(
      {
        color: "#101010",
        reflection: { stretch: 3, scatter: 99, reach: 3 },
        shadow: { spread: 0.14, lighten: 2, reach: 5, contact: 0.5 },
      },
      "t",
    );
    expect(v?.reflection).toEqual({ stretch: 3, scatter: 40, reach: 3 });
    expect(v?.shadow).toEqual({ spread: 0.14, lighten: 1, reach: 5, contact: 0.5 });
    expect(parseSatinBackdrop(v as unknown as Record<string, unknown>, "t")).toEqual(v);
    expect(parseSatinBackdrop({ color: "#101010", shadow: 3 }, "t")?.shadow).toBeUndefined();
  });

  it("warns in the house spelling", () => {
    const { warnings } = collectParseWarnings(() => {
      parseSatinBackdrop({ color: "walnut" }, "t");
      parseSatinBackdrop({ color: "#101010", pools: [{ at: [0, 0] }] }, "t");
    });
    expect(warnings).toEqual([
      "[theme] t: a satin backdrop needs a hex colour, dropped",
      "[theme] t: a satin pool needs at, radius, a hex colour and intensity, dropped",
    ]);
  });
});
