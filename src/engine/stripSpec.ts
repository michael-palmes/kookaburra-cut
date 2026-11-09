import type { EnvStripSpec } from "../theme/tokens";

/** Strip environments' pure half (sceneLighting stays three-free): parsing and the cache key that carries an inline spec to the bake. */

export const STRIPS_SOURCE = "kookaburra:strips";
const KEY_PREFIX = `${STRIPS_SOURCE}#`;
export const MAX_ENV_STRIPS = 16;

export interface InlineStrips {
  strips: EnvStripSpec[];
  ambient?: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const HEX = /^#[0-9a-f]{6}$/i;

function parseStrip(raw: unknown): EnvStripSpec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  if (!isNum(s.azimuthDeg) || !isNum(s.elevationDeg) || !isNum(s.intensity)) return undefined;
  if (typeof s.color !== "string" || !HEX.test(s.color)) return undefined;
  const out: EnvStripSpec = {
    azimuthDeg: s.azimuthDeg,
    elevationDeg: clamp(s.elevationDeg, -90, 90),
    lengthDeg: clamp(isNum(s.lengthDeg) ? s.lengthDeg : 60, 0.5, 170),
    widthDeg: clamp(isNum(s.widthDeg) ? s.widthDeg : 4, 0.2, 170),
    color: s.color.toLowerCase(),
    intensity: clamp(s.intensity, 0, 5000),
  };
  if (isNum(s.rollDeg)) out.rollDeg = s.rollDeg;
  if (isNum(s.falloff)) out.falloff = clamp(s.falloff, 0, 1);
  if (isNum(s.feather)) out.feather = clamp(s.feather, 0, 1);
  return out;
}

/** The valid strips of an authored list, capped; undefined when none survive. */
export function parseEnvStrips(raw: unknown): EnvStripSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const strips = raw
    .map(parseStrip)
    .filter((s): s is EnvStripSpec => !!s)
    .slice(0, MAX_ENV_STRIPS);
  return strips.length > 0 ? strips : undefined;
}

/** The environment source for an inline spec: a content key, so an edit re-bakes and equal specs share one bake. */
export function stripsSourceKey(spec: InlineStrips): string {
  return `${KEY_PREFIX}${JSON.stringify(spec)}`;
}

export function inlineStripsFromKey(key: string): InlineStrips | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  try {
    const raw = JSON.parse(key.slice(KEY_PREFIX.length)) as { strips?: unknown; ambient?: unknown };
    const strips = parseEnvStrips(raw.strips);
    if (!strips) return undefined;
    return isNum(raw.ambient) ? { strips, ambient: raw.ambient } : { strips };
  } catch {
    return undefined;
  }
}
