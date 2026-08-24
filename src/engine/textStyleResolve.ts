import type { Theme } from "../theme/tokens";
import type { V3 } from "../toolkit/types";
import type { SceneDoc } from "./sceneDocSchema";

/** Sidecar `textStyle` resolution shared by primitives outside `AnimatedHeadline`'s own dispatcher (counter, chip label, extruded text). Absent keys leave every coded value untouched: the null-for-legacy contract. */

export type TextStyleSuffix =
  | "Color"
  | "Font"
  | "Size"
  | "OffsetX"
  | "OffsetY"
  | "LineHeight"
  | "RotationDeg";

export function textStyleValue(
  doc: SceneDoc | null | undefined,
  key: string | undefined,
  suffix: TextStyleSuffix,
): string | number | undefined {
  return key ? doc?.textStyle?.[`${key}${suffix}`] : undefined;
}

/** `base * <key>Size` when the multiplier is set; the untouched base otherwise. */
export function textStyleScaledSize(
  doc: SceneDoc | null | undefined,
  key: string | undefined,
  base: number,
): number {
  const mul = textStyleValue(doc, key, "Size");
  return typeof mul === "number" ? base * mul : base;
}

/** Folds `<key>OffsetX/Y` into a coded position; the ORIGINAL array comes back when neither is set. */
export function textStyleOffsetPosition(
  doc: SceneDoc | null | undefined,
  key: string | undefined,
  position: V3,
): V3 {
  const offX = textStyleValue(doc, key, "OffsetX");
  const offY = textStyleValue(doc, key, "OffsetY");
  if (typeof offX !== "number" && typeof offY !== "number") return position;
  return [
    position[0] + (typeof offX === "number" ? offX : 0),
    position[1] + (typeof offY === "number" ? offY : 0),
    position[2],
  ];
}

/** `<key>RotationDeg` as the Z tilt in radians (AnimatedHeadline's sign rule); 0 when unset or zero so callers can leave the prop off entirely. */
export function textStyleRotationRad(
  doc: SceneDoc | null | undefined,
  key: string | undefined,
): number {
  const deg = textStyleValue(doc, key, "RotationDeg");
  return typeof deg === "number" && deg !== 0 ? (-deg * Math.PI) / 180 : 0;
}

/** Token fills resolve through the palette, anything else is a raw fill: byte-identical with AnimatedHeadline's rule. */
export function resolveTokenFill(theme: Theme, colour: string): string {
  if (colour === "text" || colour === "muted" || colour === "accent") return theme.colors[colour];
  return colour;
}
