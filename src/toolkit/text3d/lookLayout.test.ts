import { describe, expect, it } from "vitest";
import {
  anchorShift,
  CHROME_ROUGHNESS,
  chromeMaterialParams,
  GLASS_IOR,
  GLASS_ROUGHNESS,
  GLASS_THICKNESS_MAX_EM,
  GLASS_THICKNESS_MIN_EM,
  glassMaterialParams,
} from "./lookLayout";

// A word-ish ink box: x 0..4, y −0.2..1 (descender below the baseline), z −0.01..0.16 (bevel + depth).
const bbox = [0, -0.2, -0.01, 4, 1, 0.16] as const;

const closeTo3 = (
  got: readonly [number, number, number],
  want: readonly [number, number, number],
) => {
  expect(got[0]).toBeCloseTo(want[0]);
  expect(got[1]).toBeCloseTo(want[1]);
  expect(got[2]).toBeCloseTo(want[2]);
};

describe("anchorShift (the troika anchor mapping)", () => {
  it("center/middle centres the ink box (the default anchor contract)", () => {
    closeTo3(anchorShift(bbox, "center", "middle"), [-2, -0.4, -0.075]);
  });

  it("anchorX maps left/right onto the box edges", () => {
    closeTo3(anchorShift(bbox, "left", "middle"), [0, -0.4, -0.075]);
    closeTo3(anchorShift(bbox, "right", "middle"), [-4, -0.4, -0.075]);
  });

  it("anchorY maps top/bottom onto the box edges", () => {
    closeTo3(anchorShift(bbox, "center", "top"), [-2, -1, -0.075]);
    closeTo3(anchorShift(bbox, "center", "bottom"), [-2, 0.2, -0.075]);
  });

  it("always centres the depth axis so the body straddles the flat glyph plane", () => {
    for (const ax of ["left", "center", "right"] as const) {
      for (const ay of ["top", "middle", "bottom"] as const) {
        expect(anchorShift(bbox, ax, ay)[2]).toBeCloseTo(-0.075);
      }
    }
  });
});

describe("3D look material pricing", () => {
  it("glass thickness scales with intensity between the pinned em bounds", () => {
    expect(glassMaterialParams(0, 0.6, "#ffffff").thickness).toBeCloseTo(
      0.6 * GLASS_THICKNESS_MIN_EM,
    );
    expect(glassMaterialParams(1, 0.6, "#ffffff").thickness).toBeCloseTo(
      0.6 * GLASS_THICKNESS_MAX_EM,
    );
    const mid = glassMaterialParams(0.5, 0.6, "#abcdef");
    expect(mid.transmission).toBe(1);
    expect(mid.roughness).toBe(GLASS_ROUGHNESS);
    expect(mid.ior).toBe(GLASS_IOR);
    expect(mid.color).toBe("#abcdef");
  });

  it("chrome is full-metal, low-roughness, colorA-tinted", () => {
    expect(chromeMaterialParams("#ff8800")).toEqual({
      color: "#ff8800",
      metalness: 1,
      roughness: CHROME_ROUGHNESS,
    });
  });
});
