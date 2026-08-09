import type { SceneDocDeviceSpec } from "../engine/sceneDocSchema";
import type { DeviceId } from "../toolkit/device/catalog";

export function applyDeviceChoice(
  device: SceneDocDeviceSpec,
  choice: { model: DeviceId; colour: string; changed: boolean },
): void {
  if (!choice.changed) return;
  device.model = choice.model;
  device.colour = choice.colour;
}
