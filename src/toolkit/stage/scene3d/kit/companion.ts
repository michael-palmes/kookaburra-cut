import { normalizeLighting } from "../../../../engine/sceneLighting";
import type { FixtureSpec, LightSpec } from "../../../../theme/tokens";
import type { Scene3dCompanionLighting } from "../types";

/** Every companion light and fixture id starts with this, so a scene can tell the matching rig's entries from its own. */
export const COMPANION_ID_PREFIX = "bg3d-";

/** Real lights a companion may add beside its sun (free lights plus lit fixture instances): cheap rigs leave the scene's 16-light budget to the scene. */
export const COMPANION_MAX_LIGHTS = 3;

/** Fixture forms whose paired light is a rect-area light (per-fragment LTC cost). */
const AREA_PAIRED: FixtureSpec["form"][] = [
  "tube",
  "tube-stand",
  "panel",
  "strip",
  "led-strip",
  "neon-sign",
];

/** A world-space spot aimed at the stage from an orbit direction, its intensity set so `irradiance` lands on the stage (decay 2), so a rig reads the same at any distance. */
export function stageSpot(
  id: string,
  o: {
    azimuthDeg: number;
    elevationDeg: number;
    distance: number;
    irradiance: number;
    coneDeg: number;
    penumbra?: number;
    color?: string;
    kelvin?: number;
  },
): LightSpec {
  const light: LightSpec = {
    id,
    type: "spot",
    intensity: Math.round(o.irradiance * o.distance * o.distance * 100) / 100,
    angleDeg: o.coneDeg,
    penumbra: o.penumbra ?? 0.6,
    placement: {
      mode: "orbit",
      azimuthDeg: o.azimuthDeg,
      elevationDeg: o.elevationDeg,
      distance: o.distance,
    },
  };
  if (o.kelvin !== undefined) light.kelvin = o.kelvin;
  else if (o.color !== undefined) light.color = o.color;
  return light;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

/** Why a companion block breaks the F10 rules, or null: it must survive `normalizeLighting` unchanged, prefix every id, add no area light (fill-rate cost), cast no free-light shadows and stay within COMPANION_MAX_LIGHTS. */
export function companionLightingProblem(block: Scene3dCompanionLighting): string | null {
  const lights = block.lights ?? [];
  const fixtures = block.fixtures ?? [];
  for (const entry of [...lights, ...fixtures]) {
    if (!entry.id.startsWith(COMPANION_ID_PREFIX))
      return `id "${entry.id}" needs the "${COMPANION_ID_PREFIX}" prefix`;
  }
  for (const light of lights) {
    if (light.type === "area") return `light "${light.id}" is an area light`;
    if (light.castShadow) return `light "${light.id}" casts shadows`;
  }
  let real = lights.filter((l) => l.enabled !== false).length;
  for (const f of fixtures) {
    if (f.enabled === false || f.lightIntensity <= 0) continue;
    if (AREA_PAIRED.includes(f.form)) return `fixture "${f.id}" pairs an area light`;
    real += f.repeat ? f.repeat.count * (f.repeat.mirrorAxis ? 2 : 1) : 1;
  }
  if (real > COMPANION_MAX_LIGHTS)
    return `${real} real lights exceeds the companion cap of ${COMPANION_MAX_LIGHTS}`;
  const parsed = normalizeLighting(block, "companion");
  if (JSON.stringify(canonical(parsed)) !== JSON.stringify(canonical(block)))
    return "normalizeLighting rewrites or drops part of the block";
  return null;
}
