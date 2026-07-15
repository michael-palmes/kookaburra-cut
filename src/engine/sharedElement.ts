/** Shared-element morph transform: a keyframe track that drives a persistent (hoisted) object's transform as a pure function of the global clock. The persistent module (authored per project) samples this inside its component off `useTimeline().globalMs`, using the same per-property semantics as the camera track (engine/keyframes.ts is the shared core), so a morph key can move position at one time and fade opacity at another without either resetting the other. See docs/determinism.md. */
import { lerp, lerp3, sampleKeyProperty, sortKeys } from "./keyframes";

/** One morph keyframe. Fields are per-property optional (see engine/keyframes.ts). */
export interface SharedKeyframe {
  tMs: number;
  position?: [number, number, number];
  /** Euler XYZ, radians. */
  rotation?: [number, number, number];
  /** Uniform scale. */
  scale?: number;
  opacity?: number;
}

/** A fully-resolved morph transform for one frame. */
export interface SharedTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  opacity: number;
}

const BASE: SharedTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
  opacity: 1,
};

/** Samples the morph track at a global time: linear interpolation between the surrounding keys that define each property, clamped outside the keyed range. Pure: same (track, t) → same transform, so preview and export agree by construction. */
export function sampleSharedTransform(track: SharedKeyframe[], globalMs: number): SharedTransform {
  if (track.length === 0) return { ...BASE };
  const keys = sortKeys(track);
  return {
    position: sampleKeyProperty(keys, globalMs, (k) => k.position, lerp3) ?? BASE.position,
    rotation: sampleKeyProperty(keys, globalMs, (k) => k.rotation, lerp3) ?? BASE.rotation,
    scale: sampleKeyProperty(keys, globalMs, (k) => k.scale, lerp) ?? BASE.scale,
    opacity: sampleKeyProperty(keys, globalMs, (k) => k.opacity, lerp) ?? BASE.opacity,
  };
}
