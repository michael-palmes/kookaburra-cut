import { describe, expect, it } from "vitest";
import {
  edgeScrollVelocity,
  elasticX,
  gapCentres,
  gapFromPlacement,
  nearestGap,
  placementFromGap,
  stretchEnd,
} from "./insertMath";

const LAYOUT = { count: 3, cardWidth: 100, gapWidth: 8, padStart: 8 };

describe("gapCentres (start and end are first-class gaps)", () => {
  it("centres every gap on a uniform pitch", () => {
    // Pad 8, cards 100 wide with 8px gaps: gap centres sit 4px before each card edge.
    expect(gapCentres(LAYOUT)).toEqual([4, 112, 220, 328]);
  });

  it("a single scene still has both edge gaps", () => {
    expect(gapCentres({ ...LAYOUT, count: 1 })).toEqual([4, 112]);
  });

  it("an empty strip degrades to one gap", () => {
    expect(gapCentres({ ...LAYOUT, count: 0 })).toEqual([4]);
  });
});

describe("stretchEnd (the end gap parks at the strip's far edge)", () => {
  it("stretches the final centre when the row underfills", () => {
    expect(stretchEnd([4, 112, 220, 328], 500)).toEqual([4, 112, 220, 500]);
  });

  it("keeps the computed centre when it already reaches endX (overflowing strips)", () => {
    const centres = [4, 112, 220, 328];
    expect(stretchEnd(centres, 300)).toBe(centres);
    expect(stretchEnd(centres, 0)).toBe(centres);
  });

  it("degrades on an empty list", () => {
    expect(stretchEnd([], 500)).toEqual([]);
  });
});

describe("nearestGap", () => {
  const centres = gapCentres(LAYOUT);

  it("picks the nearest centre and clamps past the ends", () => {
    expect(nearestGap(-50, centres)).toBe(0);
    expect(nearestGap(60, centres)).toBe(1);
    expect(nearestGap(115, centres)).toBe(1);
    expect(nearestGap(9999, centres)).toBe(3);
  });

  it("ties go to the earlier gap", () => {
    expect(nearestGap(58, centres)).toBe(0);
  });

  it("degrades to 0 on an empty list", () => {
    expect(nearestGap(50, [])).toBe(0);
  });
});

describe("elasticX (the rubber-band curve)", () => {
  const HALF = 54;

  it("holds the centre exactly at the gap", () => {
    expect(elasticX(112, 112, HALF)).toBe(112);
  });

  it("pulls strictly toward the gap inside the half-span", () => {
    for (const d of [5, 20, 40, 53]) {
      const pulled = elasticX(112 + d, 112, HALF);
      expect(pulled).toBeGreaterThan(112);
      expect(pulled).toBeLessThan(112 + d);
    }
  });

  it("is symmetric about the gap", () => {
    const right = elasticX(112 + 30, 112, HALF) - 112;
    const left = 112 - elasticX(112 - 30, 112, HALF);
    expect(right).toBeCloseTo(left, 10);
  });

  it("tracks the pointer exactly at and beyond the half-span", () => {
    expect(elasticX(112 + HALF, 112, HALF)).toBe(112 + HALF);
    expect(elasticX(112 + 200, 112, HALF)).toBe(112 + 200);
  });

  it("is continuous when the nearest gap flips at a midpoint", () => {
    // Centres 112 and 220 (pitch 108): the midpoint maps identically under either gap.
    expect(elasticX(166, 112, HALF)).toBe(166);
    expect(elasticX(166, 220, HALF)).toBe(166);
  });

  it("is monotone, so the indicator never reverses against the pointer", () => {
    let prev = elasticX(112 - HALF, 112, HALF);
    for (let x = 112 - HALF + 1; x <= 112 + HALF; x++) {
      const next = elasticX(x, 112, HALF);
      expect(next).toBeGreaterThan(prev);
      prev = next;
    }
  });

  it("degrades to the gap on a zero half-span", () => {
    expect(elasticX(500, 112, 0)).toBe(112);
  });
});

describe("placement encoding round-trips", () => {
  it("maps edge gaps to start/end and interior gaps to after:<index>", () => {
    expect(placementFromGap(0, 5)).toBe("start");
    expect(placementFromGap(5, 5)).toBe("end");
    expect(placementFromGap(2, 5)).toBe("after:1");
  });

  it("inverts placementFromGap for every gap", () => {
    for (let gap = 0; gap <= 5; gap++) {
      expect(gapFromPlacement(placementFromGap(gap, 5), 5)).toBe(gap);
    }
  });

  it("clamps stale after-indices and degrades junk to the end", () => {
    expect(gapFromPlacement("after:99", 5)).toBe(5);
    expect(gapFromPlacement("after:junk", 5)).toBe(5);
    expect(gapFromPlacement("banana", 5)).toBe(5);
  });

  it("an empty strip resolves everything to end", () => {
    expect(placementFromGap(0, 0)).toBe("end");
    expect(gapFromPlacement("start", 0)).toBe(0);
  });
});

describe("edgeScrollVelocity", () => {
  it("is zero away from the edges", () => {
    expect(edgeScrollVelocity(500, 0, 1000)).toBe(0);
  });

  it("ramps linearly toward each edge and clamps at max speed", () => {
    expect(edgeScrollVelocity(0, 0, 1000)).toBe(-14);
    expect(edgeScrollVelocity(1000, 0, 1000)).toBe(14);
    expect(edgeScrollVelocity(24, 0, 1000)).toBe(-7);
    expect(edgeScrollVelocity(976, 0, 1000)).toBe(7);
    expect(edgeScrollVelocity(-500, 0, 1000)).toBe(-14);
  });

  it("degrades to zero on a zero band", () => {
    expect(edgeScrollVelocity(0, 0, 1000, 0)).toBe(0);
  });
});
