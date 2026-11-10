import type { LightSpace, LightVolumetricSpec } from "../theme/tokens";
import { parseWarn } from "./parseWarnings";

/** A spot's `volumetric` block, parsed with the sidecar contract: out-of-range numbers clamp, a malformed piece drops with a warning, and only authored keys come back, so a parse round-trips. Pure: sceneLighting stays three-free. */

type Vec3 = [number, number, number];
type Pair = [number, number];

const SHADOW_SIZES = [512, 1024, 2048, 4096];
const MAX_BARS = 512;
const MAX_DUST = 20000;
const HEX = /^#[0-9a-f]{6}$/i;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function vec3(v: unknown): Vec3 | undefined {
  return Array.isArray(v) && v.length === 3 && v.every(isNum) ? [v[0], v[1], v[2]] : undefined;
}

/** An ordered pair inside [lo, hi]. */
function pair(v: unknown, lo: number, hi: number): Pair | undefined {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) return undefined;
  const a = clamp(Math.min(v[0], v[1]), lo, hi);
  const b = clamp(Math.max(v[0], v[1]), lo, hi);
  return [a, b];
}

/** Copies each listed number that is finite, clamped. */
function numbers<T extends object>(
  out: T,
  raw: Record<string, unknown>,
  ranges: Record<string, Pair>,
): void {
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    if (isNum(raw[key])) (out as Record<string, number>)[key] = clamp(raw[key], lo, hi);
  }
}

function parseGrate(raw: unknown, where: string): LightVolumetricSpec["grate"] | undefined {
  if (!isRecord(raw)) {
    parseWarn(`[lighting] ${where}: "grate" isn't an object, dropped`);
    return undefined;
  }
  const out: NonNullable<LightVolumetricSpec["grate"]> = {};
  if (raw.lens === "camera") out.lens = "camera";
  else if (raw.lens !== undefined) {
    const lens = vec3(raw.lens);
    if (lens) out.lens = lens;
    else parseWarn(`[lighting] ${where}: grate lens must be "camera" or [x, y, z], dropped`);
  }
  numbers(out, raw, { offset: [0.01, 10], width: [0.01, 100], soft: [0, 1] });
  if (isNum(raw.seed)) out.seed = Math.trunc(raw.seed);
  const along = pair(raw.along, 0, 100);
  if (along) out.along = along;
  const slat = pair(raw.slat, 0.0005, 10);
  if (slat) out.slat = slat;
  const gap = pair(raw.gap, 0.0005, 10);
  if (gap) out.gap = gap;
  if (isRecord(raw.wideGap) && isNum(raw.wideGap.p)) {
    const range = pair(raw.wideGap.range, 0.0005, 10);
    if (range) out.wideGap = { p: clamp(raw.wideGap.p, 0, 1), range };
  }
  if (Array.isArray(raw.bars)) {
    const bars = raw.bars
      .map((b) => pair(b, -1000, 1000))
      .filter((b): b is Pair => !!b && b[1] > b[0])
      .slice(0, MAX_BARS);
    if (bars.length > 0) out.bars = bars;
  }
  return out;
}

function parseBox(raw: unknown, where: string): LightVolumetricSpec["box"] | undefined {
  if (isRecord(raw)) {
    const min = vec3(raw.min);
    const max = vec3(raw.max);
    if (min && max?.every((v, i) => v > min[i])) return { min, max };
  }
  parseWarn(`[lighting] ${where}: "box" needs min and max [x, y, z] with max above min, dropped`);
  return undefined;
}

function parseSmoke(raw: unknown, where: string): LightVolumetricSpec["smoke"] | undefined {
  if (!isRecord(raw)) {
    parseWarn(`[lighting] ${where}: "smoke" isn't an object, dropped`);
    return undefined;
  }
  const out: NonNullable<LightVolumetricSpec["smoke"]> = {};
  numbers(out, raw, {
    scale: [0.001, 10],
    warp: [0, 10],
    warpScale: [0.001, 10],
    floor: [0, 1],
    evolve: [0, 10],
    warpEvolve: [0, 10],
  });
  const contrast = pair(raw.contrast, 0, 1);
  if (contrast) out.contrast = contrast;
  const drift = vec3(raw.drift);
  if (drift) out.drift = drift;
  const offset = vec3(raw.offset);
  if (offset) out.offset = offset;
  const f = raw.frontFade;
  if (isRecord(f) && isNum(f.z0) && isNum(f.z1) && isNum(f.min) && f.z1 > f.z0) {
    out.frontFade = { z0: f.z0, z1: f.z1, min: clamp(f.min, 0, 1) };
  }
  return out;
}

function parseDust(raw: unknown, where: string): LightVolumetricSpec["dust"] | undefined {
  if (raw === true) return {};
  if (!isRecord(raw)) {
    parseWarn(`[lighting] ${where}: "dust" must be true or an object, dropped`);
    return undefined;
  }
  const out: NonNullable<LightVolumetricSpec["dust"]> = {};
  numbers(out, raw, {
    jitter: [0, 10],
    jitterScale: [0.001, 100],
    jitterSpeed: [0, 10],
    forward: [-0.99, 0.99],
    gain: [0, 100],
  });
  if (isNum(raw.count)) out.count = Math.round(clamp(raw.count, 0, MAX_DUST));
  if (isNum(raw.seed)) out.seed = Math.trunc(raw.seed);
  const radius = pair(raw.radius, 0, 1);
  if (radius) out.radius = radius;
  const min = vec3(raw.min);
  const max = vec3(raw.max);
  if (min && max?.every((v, i) => v > min[i])) {
    out.min = min;
    out.max = max;
  }
  const drift = vec3(raw.drift);
  if (drift) out.drift = drift;
  if (typeof raw.color === "string" && HEX.test(raw.color)) out.color = raw.color.toLowerCase();
  return out;
}

export function parseVolumetric(
  raw: unknown,
  where: string,
  space: LightSpace = "world",
): LightVolumetricSpec | undefined {
  if (!isRecord(raw)) {
    parseWarn(`[lighting] ${where}: "volumetric" isn't an object, dropped`);
    return undefined;
  }
  const out: LightVolumetricSpec = {};
  if (raw.grate !== undefined && space !== "world") {
    parseWarn(`[lighting] ${where}: a grate needs a world-space light, dropped`);
  } else if (raw.grate !== undefined) {
    const grate = parseGrate(raw.grate, where);
    if (grate) out.grate = grate;
  }
  if (raw.box !== undefined) {
    const box = parseBox(raw.box, where);
    if (box) out.box = box;
  }
  if (isRecord(raw.haze)) {
    const haze: NonNullable<LightVolumetricSpec["haze"]> = {};
    numbers(haze, raw.haze, {
      density: [0, 5],
      anisotropy: [-0.99, 0.99],
      strength: [0, 100],
      heightFalloff: [0, 10],
      groundFade: [0, 50],
    });
    out.haze = haze;
  } else if (raw.haze !== undefined) {
    parseWarn(`[lighting] ${where}: "haze" isn't an object, dropped`);
  }
  if (raw.smoke !== undefined) {
    const smoke = parseSmoke(raw.smoke, where);
    if (smoke) out.smoke = smoke;
  }
  if (raw.extinction === true) out.extinction = true;
  if (raw.dust !== undefined && raw.dust !== false) {
    const dust = parseDust(raw.dust, where);
    if (dust) out.dust = dust;
  }
  if (isNum(raw.shadowMapSize)) {
    if (SHADOW_SIZES.includes(raw.shadowMapSize)) out.shadowMapSize = raw.shadowMapSize;
    else parseWarn(`[lighting] ${where}: shadowMapSize must be 512, 1024, 2048 or 4096, dropped`);
  }
  return out;
}
