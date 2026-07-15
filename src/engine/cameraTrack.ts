/** Per-project camera track: a keyframe list that drives the shared camera as a pure function of the global clock, applied at the one shared render seam (never a component useFrame, which wouldn't fire under frameloop="demand" during export). See docs/determinism.md. `applyCameraTrack` is a hard no-op with no track, so every existing project renders byte-identically. */
import type { PerspectiveCamera } from "three";
import { CAMERA } from "./format";
import { lerp, lerp3, sampleKeyProperty, sortKeys } from "./keyframes";

/** One keyframe; fields are per-property optional (a key omitting `fov` is transparent to the fov track, not a reset to base). Times are global project milliseconds. */
export interface CameraKeyframe {
  tMs: number;
  position?: [number, number, number];
  fov?: number;
  lookAt?: [number, number, number];
}

/** A fully-resolved camera pose for one frame. */
export interface CameraPose {
  position: [number, number, number];
  fov: number;
  lookAt: [number, number, number];
}

/** The base pose every property falls back to: the shared CAMERA config, which the preview `<Canvas>` mounts with and the safe-area math assumes. */
export function baseCameraPose(): CameraPose {
  return {
    position: [...CAMERA.position],
    fov: CAMERA.fov,
    lookAt: [0, 0, CAMERA.contentZ],
  };
}

/** Samples the track at a global time: linear interpolation between surrounding keyframes, clamped outside the keyed range, per property. Pure (same track, t -> same pose), which is what lets preview scrubbing and the export loop agree by construction. */
export function sampleCameraTrack(track: CameraKeyframe[], globalMs: number): CameraPose {
  const base = baseCameraPose();
  if (track.length === 0) return base;
  const keys = sortKeys(track);
  return {
    position: sampleKeyProperty(keys, globalMs, (k) => k.position, lerp3) ?? base.position,
    fov: sampleKeyProperty(keys, globalMs, (k) => k.fov, lerp) ?? base.fov,
    lookAt: sampleKeyProperty(keys, globalMs, (k) => k.lookAt, lerp3) ?? base.lookAt,
  };
}

/** Writes a resolved pose onto the shared camera; never touches `camera.aspect`, the exporter (and its resize guard) own aspect per format. */
export function applyCameraPose(camera: PerspectiveCamera, pose: CameraPose): void {
  if (!camera.isPerspectiveCamera) return;
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
  if (camera.fov !== pose.fov) {
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
  }
}

/** Samples the project-level track and writes it onto the camera, immediately before `renderComposited`; no track (or a non-perspective camera) returns without touching anything, preserving byte-identical legacy render paths. */
export function applyCameraTrack(
  camera: PerspectiveCamera,
  track: CameraKeyframe[] | undefined,
  globalMs: number,
): void {
  if (!track || track.length === 0 || !camera.isPerspectiveCamera) return;
  applyCameraPose(camera, sampleCameraTrack(track, globalMs));
}
