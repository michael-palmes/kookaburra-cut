import type {
  DeviceLayoutPreset,
  SceneDocDeviceLayout,
  SceneDocDeviceSpec,
} from "../../engine/sceneDocSchema";
import { customColourHex, DEVICE_CATALOG, type DeviceId } from "../../toolkit/device/catalog";

export function compatibleDeviceColour(model: DeviceId, colour: string | undefined): string {
  const spec = DEVICE_CATALOG[model];
  if (colour && (customColourHex(colour) || spec.colours.some((finish) => finish.id === colour))) {
    return colour;
  }
  return spec.defaultColour;
}

export function changeDeviceModel(device: SceneDocDeviceSpec, model: DeviceId): SceneDocDeviceSpec {
  return {
    ...device,
    model,
    colour: compatibleDeviceColour(model, device.colour),
  };
}

export function replaceDeviceLayoutPreset(
  layout: SceneDocDeviceLayout | undefined,
  preset: DeviceLayoutPreset,
): SceneDocDeviceLayout {
  return { ...layout, preset };
}

export function resetDeviceLayoutDelta(
  layout: SceneDocDeviceLayout,
  deviceId: string,
): SceneDocDeviceLayout {
  if (!layout.devices?.[deviceId]) return layout;
  const devices = { ...layout.devices };
  delete devices[deviceId];
  const next = { ...layout };
  if (Object.keys(devices).length > 0) next.devices = devices;
  else delete next.devices;
  return next;
}

export function resetAllDeviceLayoutDeltas(layout: SceneDocDeviceLayout): SceneDocDeviceLayout {
  if (!layout.devices) return layout;
  const next = { ...layout };
  delete next.devices;
  return next;
}
