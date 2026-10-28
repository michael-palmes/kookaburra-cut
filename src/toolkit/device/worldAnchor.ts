import type { SceneDocDeviceSpec } from "../../engine/sceneDocSchema";
import type { V3 } from "../types";
import { resolveAvailableDeviceSpec } from "./catalog";
import type { DevicePlacement } from "./Device";
import { devicePoseFloorShift } from "./shadowProjector";

/** `undefined` means the scene's mounted floor is not known yet; `null` means it is known to have no floor. */
export type DeviceFloorY = number | null | undefined;

const DEG2RAD = Math.PI / 180;

/** The fitted body height shared by grounding, camera binding and licence-free fallback builds. */
export function deviceFittedHeight(model: string): number {
  return resolveAvailableDeviceSpec(model).fittedHeight;
}

/** The floor shift of a device at rest on its own placement (`devicePoseFloorShift`): what grounding uses when the caller has no live pose. */
export function restingFloorShift(
  device: Pick<SceneDocDeviceSpec, "model" | "foldDeg" | "lidDeg">,
  rotationDeg: V3 | undefined,
  scale: number,
): number {
  if (!rotationDeg) return 0;
  const spec = resolveAvailableDeviceSpec(device.model);
  return devicePoseFloorShift(spec, {
    scale,
    rotation: [rotationDeg[0] * DEG2RAD, rotationDeg[1] * DEG2RAD, rotationDeg[2] * DEG2RAD],
    offset: [0, 0, 0],
    introScale: 1,
    lidDeg: device.lidDeg ?? spec.lid?.defaultDeg ?? 0,
    foldDeg: device.foldDeg ?? spec.fold?.defaultDeg ?? 0,
  });
}

/** Resolve the device group's rendered world anchor. An unknown floor preserves the baked camera point instead of guessing from authored Y. Grounding stands the posed device's lowest point on the floor; `floorShift` is the live pose's, else the placement's own. */
export function resolveDeviceWorldAnchor(
  device: Pick<SceneDocDeviceSpec, "model" | "foldDeg" | "lidDeg">,
  placement: DevicePlacement | undefined,
  floorY: DeviceFloorY,
  floorShift?: number,
): V3 | undefined {
  const resolved = placement?.resolvedLayout;
  const position = resolved?.position ?? placement?.position ?? [0, 0, 0];
  if (placement?.ground !== true) return [...position];
  if (floorY === undefined) return undefined;
  if (floorY === null) return [...position];
  const scale = resolved?.scale ?? placement?.scale ?? 1;
  const shift =
    floorShift ?? restingFloorShift(device, resolved?.rotationDeg ?? placement?.rotationDeg, scale);
  return [
    position[0],
    floorY + (deviceFittedHeight(device.model) * scale) / 2 - shift,
    position[2],
  ];
}
