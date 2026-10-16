import { describe, expect, it, vi } from "vitest";
import type { CameraPose } from "./cameraTrack";
import { normalizeSceneCamera, sceneCameraTracks } from "./sceneCamera";
import { normalizeSceneRig } from "./sceneRig";
import {
  adaptiveSampleCount,
  cameraBreaks,
  cameraTravel,
  clampSampleMs,
  SHUTTER_SAMPLES_MAX,
  shutterUnitOffsets,
  shutterWindowMs,
} from "./shutter";

const pose = (azimuthDeg: number) => ({
  target: [0, 0, 0] as [number, number, number],
  azimuthDeg,
  elevationDeg: 0,
  distance: 5,
});

const orbitTracks = (segments: { from: string; to: string; ease: string }[]) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const orbit = normalizeSceneCamera(
    {
      keys: [
        { id: "a", tMs: 0, pose: pose(0) },
        { id: "b", tMs: 1000, pose: pose(30) },
        { id: "c", tMs: 2000, pose: pose(60) },
        { id: "d", tMs: 3000, pose: pose(90) },
      ],
      segments,
    },
    "test",
  );
  return sceneCameraTracks(orbit, null);
};

describe("shutterWindowMs", () => {
  it("is the shutter's share of the frame interval", () => {
    expect(shutterWindowMs(180, 60)).toBeCloseTo(1000 / 120);
    expect(shutterWindowMs(360, 30)).toBeCloseTo(1000 / 30);
    expect(shutterWindowMs(90, 60)).toBeCloseTo(1000 / 240);
  });

  it("clamps the angle and refuses bad input", () => {
    expect(shutterWindowMs(720, 60)).toBe(shutterWindowMs(360, 60));
    expect(shutterWindowMs(-10, 60)).toBe(0);
    expect(shutterWindowMs(Number.NaN, 60)).toBe(0);
    expect(shutterWindowMs(180, 0)).toBe(0);
  });
});

describe("shutterUnitOffsets", () => {
  it("is stratified, centred and symmetric", () => {
    expect(shutterUnitOffsets(4)).toEqual([-0.375, -0.125, 0.125, 0.375]);
    const eight = shutterUnitOffsets(8);
    expect(eight).toHaveLength(8);
    expect(eight.reduce((s, u) => s + u, 0)).toBe(0);
    expect(Math.min(...eight)).toBeGreaterThan(-0.5);
    expect(Math.max(...eight)).toBeLessThan(0.5);
  });

  it("degrades to one centred sample", () => {
    expect(shutterUnitOffsets(0)).toEqual([0]);
    expect(shutterUnitOffsets(1)).toEqual([0]);
  });
});

describe("cameraBreaks", () => {
  it("finds jump ends and keys no segment reaches", () => {
    const tracks = orbitTracks([
      { from: "a", to: "b", ease: "linear" },
      { from: "b", to: "c", ease: "jump" },
    ]);
    // c is a jump end; d is held-switched (no segment reaches it).
    expect(cameraBreaks(tracks)).toEqual([2000, 3000]);
  });

  it("has none for a continuous track or no track", () => {
    const tracks = orbitTracks([
      { from: "a", to: "b", ease: "linear" },
      { from: "b", to: "c", ease: "inOutQuad" },
      { from: "c", to: "d", ease: "outCubic" },
    ]);
    expect(cameraBreaks(tracks)).toEqual([]);
    expect(cameraBreaks(null)).toEqual([]);
  });

  it("treats any jumping rig channel as a break", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const key = (id: string, tMs: number, x: number) => ({
      id,
      tMs,
      pose: {
        position: [x, 0, 5] as [number, number, number],
        aim: { mode: "point" as const, at: [0, 0, 0] as [number, number, number] },
      },
    });
    const rig = normalizeSceneRig(
      {
        keys: [key("a", 0, 0), key("b", 1000, 1), key("c", 2000, 2)],
        segments: [
          { from: "a", to: "b", ease: "linear" },
          { from: "b", to: "c", ease: "linear", easeRotation: "jump" },
        ],
      },
      "test",
    );
    expect(cameraBreaks(sceneCameraTracks(null, rig))).toEqual([2000]);
  });
});

describe("clampSampleMs", () => {
  it("holds samples inside the scene", () => {
    expect(clampSampleMs(2, -4, 1000, [])).toBe(0);
    expect(clampSampleMs(998, 1004, 1000, [])).toBe(1000);
    expect(clampSampleMs(500, 503, 1000, [])).toBe(503);
  });

  it("never samples across a break", () => {
    // Centre before the break: later samples stop just short of it.
    const before = clampSampleMs(998, 1003, 5000, [1000]);
    expect(before).toBeLessThan(1000);
    expect(before).toBeGreaterThan(999.99);
    // Centre on or after the break: earlier samples stop on it.
    expect(clampSampleMs(1000, 996, 5000, [1000])).toBe(1000);
    expect(clampSampleMs(1003, 997, 5000, [1000])).toBe(1000);
    // A break outside the window changes nothing.
    expect(clampSampleMs(500, 504, 5000, [1000])).toBe(504);
  });
});

describe("cameraTravel", () => {
  const at = (lookAt: [number, number, number], position: [number, number, number] = [0, 0, 6]) =>
    ({ position, lookAt, fov: 45 }) as CameraPose;
  const centre = at([0, 0, 0]);

  it("is zero for a camera that holds", () => {
    expect(cameraTravel(centre, centre, centre, 16 / 9)).toBe(0);
  });

  it("measures a pan in frame heights", () => {
    // A 1 degree pan moves the frame centre about 0.021 frame heights at fov 45; the probe grid's edges move a little more.
    const pan = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return at([6 * Math.sin(r), 0, 6 - 6 * Math.cos(r)]);
    };
    const travel = cameraTravel(pan(-0.5), pan(0.5), centre, 16 / 9);
    expect(travel).toBeGreaterThan(0.021);
    expect(travel).toBeLessThan(0.03);
  });

  it("sees a push-in through the off-centre probes", () => {
    const travel = cameraTravel(at([0, 0, 0], [0, 0, 6.1]), at([0, 0, 0], [0, 0, 5.9]), centre, 1);
    expect(travel).toBeGreaterThan(0);
  });
});

describe("adaptiveSampleCount", () => {
  it("keeps the floor until copies would separate, then caps", () => {
    expect(adaptiveSampleCount(0, 8)).toBe(8);
    expect(adaptiveSampleCount(0.01, 8)).toBe(8);
    expect(adaptiveSampleCount(0.05, 8)).toBe(25);
    expect(adaptiveSampleCount(0.01, 16)).toBe(16);
    expect(adaptiveSampleCount(1, 4)).toBe(SHUTTER_SAMPLES_MAX);
    expect(adaptiveSampleCount(Number.NaN, 4)).toBe(4);
  });
});
