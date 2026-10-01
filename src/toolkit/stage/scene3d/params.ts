import type { Scene3dParamDef } from "./types";

/** A spec's params resolved against a look's defs: defaults fill gaps and every value clamps to its slider bounds, since the parser keeps any number. */
export function resolveScene3dParams(
  defs: Record<string, Scene3dParamDef>,
  values: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(defs)) {
    out[key] = Math.min(p.max, Math.max(p.min, values?.[key] ?? p.default));
  }
  return out;
}
