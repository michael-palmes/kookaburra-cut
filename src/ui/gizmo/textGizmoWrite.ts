import { normaliseDeg } from "../../engine/sceneDocSchema";

/** What a text gizmo drag writes into `textStyle.<key><Suffix>`. Each helper rounds to the precision the Text drill's own field shows and returns `undefined` at the neutral value, which clears the key so the scene's own layout resurfaces. */

/** World-unit nudge, 2dp to match the drill's X/Y fields. */
export function textOffsetWrite(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const v = Math.round(value * 100) / 100;
  return v === 0 ? undefined : v;
}

/** Multiplier of the element's default, whole percent to match the Size % field. */
export function textSizeWrite(multiplier: number): number | undefined {
  if (!Number.isFinite(multiplier)) return undefined;
  const v = Math.round(Math.min(10, Math.max(0.01, multiplier)) * 100) / 100;
  return v === 1 ? undefined : v;
}

/** Degrees clockwise on screen, folded into (-180, 180] and rounded to 1dp. */
export function textRotationWrite(deg: number): number | undefined {
  if (!Number.isFinite(deg)) return undefined;
  const v = Math.round(normaliseDeg(deg) * 10) / 10;
  return v === 0 ? undefined : v;
}
