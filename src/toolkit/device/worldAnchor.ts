import type { SceneDocDeviceSpec } from "../../engine/sceneDocSchema";
import type { V3 } from "../types";
import { resolveAvailableDeviceSpec } from "./catalog";
import type { DevicePlacement } from "./Device";

/** `undefined` means the scene's mounted floor is not known yet; `null` means it is known to have no floor. */
export type DeviceFloorY = number | null | undefined;

/** The fitted body height shared by grounding, camera binding and licence-free fallback builds. */
export function deviceFittedHeight(model: string): number {
  return resolveAvailableDeviceSpec(model).fittedHeight;
}

/** Resolve the device group's rendered world anchor. An unknown floor preserves the baked camera point instead of guessing from authored Y. */
export function resolveDeviceWorldAnchor(
  device: Pick<SceneDocDeviceSpec, "model">,
  placement: DevicePlacement | undefined,
  floorY: DeviceFloorY,
): V3 | undefined {
  const resolved = placement?.resolvedLayout;
  const position = resolved?.position ?? placement?.position ?? [0, 0, 0];
  if (placement?.ground !== true) return [...position];
  if (floorY === undefined) return undefined;
  if (floorY === null) return [...position];
  const scale = resolved?.scale ?? placement?.scale ?? 1;
  return [position[0], floorY + (deviceFittedHeight(device.model) * scale) / 2, position[2]];
}
