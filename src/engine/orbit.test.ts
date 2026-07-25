import { describe, expect, it } from "vitest";
import type { Placement } from "../theme/tokens";
import {
  orbitFromView,
  orbitToView,
  placementPosition,
  placementToOrbit,
  placementToPoint,
} from "./orbit";

describe("orbit <-> view", () => {
  it("azimuth 0 / elevation 0 sits on the target's +Z axis", () => {
    const view = orbitToView({ target: [0, 0, 0], azimuthDeg: 0, elevationDeg: 0, distance: 5 });
    expect(view.position.map((v) => +v.toFixed(6))).toEqual([0, 0, 5]);
  });

  it("round-trips losslessly", () => {
    const pose = {
      target: [1, -2, 3] as [number, number, number],
      azimuthDeg: 37,
      elevationDeg: -12,
      distance: 4.2,
    };
    const view = orbitToView(pose);
    const back = orbitFromView(view.position, pose.target);
    expect(back.azimuthDeg).toBeCloseTo(pose.azimuthDeg, 6);
    expect(back.elevationDeg).toBeCloseTo(pose.elevationDeg, 6);
    expect(back.distance).toBeCloseTo(pose.distance, 6);
  });
});

describe("placement helpers", () => {
  const orbit: Placement = { mode: "orbit", azimuthDeg: 90, elevationDeg: 0, distance: 3 };
  const point: Placement = { mode: "point", position: [3, 0, 0] };

  it("resolves both modes to the same position around an aim point", () => {
    expect(placementPosition(orbit).map((v) => +v.toFixed(6))).toEqual([3, 0, 0]);
    expect(placementPosition(point)).toEqual([3, 0, 0]);
    expect(placementPosition(orbit, [0, 1, 0]).map((v) => +v.toFixed(6))).toEqual([3, 1, 0]);
  });

  it("converts between modes losslessly", () => {
    const asPoint = placementToPoint(orbit);
    expect(asPoint.position.map((v) => +v.toFixed(6))).toEqual([3, 0, 0]);
    const asOrbit = placementToOrbit(asPoint);
    expect(asOrbit.azimuthDeg).toBeCloseTo(90, 6);
    expect(asOrbit.distance).toBeCloseTo(3, 6);
    // Same-mode conversion is the identity.
    expect(placementToOrbit(orbit)).toBe(orbit);
    expect(placementToPoint(point)).toBe(point);
  });
});
