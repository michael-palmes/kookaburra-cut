import { parseWarn } from "../engine/parseWarnings";
import type { SatinBackdropSpec } from "./tokens";

/** A `satin` backdrop, parsed with the sidecar contract: numbers clamp, a malformed piece drops with a warning, and only authored keys come back, so a parse round-trips. */

type Pair = [number, number];
type Pool = NonNullable<SatinBackdropSpec["pools"]>[number];

/** Pool slots the floor's shader holds. */
export const SATIN_MAX_POOLS = 4;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pair = (v: unknown): Pair | undefined =>
  Array.isArray(v) && v.length === 2 && v.every(isNum) ? [v[0], v[1]] : undefined;

function numbers<T extends object>(
  out: T,
  raw: Record<string, unknown>,
  ranges: Record<string, Pair>,
): void {
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    if (isNum(raw[key])) (out as Record<string, number>)[key] = clamp(raw[key], lo, hi);
  }
}

function parsePool(v: unknown): Pool | undefined {
  if (!isRecord(v) || !isHex(v.color) || !isNum(v.intensity)) return undefined;
  const at = pair(v.at);
  const radius = pair(v.radius);
  if (!at || !radius || radius[0] <= 0 || radius[1] <= 0) return undefined;
  const pool: Pool = {
    at,
    radius,
    color: v.color.toLowerCase(),
    intensity: clamp(v.intensity, 0, 10),
  };
  if (isNum(v.angleDeg)) pool.angleDeg = v.angleDeg;
  return pool;
}

export function parseSatinBackdrop(
  v: Record<string, unknown>,
  source: string,
): SatinBackdropSpec | undefined {
  if (!isHex(v.color)) {
    parseWarn(`[theme] ${source}: a satin backdrop needs a hex colour, dropped`);
    return undefined;
  }
  const out: SatinBackdropSpec = { type: "satin", color: v.color.toLowerCase() };
  numbers(out, v, { roughness: [0.02, 1], specular: [0, 1] });
  const centre = pair(v.centre);
  if (centre) out.centre = centre;
  const fade = pair(v.fade);
  if (fade && fade[0] >= 0 && fade[1] > fade[0]) out.fade = fade;
  else if (v.fade !== undefined) {
    parseWarn(
      `[theme] ${source}: satin "fade" needs [inner, outer] radii with outer larger, dropped`,
    );
  }
  if (v.reflection === false) out.reflection = false;
  else if (isRecord(v.reflection)) {
    const reflection: Exclude<SatinBackdropSpec["reflection"], false | undefined> = {};
    numbers(reflection, v.reflection, {
      strength: [0, 2],
      blur: [0, 200],
      heightBlur: [0.01, 20],
      contact: [0, 1],
    });
    out.reflection = reflection;
  } else if (v.reflection !== undefined) {
    parseWarn(`[theme] ${source}: satin "reflection" must be false or an object, dropped`);
  }
  if (isRecord(v.glitter)) {
    const glitter: NonNullable<SatinBackdropSpec["glitter"]> = {};
    numbers(glitter, v.glitter, {
      scale: [1, 500],
      density: [0, 1],
      roughness: [0.02, 1],
      tilt: [0, 1],
      weight: [0, 4],
      grain: [0, 1],
    });
    if (isNum(v.glitter.seed)) glitter.seed = Math.trunc(v.glitter.seed);
    out.glitter = glitter;
  } else if (v.glitter !== undefined) {
    parseWarn(`[theme] ${source}: satin "glitter" isn't an object, dropped`);
  }
  if (Array.isArray(v.pools)) {
    const pools = v.pools.map(parsePool).filter((p): p is Pool => !!p);
    if (pools.length < v.pools.length) {
      parseWarn(
        `[theme] ${source}: a satin pool needs at, radius, a hex colour and intensity, dropped`,
      );
    }
    if (pools.length > SATIN_MAX_POOLS) {
      parseWarn(`[theme] ${source}: satin keeps the first ${SATIN_MAX_POOLS} pools`);
    }
    if (pools.length > 0) out.pools = pools.slice(0, SATIN_MAX_POOLS);
  } else if (v.pools !== undefined) {
    parseWarn(`[theme] ${source}: satin "pools" isn't an array, dropped`);
  }
  return out;
}
