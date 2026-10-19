import { Euler, Vector3 } from "three";
import { coverCropRect } from "../../engine/screenFit";
import type { V3 } from "../types";
import { type DeviceScreenRect, type DeviceSpec, resolveAvailableDeviceSpec } from "./catalog";
import { clampFoldDeg, foldCentreOffset } from "./foldPose";

/** Screen points in the frame `Device` renders in at placement scale 1, from the committed glb measurements (`screenGeometry.ts`). UV runs u right and v DOWN from the display's top-left corner, the order of media pixels and the video editor's taps. Every helper resolves the model this build renders, so an unavailable model answers with the Android's screen. */

/** How far anchored content sits off the display along its normal, in fitted units, so it never z-fights the screen. */
export const SCREEN_LIFT = 0.002;

const DEG2RAD = Math.PI / 180;

/** A foldable's inside (`"main"`) or outside (`"cover"`) display; every other device has only `"main"`. */
export type DeviceScreenDisplay = "main" | "cover";

/** The hinge pose a point is read at; absent angles take the device's defaults. */
export interface DeviceScreenHinge {
  display?: DeviceScreenDisplay;
  lidDeg?: number;
  foldDeg?: number;
}

/** A device's resolved world pose (static: no motion preset or device track). */
export interface DeviceScreenPose extends DeviceScreenHinge {
  /** The device group's world position, grounding applied (`resolveDeviceWorldAnchor`). */
  position: V3;
  rotationDeg?: V3;
  /** Placement scale on top of the auto-fit (default 1). */
  scale?: number;
}

function displaySpec(spec: DeviceSpec, display: DeviceScreenDisplay | undefined) {
  return display === "cover" && spec.coverScreen ? spec.coverScreen : spec.screen;
}

/** The display rect a model renders with here. A device without a cover display answers `"cover"` with its one screen, which is where the Android fallback shows a foldable's cover media. */
export function deviceScreenRect(model: string, display?: DeviceScreenDisplay): DeviceScreenRect {
  return displaySpec(resolveAvailableDeviceSpec(model), display).rect;
}

/** A screen point and the display's tilt about X (a laptop lid off its measured angle), in the device's fitted frame. Valid on phones, tablets, the laptop lid, a foldable's static half and its cover display closed. */
export function deviceScreenFrame(
  model: string,
  u: number,
  v: number,
  lift: number = SCREEN_LIFT,
  hinge: DeviceScreenHinge = {},
): { position: V3; tiltX: number } {
  const spec = resolveAvailableDeviceSpec(model);
  const rect = displaySpec(spec, hinge.display).rect;
  let x = rect.centre[0] + (u - 0.5) * rect.width;
  let y = rect.centre[1] + (0.5 - v) * rect.height;
  let z = rect.z + lift;
  let tiltX = 0;
  const lid = spec.lid;
  if (lid?.pivot && rect.frame?.lidDeg !== undefined) {
    // Device clamps the lid the same way; opening turns the lid about fitted X by minus its travel.
    const deg = Math.max(0, Math.min(lid.openDeg, hinge.lidDeg ?? lid.defaultDeg));
    tiltX = -(deg - rect.frame.lidDeg) * DEG2RAD;
    const dy = y - lid.pivot[1];
    const dz = z - lid.pivot[2];
    const c = Math.cos(tiltX);
    const s = Math.sin(tiltX);
    y = lid.pivot[1] + dy * c - dz * s;
    z = lid.pivot[2] + dy * s + dz * c;
  }
  const fold = spec.fold;
  if (fold && rect.frame?.foldDeg !== undefined) {
    const deg = clampFoldDeg(fold, hinge.foldDeg ?? fold.defaultDeg);
    x += foldCentreOffset(fold, deg) - foldCentreOffset(fold, rect.frame.foldDeg);
  }
  return { position: [x, y, z], tiltX };
}

/** A point on a display, `lift` off the glass, in the device's local fitted frame (placement scale 1). */
export function deviceScreenLocal(
  model: string,
  u: number,
  v: number,
  lift: number = SCREEN_LIFT,
  hinge: DeviceScreenHinge = {},
): V3 {
  return deviceScreenFrame(model, u, v, lift, hinge).position;
}

/** A point on a display in world space, for a device standing at `pose`. */
export function deviceScreenPoint(
  model: string,
  u: number,
  v: number,
  pose: DeviceScreenPose,
  lift: number = SCREEN_LIFT,
): V3 {
  const [rx, ry, rz] = pose.rotationDeg ?? [0, 0, 0];
  const point = new Vector3(...deviceScreenLocal(model, u, v, lift, pose))
    .multiplyScalar(pose.scale ?? 1)
    .applyEuler(new Euler(rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD))
    .add(new Vector3(...pose.position));
  return [point.x, point.y, point.z];
}

/** The part of the media a display shows under Device's cover fit, as fractions of the media. */
function mediaCrop(
  model: string,
  media: { width: number; height: number },
  display?: DeviceScreenDisplay,
) {
  const aspect = displaySpec(resolveAvailableDeviceSpec(model), display).aspect;
  return coverCropRect(media.width / media.height, aspect, false);
}

/** Media pixel coordinates (top-left origin) to screen UV under the display's cover fit; pixels cropped off the screen land outside 0..1. */
export function mediaPixelToScreenUv(
  model: string,
  pixel: [number, number],
  media: { width: number; height: number },
  display?: DeviceScreenDisplay,
): [number, number] {
  const crop = mediaCrop(model, media, display);
  return [
    (pixel[0] / media.width - crop.u0) / (crop.u1 - crop.u0),
    (pixel[1] / media.height - crop.v0) / (crop.v1 - crop.v0),
  ];
}

/** Screen UV to media pixel coordinates (top-left origin), the inverse of `mediaPixelToScreenUv`. */
export function screenUvToMediaPixel(
  model: string,
  uv: [number, number],
  media: { width: number; height: number },
  display?: DeviceScreenDisplay,
): [number, number] {
  const crop = mediaCrop(model, media, display);
  return [
    (crop.u0 + uv[0] * (crop.u1 - crop.u0)) * media.width,
    (crop.v0 + uv[1] * (crop.v1 - crop.v0)) * media.height,
  ];
}
