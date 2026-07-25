import { describe, expect, it } from "vitest";
import { kelvinToHex, kelvinToSrgb } from "./kelvin";

/** GOLDEN VALUES: the Kelvin fit is export contract (a drift here rebases every kelvin-lit project). If these fail, the fit changed; that is a deliberate rebase, never a refactor. */
const GOLDEN: [number, [number, number, number], string][] = [
  [1000, [1, 0.266355, 0], "#ff4400"],
  [2700, [1, 0.653804, 0.342767], "#ffa757"],
  [4200, [1, 0.826155, 0.686357], "#ffd3af"],
  [5000, [1, 0.894167, 0.80757], "#ffe4ce"],
  [6500, [1, 0.99651, 0.980557], "#fffefa"],
  [10000, [0.790997, 0.855179, 1], "#cadaff"],
  [20000, [0.669426, 0.777986, 1], "#abc6ff"],
];

describe("kelvinToSrgb (Tanner Helland fit, pinned)", () => {
  it.each(GOLDEN)("%d K", (kelvin, triple, hex) => {
    const [r, g, b] = kelvinToSrgb(kelvin);
    expect(r).toBeCloseTo(triple[0], 6);
    expect(g).toBeCloseTo(triple[1], 6);
    expect(b).toBeCloseTo(triple[2], 6);
    expect(kelvinToHex(kelvin)).toBe(hex);
  });

  it("clamps outside the authoring range", () => {
    expect(kelvinToSrgb(200)).toEqual(kelvinToSrgb(1000));
    expect(kelvinToSrgb(50000)).toEqual(kelvinToSrgb(20000));
  });

  it("warm is red-heavy, cool is blue-heavy", () => {
    const warm = kelvinToSrgb(2700);
    const cool = kelvinToSrgb(10000);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });
});
