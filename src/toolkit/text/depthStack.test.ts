import { describe, expect, it } from "vitest";
import { depthLayers } from "./depthStack";

const identity = (c: string) => c;

describe("depthLayers", () => {
  it("defaults to a dark-to-light stack off the face colour, down and right", () => {
    const layers = depthLayers({}, "#ffffff", 1, identity);
    expect(layers).toHaveLength(12);
    const lum = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
    expect(lum(layers[0].colour)).toBeLessThan(lum(layers[11].colour));
    expect(lum(layers[11].colour)).toBeLessThan(255);
    expect(layers[0].offset[0]).toBeGreaterThan(0);
    expect(layers[0].offset[1]).toBeLessThan(0);
  });

  it("recedes from the face: the deepest is furthest, the nearest one step away", () => {
    const layers = depthLayers({ em: 0.2, angleDeg: 0, layers: 4 }, "#ffffff", 0.5, identity);
    const reach = [0.1, 0.075, 0.05, 0.025];
    layers.forEach((l, i) => {
      expect(l.offset[0]).toBeCloseTo(reach[i]);
    });
    for (const { offset } of layers) expect(offset[2]).toBeLessThan(0);
    expect(layers[0].offset[2]).toBeLessThan(layers[3].offset[2]);
  });

  it("scales its reach with the font size", () => {
    const small = depthLayers({ layers: 1 }, "#ffffff", 0.5, identity)[0].offset[0];
    const large = depthLayers({ layers: 1 }, "#ffffff", 1, identity)[0].offset[0];
    expect(large).toBeCloseTo(small * 2);
  });

  it("keeps a unique index per layer even with no reach", () => {
    const layers = depthLayers({ em: 0, layers: 3 }, "#ffffff", 1, identity);
    expect(layers.map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it("clamps the layer count and resolves colour tokens", () => {
    const resolve = (c: string) => (c === "accent" ? "#102030" : c);
    expect(depthLayers({ layers: 500 }, "#ffffff", 1, identity)).toHaveLength(32);
    expect(depthLayers({ layers: 0 }, "#ffffff", 1, identity)).toHaveLength(1);
    const [only] = depthLayers(
      { layers: 1, dark: "#000000", light: "accent" },
      "#ffffff",
      1,
      resolve,
    );
    expect(only.colour).toBe("#102030");
  });
});
