import { describe, expect, it } from "vitest";
import { type SharedKeyframe, sampleSharedTransform } from "./sharedElement";

describe("sampleSharedTransform — pure morph-transform sampling", () => {
  const track: SharedKeyframe[] = [
    { tMs: 0, position: [-1, 0, 0], scale: 0.5, opacity: 0 },
    { tMs: 1000, position: [1, 0, 0], scale: 1, opacity: 1 },
  ];

  it("returns the identity base for an empty track", () => {
    expect(sampleSharedTransform([], 500)).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      opacity: 1,
    });
  });

  it("lerps every keyed property between surrounding keys", () => {
    const mid = sampleSharedTransform(track, 500);
    expect(mid.position).toEqual([0, 0, 0]);
    expect(mid.scale).toBe(0.75);
    expect(mid.opacity).toBe(0.5);
  });

  it("clamps outside the keyed range", () => {
    expect(sampleSharedTransform(track, -50).position).toEqual([-1, 0, 0]);
    expect(sampleSharedTransform(track, 9999).opacity).toBe(1);
  });

  it("interpolates properties independently (a key omitting one is transparent to it)", () => {
    const t: SharedKeyframe[] = [
      { tMs: 0, opacity: 0, rotation: [0, 0, 0] },
      { tMs: 500, position: [5, 0, 0] }, // no opacity/rotation, must not reset them
      { tMs: 1000, opacity: 1, rotation: [0, Math.PI, 0] },
    ];
    const mid = sampleSharedTransform(t, 500);
    expect(mid.opacity).toBe(0.5);
    expect(mid.rotation).toEqual([0, Math.PI / 2, 0]);
    expect(mid.position).toEqual([5, 0, 0]);
  });

  it("falls back to the base for properties no key defines", () => {
    const posOnly: SharedKeyframe[] = [{ tMs: 0, position: [2, 2, 2] }];
    const out = sampleSharedTransform(posOnly, 100);
    expect(out.scale).toBe(1);
    expect(out.opacity).toBe(1);
    expect(out.rotation).toEqual([0, 0, 0]);
  });

  it("is pure and does not mutate the track", () => {
    const unsorted: SharedKeyframe[] = [
      { tMs: 1000, scale: 2 },
      { tMs: 0, scale: 1 },
    ];
    expect(sampleSharedTransform(unsorted, 500).scale).toBe(1.5);
    expect(unsorted[0].tMs).toBe(1000);
    expect(sampleSharedTransform(track, 250)).toEqual(sampleSharedTransform(track, 250));
  });
});
