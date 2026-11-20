/** Shared-element morph transform: a keyframe track that drives a persistent (hoisted) object's transform as a pure function of the global clock. The persistent module (authored per project) samples this inside its component off `useTimeline().globalMs`, using the same per-property semantics as the camera track (engine/keyframes.ts is the shared core), so a morph key can move position at one time and fade opacity at another without either resetting the other. See docs/determinism.md. */
import { Euler, Quaternion, Vector3 } from "three";
import { resolveAvailableDeviceSpec } from "../toolkit/device/catalog";
import type { DevicePlacement } from "../toolkit/device/Device";
import { clampFoldDeg } from "../toolkit/device/foldPose";
import {
  type DeviceScreenDisplay,
  deviceScreenFrame,
  SCREEN_LIFT,
} from "../toolkit/device/screenAnchor";
import { devicePoseFloorShift } from "../toolkit/device/shadowProjector";
import { type DeviceFloorY, resolveDeviceWorldAnchor } from "../toolkit/device/worldAnchor";
import type { V3 } from "../toolkit/types";
import { lerp, lerp3, sampleKeyProperty, sortKeys } from "./keyframes";
import type { MotionBlurOverride } from "./motionBlur";
import { deviceTrackPoseAt, type ResolvedDeviceTrack } from "./sceneDeviceTrack";

const DEG2RAD = Math.PI / 180;

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

/** A device as the scene hands it to `Device`: the same props, so the point lands where that device renders. */
export interface TrackedDevice {
  /** The sidecar id the scene's device track keys on. */
  id?: string;
  model: string;
  placement?: DevicePlacement;
  lidDeg?: number;
  foldDeg?: number;
  motionBlur?: MotionBlurOverride;
}

/** A screen point this frame: where it is, how its display is turned, and the world size of one fitted unit. */
export interface DeviceScreenSample {
  position: V3;
  /** The display plane's orientation, Euler XYZ in radians (a group's `rotation`). */
  rotation: V3;
  scale: number;
}

export interface DeviceScreenPointOptions {
  /** Off the glass along the display's normal, in fitted units (default `SCREEN_LIFT`). */
  lift?: number;
  display?: DeviceScreenDisplay;
}

/** Where a point on a moving device's display is at scene-local `localMs`: its placement with the scene's device track applied (offsets add, rotations add, scale multiplies, keyed hinge angles), grounded the way `Device` grounds it. The motion presets (float, turntable, the intros) aren't counted, so keep a match move's target on `motion: none`. Pure, for a word that flies into a screen and lands on its title. */
export function deviceScreenPointAt(
  device: TrackedDevice,
  track: ResolvedDeviceTrack | null,
  localMs: number,
  u: number,
  v: number,
  /** `floorY`: the staged floor a grounded device stands on (`null` for none); unknown keeps the authored y, as `Device` does. */
  options: DeviceScreenPointOptions & { floorY?: DeviceFloorY } = {},
): DeviceScreenSample {
  const spec = resolveAvailableDeviceSpec(device.model);
  const placement = device.placement ?? {};
  const position = placement.resolvedLayout?.position ?? placement.position ?? [0, 0, 0];
  const rotationDeg = placement.resolvedLayout?.rotationDeg ?? placement.rotationDeg ?? [0, 0, 0];
  const scale = placement.resolvedLayout?.scale ?? placement.scale ?? 1;
  const ground = placement.ground ?? false;
  const authoredLidDeg = device.lidDeg ?? spec.lid?.defaultDeg;
  const authoredFoldDeg = spec.fold ? (device.foldDeg ?? spec.fold.defaultDeg) : undefined;
  const keyed = deviceTrackPoseAt(track, device.id ?? "", localMs, authoredLidDeg, authoredFoldDeg);
  const foldDeg = spec.fold
    ? clampFoldDeg(spec.fold, keyed.foldDeg ?? authoredFoldDeg ?? spec.fold.defaultDeg)
    : undefined;
  const animatedScale = scale * keyed.scale;
  const rotation: V3 = [
    (rotationDeg[0] + keyed.rotationDeg[0]) * DEG2RAD,
    (rotationDeg[1] + keyed.rotationDeg[1]) * DEG2RAD,
    (rotationDeg[2] + keyed.rotationDeg[2]) * DEG2RAD,
  ];
  const shift = ground
    ? devicePoseFloorShift(spec, {
        scale: animatedScale,
        rotation,
        offset: [0, 0, 0],
        introScale: 1,
        lidDeg: keyed.lidDeg ?? 0,
        foldDeg: foldDeg ?? 0,
      })
    : 0;
  const anchor =
    resolveDeviceWorldAnchor(
      { model: spec.id },
      { position, rotationDeg, scale: animatedScale, ground },
      options.floorY,
      shift,
    ) ?? position;
  const { position: local, tiltX } = deviceScreenFrame(spec.id, u, v, options.lift ?? SCREEN_LIFT, {
    display: options.display,
    lidDeg: keyed.lidDeg ?? authoredLidDeg,
    foldDeg,
  });
  const turn = new Euler(rotation[0], rotation[1], rotation[2]);
  const point = new Vector3(...local)
    .multiplyScalar(animatedScale)
    .applyEuler(turn)
    .add(
      new Vector3(
        anchor[0] + keyed.offset[0],
        anchor[1] + keyed.offset[1],
        anchor[2] + keyed.offset[2],
      ),
    );
  const facing = new Euler().setFromQuaternion(
    new Quaternion()
      .setFromEuler(turn)
      .multiply(new Quaternion().setFromEuler(new Euler(tiltX, 0, 0))),
  );
  return {
    position: [point.x, point.y, point.z],
    rotation: [facing.x, facing.y, facing.z],
    scale: animatedScale,
  };
}
