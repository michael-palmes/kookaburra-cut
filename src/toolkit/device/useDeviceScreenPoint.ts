import { useMemo } from "react";
import { motionBlurScale } from "../../engine/motionBlur";
import { resolveDeviceTrack } from "../../engine/sceneDeviceTrack";
import { useSceneDoc } from "../../engine/sceneDoc";
import {
  type DeviceScreenPointOptions,
  type DeviceScreenSample,
  deviceScreenPointAt,
  type TrackedDevice,
} from "../../engine/sharedElement";
import { useTimeline } from "../../engine/timeline";
import { useStageFloorY } from "../stage/context";
import { useLayoutFormat } from "./layoutFormat";

/** In a scene: where a point on one of its devices' displays is this frame, with the scene's device track and staged floor applied, for a match move into a moving screen. Pass the same props the scene hands that `Device`. */
export function useDeviceScreenPoint(
  device: TrackedDevice,
  u: number,
  v: number,
  options: DeviceScreenPointOptions = {},
): DeviceScreenSample {
  // The device's own clock, so a shutter sample reads the time the device renders at.
  const { localMs } = useTimeline(motionBlurScale(device.motionBlur));
  const doc = useSceneDoc();
  const format = useLayoutFormat();
  const floorY = useStageFloorY();
  const track = useMemo(() => resolveDeviceTrack(doc ?? undefined, format), [doc, format]);
  return deviceScreenPointAt(device, track, localMs, u, v, { ...options, floorY });
}
