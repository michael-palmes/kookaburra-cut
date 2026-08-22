import type { SceneDocDeviceSpec } from "../../engine/sceneDocSchema";
import { resolveAvailableDeviceSpec } from "../device/catalog";
import type { DevicePlacement } from "../device/Device";
import type { V3 } from "../types";

/** Mirrors Device.tsx's auto-fit target so preset maths agrees with the render (not exported there). */
const DEVICE_TARGET_WORLD_HEIGHT = 2.6;
/** Gap between the device's edge and the object, world units; a starting point the user nudges from. */
const BESIDE_GAP = 0.55;

/** The device's approximate fitted world size from catalog metadata alone (the inspector has no loaded geometry): screen aspect stands in for body aspect, close enough for a starting placement. */
function fittedDeviceSize(device: SceneDocDeviceSpec): { width: number; height: number } {
  const spec = resolveAvailableDeviceSpec(device.model);
  const aspect = spec.screen.aspect;
  const scale = device.placement?.scale ?? 1;
  if (spec.fit?.axis === "width") {
    const width = (spec.fit.target ?? DEVICE_TARGET_WORLD_HEIGHT) * scale;
    return { width, height: width / aspect };
  }
  const height = (spec.fit?.target ?? DEVICE_TARGET_WORLD_HEIGHT) * scale;
  return { width: height * aspect, height };
}

/** Starting placement beside a staged device: level with it, offset past its half-width plus a gap, grounded so a staged floor seats both together. */
export function besideDevicePlacement(
  device: SceneDocDeviceSpec,
  side: "left" | "right",
): DevicePlacement {
  const { width } = fittedDeviceSize(device);
  const sign = side === "left" ? -1 : 1;
  const [dx = 0, dy = 0, dz = 0] = device.placement?.position ?? [];
  const position: V3 = [Math.round((dx + sign * (width / 2 + BESIDE_GAP)) * 100) / 100, dy, dz];
  return { position, rotationDeg: [0, 0, 0], ground: true };
}

/** Front-of-device starting placement: centred, pulled toward the camera, grounded. */
export function frontOfDevicePlacement(device: SceneDocDeviceSpec): DevicePlacement {
  const [dx = 0, dy = 0, dz = 0] = device.placement?.position ?? [];
  return {
    position: [dx, dy, Math.round((dz + 1.2) * 100) / 100],
    rotationDeg: [0, 0, 0],
    ground: true,
  };
}

/** Floor-centre starting placement for scenes with no device. */
export function floorCentrePlacement(): DevicePlacement {
  return { position: [0, 0, 0], rotationDeg: [0, 0, 0], ground: true };
}
