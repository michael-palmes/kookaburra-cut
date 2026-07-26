import { describe, expect, it } from "vitest";
import { DEFAULT_EASE, ease } from "../engine/ease";
import type { SceneCameraTrack } from "../engine/sceneCamera";
import type { SceneDocCameraKey, SceneDocCameraPose } from "../engine/sceneDocSchema";
import { normalizeSceneRig, type SceneRigTrack, sampleSceneRig } from "../engine/sceneRig";
import { sampleLoopedSceneCamera, sampleLoopedSceneRig } from "./cameraLoop";

const pose = (azimuthDeg: number): SceneDocCameraPose => ({
  target: [0, 0, 0],
  azimuthDeg,
  elevationDeg: 0,
  distance: 5,
});

function twoKeyTrack(): SceneCameraTrack {
  const k1: SceneDocCameraKey = { id: "k1", tMs: 0, pose: pose(0) };
  const k2: SceneDocCameraKey = { id: "k2", tMs: 1000, pose: pose(10) };
  return { keys: [k1, k2], segments: [{ from: k1, to: k2, ease: "linear" }] };
}

describe("sampleLoopedSceneCamera", () => {
  it("matches the authored sample inside the keyed span", () => {
    expect(sampleLoopedSceneCamera(twoKeyTrack(), 500, { mode: "jump" }).azimuthDeg).toBeCloseTo(5);
    expect(
      sampleLoopedSceneCamera(twoKeyTrack(), 250, { mode: "smooth", blendMs: 500 }).azimuthDeg,
    ).toBeCloseTo(2.5);
  });

  it("jump restarts from the first key each cycle", () => {
    const track = twoKeyTrack();
    expect(sampleLoopedSceneCamera(track, 1000, { mode: "jump" }).azimuthDeg).toBeCloseTo(0);
    expect(sampleLoopedSceneCamera(track, 1500, { mode: "jump" }).azimuthDeg).toBeCloseTo(5);
    expect(sampleLoopedSceneCamera(track, 2000, { mode: "jump" }).azimuthDeg).toBeCloseTo(0);
  });

  it("smooth appends an eased return leg then replays", () => {
    const track = twoKeyTrack();
    const loop = { mode: "smooth" as const, blendMs: 500 };
    // Return leg: last pose back to first over 500ms.
    expect(sampleLoopedSceneCamera(track, 1000, loop).azimuthDeg).toBeCloseTo(10);
    const mid = 10 + (0 - 10) * ease(DEFAULT_EASE, 0.5);
    expect(sampleLoopedSceneCamera(track, 1250, loop).azimuthDeg).toBeCloseTo(mid);
    // Replay: the authored span again.
    expect(sampleLoopedSceneCamera(track, 1500, loop).azimuthDeg).toBeCloseTo(0);
    expect(sampleLoopedSceneCamera(track, 2000, loop).azimuthDeg).toBeCloseTo(5);
    // Wrap of the extended cycle (1000 + 500) lands back on the return leg's start.
    expect(sampleLoopedSceneCamera(track, 2500, loop).azimuthDeg).toBeCloseTo(10);
  });

  it("holds a single-key track unchanged", () => {
    const k1: SceneDocCameraKey = { id: "k1", tMs: 200, pose: pose(7) };
    const track: SceneCameraTrack = { keys: [k1], segments: [] };
    expect(sampleLoopedSceneCamera(track, 0, { mode: "jump" }).azimuthDeg).toBeCloseTo(7);
    expect(sampleLoopedSceneCamera(track, 5000, { mode: "smooth" }).azimuthDeg).toBeCloseTo(7);
  });

  it("keeps segment-less multi-key tracks on the hold rule while looping", () => {
    const k1: SceneDocCameraKey = { id: "k1", tMs: 0, pose: pose(0) };
    const k2: SceneDocCameraKey = { id: "k2", tMs: 1000, pose: pose(10) };
    const track: SceneCameraTrack = { keys: [k1, k2], segments: [] };
    // Jump cycle: held first pose through the span, snapping at the keyed jump.
    expect(sampleLoopedSceneCamera(track, 1500, { mode: "jump" }).azimuthDeg).toBeCloseTo(0);
  });
});

describe("sampleLoopedSceneRig", () => {
  const rigTrack = (): SceneRigTrack => {
    const t = normalizeSceneRig(
      {
        keys: [
          {
            id: "a",
            tMs: 0,
            pose: { position: [-2, 0, 5], aim: { mode: "point", at: [0, 0, 0] } },
          },
          {
            id: "b",
            tMs: 1000,
            pose: { position: [2, 0, 3], aim: { mode: "point", at: [0, 0, 0] } },
          },
        ],
        segments: [{ from: "a", to: "b", ease: "linear", smooth: false }],
      },
      "test",
    );
    if (!t) throw new Error("track expected");
    return t;
  };

  it("play-once: inside the authored span it equals the plain sampler exactly", () => {
    const track = rigTrack();
    for (const t of [0, 250, 500, 999]) {
      expect(sampleLoopedSceneRig(track, t, { mode: "smooth" })).toEqual(sampleSceneRig(track, t));
      expect(sampleLoopedSceneRig(track, t, { mode: "jump" })).toEqual(sampleSceneRig(track, t));
    }
  });

  it("jump restarts from the first key each cycle", () => {
    const track = rigTrack();
    expect(sampleLoopedSceneRig(track, 1000, { mode: "jump" }).position).toEqual([-2, 0, 5]);
    expect(sampleLoopedSceneRig(track, 1500, { mode: "jump" })).toEqual(sampleSceneRig(track, 500));
  });

  it("the smooth return leg lands exactly on the first key's pose", () => {
    const track = rigTrack();
    const blendMs = 400;
    const atEnd = sampleLoopedSceneRig(track, 1000 + blendMs, { mode: "smooth", blendMs });
    expect(atEnd.position[0]).toBeCloseTo(-2, 10);
    expect(atEnd.position[2]).toBeCloseTo(5, 10);
    // Mid-return it is genuinely between the two, not holding either.
    const mid = sampleLoopedSceneRig(track, 1200, { mode: "smooth", blendMs });
    expect(mid.position[0]).toBeGreaterThan(-2);
    expect(mid.position[0]).toBeLessThan(2);
  });

  it("replays the authored span after the return leg", () => {
    const track = rigTrack();
    const blendMs = 400;
    const replay = sampleLoopedSceneRig(track, 1000 + blendMs + 250, { mode: "smooth", blendMs });
    expect(replay).toEqual(sampleSceneRig(track, 250));
  });
});
