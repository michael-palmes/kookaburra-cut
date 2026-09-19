import type { DeviceFoldSpec } from "./catalog";

/** Pure fold geometry for a foldable, in the fitted frame the catalogue measures in. The glb's clip keeps the camera half static, so a closed device sits over that half alone: these put its visible mass back on the device origin. */

const DEG2RAD = Math.PI / 180;

/** Keyframe eases (back, elastic) overshoot, and the clip only covers the hinge's real travel. */
export function clampFoldDeg(fold: Pick<DeviceFoldSpec, "openDeg">, deg: number): number {
  return Math.min(fold.openDeg, Math.max(0, deg));
}

/** The x shift that keeps the device centred as it folds: none when open (the hinge is the centre), half a panel towards the hinge side when closed, on a smooth curve between (the exact bounds centre kinks at 90 degrees, which reads as a jolt in motion). */
export function foldCentreOffset(
  fold: Pick<DeviceFoldSpec, "anchorSide" | "halfWidth">,
  deg: number,
): number {
  const c = Math.cos((deg * DEG2RAD) / 2);
  return -fold.anchorSide * (fold.halfWidth / 2) * c * c;
}

/** The silhouette's width facing the camera: one panel until the cover swings past square, then growing to both. */
export function foldVisibleWidth(fold: Pick<DeviceFoldSpec, "halfWidth">, deg: number): number {
  return fold.halfWidth * (1 + Math.max(0, -Math.cos(deg * DEG2RAD)));
}
