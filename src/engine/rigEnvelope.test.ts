import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEPTH_BANDS } from "../toolkit/stage/DepthStage";
import type { SceneDoc } from "./sceneDocSchema";
import { ENVELOPE_SAMPLES, normalizeSceneRig, OVERSCAN_CAP, rigOverscan } from "./sceneRig";

// The exact 16:9 base frame: what the base camera (z 5, fov 45) sees at the content plane.
const BASE_HEIGHT = 2 * Math.tan((22.5 * Math.PI) / 180) * 5;
const FRAME = { width: BASE_HEIGHT * (16 / 9), height: BASE_HEIGHT };

const track = (raw: NonNullable<SceneDoc["cameraRig"]>) => {
  const t = normalizeSceneRig(raw, "test");
  if (!t) throw new Error("track expected");
  return t;
};

const pose = (
  position: [number, number, number],
  extras: { at?: [number, number, number]; fov?: number; rollDeg?: number } = {},
) => ({
  position,
  aim: { mode: "point" as const, at: extras.at ?? ([0, 0, 0] as [number, number, number]) },
  ...(extras.fov !== undefined ? { fov: extras.fov } : {}),
  ...(extras.rollDeg !== undefined ? { rollDeg: extras.rollDeg } : {}),
});

const twoKeys = (
  a: ReturnType<typeof pose>,
  b: ReturnType<typeof pose>,
): NonNullable<SceneDoc["cameraRig"]> => ({
  keys: [
    { id: "a", tMs: 0, pose: a },
    { id: "b", tMs: 1000, pose: b },
  ],
  segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
});

const still = twoKeys(pose([0, 0, 5]), pose([0, 0, 5]));

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("rigOverscan", () => {
  it("uses a fixed, documented sample count so preview and export can't disagree", () => {
    expect(ENVELOPE_SAMPLES).toBe(64);
  });

  it("a camera parked at the base pose needs exactly the base frame", () => {
    expect(rigOverscan(track(still), FRAME)).toBeCloseTo(1, 6);
  });

  it("reads a lone key without dividing by a zero span", () => {
    const lone = track({ keys: [{ id: "a", tMs: 0, pose: pose([0, 0, 5]) }], segments: [] });
    expect(rigOverscan(lone, FRAME)).toBeCloseTo(1, 6);
  });

  it("travel sideways asks for more", () => {
    const moved = track(
      twoKeys(pose([-3, 0, 5], { at: [-3, 0, 0] }), pose([3, 0, 5], { at: [3, 0, 0] })),
    );
    expect(rigOverscan(moved, FRAME)).toBeGreaterThan(rigOverscan(track(still), FRAME));
  });

  it("a wider lens or a longer pull-back asks for more", () => {
    const wide = track(twoKeys(pose([0, 0, 5], { fov: 80 }), pose([0, 0, 5], { fov: 80 })));
    const far = track(twoKeys(pose([0, 0, 12]), pose([0, 0, 12])));
    expect(rigOverscan(wide, FRAME)).toBeGreaterThan(rigOverscan(track(still), FRAME));
    expect(rigOverscan(far, FRAME)).toBeGreaterThan(rigOverscan(track(still), FRAME));
  });

  it("a banked camera asks for more than the same flight unbanked", () => {
    const flat = track(twoKeys(pose([0, 0, 8]), pose([0, 0, 8])));
    const banked = track(
      twoKeys(pose([0, 0, 8], { rollDeg: 25 }), pose([0, 0, 8], { rollDeg: 25 })),
    );
    expect(rigOverscan(banked, FRAME, -5.5)).toBeGreaterThan(rigOverscan(flat, FRAME, -5.5));
  });

  it("looking off-axis asks for more than looking straight ahead", () => {
    const centred = track(twoKeys(pose([0, 0, 8]), pose([0, 0, 8])));
    const askew = track(
      twoKeys(pose([0, 0, 8], { at: [4, 0, 0] }), pose([0, 0, 8], { at: [4, 0, 0] })),
    );
    expect(rigOverscan(askew, FRAME, -5.5)).toBeGreaterThan(rigOverscan(centred, FRAME, -5.5));
  });

  it("never returns less than the minimum, so a rig can only ask for MORE", () => {
    expect(rigOverscan(track(still), FRAME, 0, 2)).toBe(2);
  });

  it("a band further from the camera needs less than one nearer it", () => {
    const moved = track(
      twoKeys(pose([-2, 0, 5], { at: [-2, 0, 0] }), pose([2, 0, 5], { at: [2, 0, 0] })),
    );
    expect(rigOverscan(moved, FRAME, -5)).toBeGreaterThan(rigOverscan(moved, FRAME, 1.8));
  });

  it("a band the camera crosses stays capped rather than asking for an infinite rect", () => {
    const crossing = track(twoKeys(pose([0, 0, 8]), pose([0, 0, -4], { at: [0, 0, -9] })));
    const factor = rigOverscan(crossing, FRAME, 1.8);
    expect(factor).toBeLessThanOrEqual(OVERSCAN_CAP);
    expect(factor).toBeGreaterThan(1);
  });
});

describe("DEPTH_BANDS", () => {
  it("band depths are pinned (export contract)", () => {
    expect(DEPTH_BANDS).toEqual({ foreground: 1.8, content: 0, midground: -2.4, backdrop: -5.5 });
  });
});
