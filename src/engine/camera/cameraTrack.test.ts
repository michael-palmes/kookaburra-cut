import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import {
  applyCameraTrack,
  baseCameraPose,
  type CameraKeyframe,
  sampleCameraTrack,
} from "./cameraTrack";

describe("sampleCameraTrack — pure keyframe sampling", () => {
  const dolly: CameraKeyframe[] = [
    { tMs: 0, position: [0, 0, 6] },
    { tMs: 1000, position: [0, 0, 5] },
  ];

  it("returns the base pose for an empty track", () => {
    expect(sampleCameraTrack([], 500)).toEqual(baseCameraPose());
  });

  it("lerps position linearly between surrounding keys", () => {
    expect(sampleCameraTrack(dolly, 0).position).toEqual([0, 0, 6]);
    expect(sampleCameraTrack(dolly, 250).position).toEqual([0, 0, 5.75]);
    expect(sampleCameraTrack(dolly, 500).position).toEqual([0, 0, 5.5]);
    expect(sampleCameraTrack(dolly, 1000).position).toEqual([0, 0, 5]);
  });

  it("clamps before the first and after the last key", () => {
    expect(sampleCameraTrack(dolly, -100).position).toEqual([0, 0, 6]);
    expect(sampleCameraTrack(dolly, 99999).position).toEqual([0, 0, 5]);
  });

  it("is a pure function of (track, t) — repeated samples are identical", () => {
    expect(sampleCameraTrack(dolly, 333)).toEqual(sampleCameraTrack(dolly, 333));
  });

  it("does not mutate the track (sorts a copy)", () => {
    const unsorted: CameraKeyframe[] = [
      { tMs: 1000, fov: 50 },
      { tMs: 0, fov: 40 },
    ];
    expect(sampleCameraTrack(unsorted, 500).fov).toBe(45);
    expect(unsorted[0].tMs).toBe(1000); // input order untouched
  });

  it("interpolates each property independently across the keys that define it", () => {
    // fov is only keyed at 0 and 2000; the position-only key at 1000 must be transparent to it.
    const track: CameraKeyframe[] = [
      { tMs: 0, fov: 40, position: [0, 0, 6] },
      { tMs: 1000, position: [0, 0, 5] },
      { tMs: 2000, fov: 50 },
    ];
    const mid = sampleCameraTrack(track, 1000);
    expect(mid.fov).toBe(45); // halfway 40→50, NOT reset by the position-only key
    expect(mid.position).toEqual([0, 0, 5]);
  });

  it("falls back to the base pose for properties no key defines", () => {
    const fovOnly: CameraKeyframe[] = [{ tMs: 0, fov: 30 }];
    const pose = sampleCameraTrack(fovOnly, 500);
    expect(pose.fov).toBe(30);
    expect(pose.position).toEqual(baseCameraPose().position);
    expect(pose.lookAt).toEqual(baseCameraPose().lookAt);
  });

  it("holds a single key's value at every time", () => {
    const single: CameraKeyframe[] = [{ tMs: 500, fov: 30 }];
    expect(sampleCameraTrack(single, 0).fov).toBe(30);
    expect(sampleCameraTrack(single, 500).fov).toBe(30);
    expect(sampleCameraTrack(single, 5000).fov).toBe(30);
  });

  it("lerps lookAt like position", () => {
    const track: CameraKeyframe[] = [
      { tMs: 0, lookAt: [0, 0, 0] },
      { tMs: 1000, lookAt: [1, 0, 0] },
    ];
    expect(sampleCameraTrack(track, 500).lookAt).toEqual([0.5, 0, 0]);
  });
});

describe("applyCameraTrack — the shared-seam write", () => {
  it("is a hard no-op without a track (the v0–v2 safety invariant)", () => {
    const cam = new PerspectiveCamera(45, 16 / 9);
    cam.position.set(1, 2, 3);
    const before = cam.projectionMatrix.clone();
    applyCameraTrack(cam, undefined, 500);
    applyCameraTrack(cam, [], 500);
    expect(cam.position.toArray()).toEqual([1, 2, 3]);
    expect(cam.projectionMatrix.equals(before)).toBe(true);
  });

  it("writes position/fov/lookAt and refreshes the projection when fov changes", () => {
    const cam = new PerspectiveCamera(45, 16 / 9);
    const before = cam.projectionMatrix.clone();
    applyCameraTrack(cam, [{ tMs: 0, position: [0, 1, 4], fov: 30 }], 0);
    expect(cam.position.toArray()).toEqual([0, 1, 4]);
    expect(cam.fov).toBe(30);
    expect(cam.projectionMatrix.equals(before)).toBe(false);
  });

  it("never touches camera.aspect (the exporter owns aspect per format)", () => {
    const cam = new PerspectiveCamera(45, 2160 / 3840);
    applyCameraTrack(cam, [{ tMs: 0, position: [0, 0, 6], fov: 30 }], 0);
    expect(cam.aspect).toBe(2160 / 3840);
  });
});
