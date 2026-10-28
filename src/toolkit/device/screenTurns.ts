import { Euler, Matrix4 } from "three";
import type { ScreenTurns } from "../../engine/screenFit";
import type { V3 } from "../types";

/** A screen's media rotation as authored: clockwise degrees, or `"auto"` to match the device's pose. */
export type DeviceMediaRotation = 0 | 90 | 180 | 270 | "auto";

const QUARTER = Math.PI / 2;
const scratch = new Matrix4();
const euler = new Euler();

/** The quarter turns that stand media upright on a device posed by `rotation` (radians, the inner group's XYZ order). World up is measured in the device's own right and up axes; a display tipped towards the floor or the sky leans on "away from the camera" instead, so a phone laid flat still reads top-away. Every display is judged at its home pose (facing the device's front), so a fold never flips the media part way. */
export function autoScreenTurns(rotation: V3): ScreenTurns {
  const m = scratch.makeRotationFromEuler(
    euler.set(rotation[0], rotation[1], rotation[2]),
  ).elements;
  // Rows of the rotation: world +Y and world -Z in the device frame; m[9] is how far the screen faces up or down.
  const flat = Math.abs(m[9]);
  const x = m[1] - flat * m[2];
  const y = m[5] - flat * m[6];
  if (Math.hypot(x, y) < 1e-6) return 0;
  const quarters = Math.round(Math.atan2(x, y) / QUARTER);
  return (((quarters % 4) + 4) % 4) as ScreenTurns;
}

/** The quarter turns a screen shows its media at; anything unrecognised reads as unturned. */
export function screenTurns(rotateDeg: unknown, rotation: V3): ScreenTurns {
  if (rotateDeg === "auto") return autoScreenTurns(rotation);
  return rotateDeg === 90 ? 1 : rotateDeg === 180 ? 2 : rotateDeg === 270 ? 3 : 0;
}
