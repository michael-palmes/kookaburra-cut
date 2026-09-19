import { describe, expect, it } from "vitest";
import { clampFoldDeg, foldCentreOffset, foldVisibleWidth } from "./foldPose";

const fold = { openDeg: 180, anchorSide: 1 as const, halfWidth: 2 };

describe("fold geometry", () => {
  it("clamps an overshooting ease to the hinge's travel", () => {
    expect(clampFoldDeg(fold, -12)).toBe(0);
    expect(clampFoldDeg(fold, 194)).toBe(180);
    expect(clampFoldDeg(fold, 120)).toBe(120);
  });

  it("centres the hinge when open and the single panel when closed", () => {
    expect(foldCentreOffset(fold, 180)).toBeCloseTo(0, 12);
    // Closed, the device covers only the camera half (+x), so it shifts half a panel back.
    expect(foldCentreOffset(fold, 0)).toBeCloseTo(-1, 12);
    expect(foldCentreOffset({ ...fold, anchorSide: -1 }, 0)).toBeCloseTo(1, 12);
  });

  it("moves monotonically and without a kink through square", () => {
    const at = (deg: number) => foldCentreOffset(fold, deg);
    for (let deg = 0; deg < 180; deg++) expect(at(deg + 1)).toBeGreaterThan(at(deg));
    const slopeBefore = at(90) - at(89);
    const slopeAfter = at(91) - at(90);
    expect(Math.abs(slopeAfter - slopeBefore)).toBeLessThan(1e-3);
  });

  it("shows one panel until the cover passes square, then both", () => {
    expect(foldVisibleWidth(fold, 0)).toBe(2);
    expect(foldVisibleWidth(fold, 90)).toBeCloseTo(2, 12);
    expect(foldVisibleWidth(fold, 180)).toBeCloseTo(4, 12);
  });
});
