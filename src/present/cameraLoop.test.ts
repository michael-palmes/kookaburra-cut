import { describe, expect, it } from "vitest";
import { DEFAULT_EASE, ease } from "../engine/ease";
import type { SceneCameraTrack } from "../engine/sceneCamera";
import type { SceneDocCameraKey, SceneDocCameraPose } from "../engine/sceneDocSchema";
import { sampleLoopedSceneCamera } from "./cameraLoop";

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
