import { describe, expect, it } from "vitest";
import type { SceneDocRigPose } from "./sceneDocSchema";
import {
  forwardRigPose,
  LOOK_PITCH_LIMIT,
  lookRigPose,
  MIN_AIM_DISTANCE,
  moveRigPose,
  rigBasis,
  rigWorldPerPixel,
  TILT_DEG_PER_STAGE,
  tiltRigPose,
} from "./sceneRigEdit";

const STAGE_W = 1600;
const STAGE_H = 900;
const FOV = 45;

const pose = (over: Partial<SceneDocRigPose> = {}): SceneDocRigPose => ({
  position: [0, 0, 5],
  aim: { mode: "point", at: [0, 0, 0] },
  ...over,
});

const dist = (p: SceneDocRigPose) => rigBasis(p).distance;

describe("rigBasis", () => {
  it("builds a right-handed basis for the default look direction", () => {
    const b = rigBasis(pose());
    expect(b.forward[2]).toBeCloseTo(-1, 12);
    expect(b.right[0]).toBeCloseTo(1, 12);
    expect(b.up[1]).toBeCloseTo(1, 12);
    expect(b.distance).toBeCloseTo(5, 12);
  });

  it("survives looking straight down, where world up is degenerate", () => {
    const b = rigBasis(pose({ position: [0, 5, 0], aim: { mode: "point", at: [0, 0, 0] } }));
    expect(b.forward[1]).toBeCloseTo(-1, 12);
    expect(Number.isFinite(b.right[0])).toBe(true);
    expect(b.right[0] ** 2 + b.right[1] ** 2 + b.right[2] ** 2).toBeCloseTo(1, 12);
  });
});

describe("rigWorldPerPixel", () => {
  it("spans the visible world height across the stage", () => {
    const perPx = rigWorldPerPixel(pose(), FOV, STAGE_H);
    expect(perPx * STAGE_H).toBeCloseTo(2 * 5 * Math.tan((22.5 * Math.PI) / 180), 12);
  });
});

describe("moveRigPose", () => {
  it("is grab-style: dragging right slides the camera left", () => {
    const next = moveRigPose(pose(), 100, 0, FOV, STAGE_H);
    expect(next.position[0]).toBeLessThan(0);
    expect(next.position[0]).toBeCloseTo(-100 * rigWorldPerPixel(pose(), FOV, STAGE_H), 12);
  });

  it("holds a point aim, so moving reframes", () => {
    const next = moveRigPose(pose(), 120, -40, FOV, STAGE_H);
    expect(next.aim.at).toEqual([0, 0, 0]);
  });

  it("carries a tangent aim along, because it has no fixed target", () => {
    const next = moveRigPose(
      pose({ aim: { mode: "tangent", at: [0, 0, 0] } }),
      120,
      0,
      FOV,
      STAGE_H,
    );
    expect(next.aim.at[0]).toBeCloseTo(next.position[0], 12);
  });
});

describe("forwardRigPose", () => {
  it("dollies exponentially: equal drags scale the distance equally", () => {
    const a = forwardRigPose(pose(), 150, STAGE_H);
    const b = forwardRigPose(a, 150, STAGE_H);
    expect(dist(a) / 5).toBeCloseTo(dist(b) / dist(a), 10);
  });

  it("dragging down pulls back, dragging up pushes in", () => {
    expect(dist(forwardRigPose(pose(), 200, STAGE_H))).toBeGreaterThan(5);
    expect(dist(forwardRigPose(pose(), -200, STAGE_H))).toBeLessThan(5);
  });

  it("stops at the aim-distance floor rather than passing through the subject", () => {
    const next = forwardRigPose(pose(), -100000, STAGE_H);
    expect(dist(next)).toBeCloseTo(MIN_AIM_DISTANCE, 10);
  });

  it("holds a point aim but carries a tangent one", () => {
    expect(forwardRigPose(pose(), 100, STAGE_H).aim.at).toEqual([0, 0, 0]);
    const tangent = forwardRigPose(pose({ aim: { mode: "tangent", at: [0, 0, 0] } }), 100, STAGE_H);
    expect(tangent.aim.at[2]).not.toBeCloseTo(0, 6);
  });
});

describe("lookRigPose", () => {
  it("swings the aim without moving the camera, and keeps its distance", () => {
    const next = lookRigPose(pose(), 200, 0, STAGE_W, STAGE_H);
    expect(next.position).toEqual([0, 0, 5]);
    expect(dist(next)).toBeCloseTo(5, 10);
    expect(next.aim.at[0]).not.toBeCloseTo(0, 6);
  });

  it("clamps pitch, so the horizon can never flip", () => {
    const next = lookRigPose(pose(), 0, -100000, STAGE_W, STAGE_H);
    const elevation = (Math.asin(rigBasis(next).forward[1]) * 180) / Math.PI;
    expect(elevation).toBeCloseTo(LOOK_PITCH_LIMIT, 6);
  });

  it("rewrites a tangent or object aim to a point (the deliberate visible consequence)", () => {
    expect(
      lookRigPose(pose({ aim: { mode: "tangent", at: [0, 0, 0] } }), 50, 0, STAGE_W, STAGE_H).aim
        .mode,
    ).toBe("point");
    expect(
      lookRigPose(
        pose({ aim: { mode: "object", id: "d", at: [0, 0, 0] } }),
        50,
        0,
        STAGE_W,
        STAGE_H,
      ).aim.mode,
    ).toBe("point");
  });
});

describe("tiltRigPose", () => {
  it("banks a documented amount across the stage width", () => {
    expect(tiltRigPose(pose(), STAGE_W, STAGE_W).rollDeg).toBeCloseTo(TILT_DEG_PER_STAGE, 12);
    expect(tiltRigPose(pose({ rollDeg: 10 }), STAGE_W / 2, STAGE_W).rollDeg).toBeCloseTo(
      10 + TILT_DEG_PER_STAGE / 2,
      12,
    );
  });

  it("clamps to a half turn each way", () => {
    expect(tiltRigPose(pose(), STAGE_W * 10, STAGE_W).rollDeg).toBe(180);
    expect(tiltRigPose(pose(), STAGE_W * -10, STAGE_W).rollDeg).toBe(-180);
  });

  it("drops the field when the bank lands back on zero", () => {
    const rolled = pose({ rollDeg: TILT_DEG_PER_STAGE });
    expect(tiltRigPose(rolled, -STAGE_W, STAGE_W).rollDeg).toBeUndefined();
  });
});
