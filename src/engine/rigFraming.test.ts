import { describe, expect, it } from "vitest";
import {
  type ContentBounds,
  frameContentDistance,
  frameContentPose,
  stagedContentBounds,
} from "./rigFraming";
import type { SceneDocRigPose } from "./sceneDocSchema";

const box = (w: number, h: number, d = 0): ContentBounds => ({
  min: [-w / 2, -h / 2, -d / 2],
  max: [w / 2, h / 2, d / 2],
});

const pose = (over: Partial<SceneDocRigPose> = {}): SceneDocRigPose => ({
  position: [0, 0, 5],
  aim: { mode: "point", at: [0, 0, 0] },
  ...over,
});

describe("frameContentDistance", () => {
  it("pins the distance a known box needs at a known lens", () => {
    // A 4-unit-tall box at fov 45 fits when half its height subtends 22.5 degrees.
    const bare = 2 / Math.tan((22.5 * Math.PI) / 180);
    expect(frameContentDistance(box(1, 4), 45, 16 / 9, 0)).toBeCloseTo(bare, 10);
  });

  it("fits on WIDTH when the box is wider than the frame's aspect", () => {
    const wide = frameContentDistance(box(20, 1), 45, 16 / 9, 0) ?? 0;
    const tall = frameContentDistance(box(1, 20), 45, 16 / 9, 0) ?? 0;
    expect(wide).toBeLessThan(tall); // the frame is wider than it is tall
    expect(wide).toBeGreaterThan(0);
  });

  it("leaves breathing room, and a narrower lens needs more distance", () => {
    const padded = frameContentDistance(box(1, 4), 45, 16 / 9) ?? 0;
    const bare = frameContentDistance(box(1, 4), 45, 16 / 9, 0) ?? 0;
    expect(padded).toBeGreaterThan(bare);
    expect(frameContentDistance(box(1, 4), 20, 16 / 9) ?? 0).toBeGreaterThan(padded);
  });

  it("measures from the box's front face, not its centre", () => {
    const flat = frameContentDistance(box(1, 4), 45, 16 / 9, 0) ?? 0;
    const deep = frameContentDistance(box(1, 4, 6), 45, 16 / 9, 0) ?? 0;
    expect(deep - flat).toBeCloseTo(3, 10);
  });

  it("has no answer for an empty box", () => {
    expect(frameContentDistance(box(0, 0), 45, 16 / 9)).toBeNull();
  });
});

describe("stagedContentBounds", () => {
  const frame = { width: 10, height: 5 };

  it("follows a video window's placement offset, resolved from frame fractions", () => {
    const centred = stagedContentBounds({ videoWindow: {} }, frame);
    const moved = stagedContentBounds({ videoWindow: { offset: [0.25, -0.2] } }, frame);
    expect((moved.min[0] + moved.max[0]) / 2 - (centred.min[0] + centred.max[0]) / 2).toBeCloseTo(
      2.5,
    );
    expect((moved.min[1] + moved.max[1]) / 2 - (centred.min[1] + centred.max[1]) / 2).toBeCloseTo(
      -1,
    );
  });

  it("treats a malformed offset as centred", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the degrade path
    const bad = stagedContentBounds({ videoWindow: { offset: [Number.NaN, 0] as any } }, frame);
    expect(bad).toEqual(stagedContentBounds({ videoWindow: {} }, frame));
  });
});

describe("frameContentPose", () => {
  it("keeps the current view direction and centres the box", () => {
    const angled = pose({ position: [3, 3, 3], aim: { mode: "point", at: [0, 0, 0] } });
    const framed = frameContentPose(box(2, 2), angled, 45, 16 / 9);
    expect(framed).not.toBeNull();
    if (!framed) return;
    expect(framed.aim.at).toEqual([0, 0, 0]);
    // Same direction: the position stays on the ray it was already on.
    const ratio = framed.position[0] / 3;
    expect(framed.position[1] / 3).toBeCloseTo(ratio, 10);
    expect(framed.position[2] / 3).toBeCloseTo(ratio, 10);
  });

  it("frames an off-centre box by moving to it, not by re-angling", () => {
    const framed = frameContentPose({ min: [4, 1, -1], max: [6, 3, 1] }, pose(), 45, 16 / 9);
    expect(framed?.aim.at).toEqual([5, 2, 0]);
  });

  it("falls back to looking down -z when the current pose has no direction", () => {
    const degenerate = pose({ position: [1, 1, 1], aim: { mode: "point", at: [1, 1, 1] } });
    const framed = frameContentPose(box(2, 2), degenerate, 45, 16 / 9);
    expect(framed?.position[2]).toBeGreaterThan(0);
    expect(framed?.position[0]).toBeCloseTo(0, 10);
  });
});
