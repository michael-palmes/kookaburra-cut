import type {
  FixtureRepeat,
  FixtureSpec,
  LightingKey,
  LightingPose,
  LightingSegment,
  LightingSpec,
  LightSpace,
  LightSpec,
  Placement,
  SunSpec,
  Theme,
  ThemeLightSpec,
  ThemeShadowSpec,
} from "../theme/tokens";
import { ease } from "./ease";
import { KELVIN_MAX, KELVIN_MIN, kelvinToHex } from "./kelvin";

/** v9 lighting: deep validation + the three-layer resolve (mirrors sceneCamera.ts). Pure (no three.js, no clock reads, no store imports — theme/schema.ts imports this module, so it must stay leaf-level) so preview and export agree by construction. Parsing follows parseSceneDoc's degrade-don't-crash contract: a malformed block drops whole, a malformed entry inside `lights`/`fixtures` drops that entry only, out-of-range numbers clamp, missing/duplicate ids drop the entry. Byte-identity invariant: `resolveLighting` returns undefined whenever no layer contributes a renderable rig, so pre-v9 projects run the legacy path verbatim. See docs/determinism.md. */

// ── Scene-lighting caps (export contract; re-exported by engine/format.ts) ──
// Enforced identically in preview and export (a cap that differs between them breaks determinism by definition); over-cap entries drop deterministically in declaration order, warned, never silently.

/** Sun `angularDeg` -> shadow softness reference (softness = angularDeg / this, clamped 0..1). The v8 default softness 0.5 corresponds to angularDeg 4. CHANGING THIS REBASES EVERY LIT PROJECT. */
export const SUN_ANGULAR_REFERENCE = 8;
/** Max simultaneous shadow-casting lights, sun included. */
export const MAX_SHADOW_CASTERS = 4;
/** Max lights in a resolved scene, sun and fixture-paired lights included; bounds three.js shader permutations (a light-count change forces a recompile). */
export const MAX_SCENE_LIGHTS = 16;
/** Max resolved fixture instances after repeat and mirror. */
export const FIXTURE_MAX_COUNT = 64;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const finite3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const LIGHT_SPACES: LightSpace[] = ["world", "camera", "subject"];
const FIXTURE_FORMS: FixtureSpec["form"][] = ["tube", "panel", "ring", "strip", "bulb"];
const AXES = ["x", "y", "z"] as const;

function parseV8LightSpec(v: unknown): ThemeLightSpec | undefined {
  if (!isRecord(v)) return undefined;
  if (!isNum(v.azimuthDeg) || !isNum(v.elevationDeg) || !isNum(v.intensity)) return undefined;
  const light: ThemeLightSpec = {
    azimuthDeg: v.azimuthDeg,
    elevationDeg: v.elevationDeg,
    intensity: v.intensity,
  };
  if (isStr(v.color)) light.color = v.color;
  return light;
}

function parseShadowSpec(v: unknown): ThemeShadowSpec | undefined {
  if (!isRecord(v)) return undefined;
  if (v.technique !== "map" && v.technique !== "none") return undefined;
  if (!isNum(v.softness) || !isNum(v.opacity) || !isNum(v.mapSize) || !isNum(v.bias)) {
    return undefined;
  }
  const shadow: ThemeShadowSpec = {
    technique: v.technique,
    softness: v.softness,
    opacity: v.opacity,
    mapSize: v.mapSize,
    bias: v.bias,
  };
  if (isStr(v.color)) shadow.color = v.color;
  return shadow;
}

/** Shared colour union fields (sun, lights, fixtures): kelvin clamps, token/hex pass as strings. */
function assignColour(
  out: { kelvin?: number; colorToken?: string; color?: string },
  v: Record<string, unknown>,
): void {
  if (isNum(v.kelvin)) out.kelvin = clamp(v.kelvin, KELVIN_MIN, KELVIN_MAX);
  if (isStr(v.colorToken)) out.colorToken = v.colorToken;
  if (isStr(v.color)) out.color = v.color;
}

function parseSun(v: unknown): SunSpec | undefined {
  const base = parseV8LightSpec(v);
  if (!base || !isRecord(v)) return undefined;
  const sun: SunSpec = { ...base };
  assignColour(sun, v);
  if (isNum(v.angularDeg)) sun.angularDeg = clamp(v.angularDeg, 0, 90);
  if (typeof v.castShadow === "boolean") sun.castShadow = v.castShadow;
  if (typeof v.enabled === "boolean") sun.enabled = v.enabled;
  return sun;
}

function parsePlacement(v: unknown): Placement | undefined {
  if (!isRecord(v)) return undefined;
  if (v.mode === "orbit") {
    if (!isNum(v.azimuthDeg) || !isNum(v.elevationDeg) || !isNum(v.distance)) return undefined;
    return {
      mode: "orbit",
      azimuthDeg: v.azimuthDeg,
      elevationDeg: v.elevationDeg,
      distance: Math.max(0, v.distance),
    };
  }
  if (v.mode === "point") {
    if (!finite3(v.position)) return undefined;
    return { mode: "point", position: [v.position[0], v.position[1], v.position[2]] };
  }
  return undefined;
}

/** Shared entry fields for lights and fixtures (id is required; keyframes reference it). */
function parseEntryBase(
  v: Record<string, unknown>,
  source: string,
  what: string,
): { id: string; name?: string; enabled?: boolean; space?: LightSpace } | undefined {
  if (!isStr(v.id)) {
    console.warn(`[lighting] ${source}: ${what} needs a string "id" — dropped`);
    return undefined;
  }
  const out: { id: string; name?: string; enabled?: boolean; space?: LightSpace } = { id: v.id };
  if (isStr(v.name)) out.name = v.name;
  if (typeof v.enabled === "boolean") out.enabled = v.enabled;
  if (v.space !== undefined) {
    if (LIGHT_SPACES.includes(v.space as LightSpace)) out.space = v.space as LightSpace;
    else console.warn(`[lighting] ${source}: ${what} "${v.id}" has an unknown space — using world`);
  }
  return out;
}

function parseLight(v: unknown, source: string): LightSpec | undefined {
  if (!isRecord(v)) return undefined;
  const base = parseEntryBase(v, source, "light");
  if (!base) return undefined;
  if (!isNum(v.intensity)) {
    console.warn(`[lighting] ${source}: light "${base.id}" needs a numeric intensity — dropped`);
    return undefined;
  }
  const placement = parsePlacement(v.placement);
  if (!placement) {
    console.warn(`[lighting] ${source}: light "${base.id}" has an invalid placement — dropped`);
    return undefined;
  }
  const shared = { ...base, intensity: v.intensity, placement };
  assignColour(shared as LightSpec, v);
  if (finite3(v.target)) {
    (shared as LightSpec).target = [v.target[0], v.target[1], v.target[2]];
  }
  const castShadow = v.castShadow === true;
  switch (v.type) {
    case "directional": {
      const light: LightSpec = { ...shared, type: "directional" };
      if (castShadow) light.castShadow = true;
      return light;
    }
    case "point": {
      const light: LightSpec = { ...shared, type: "point" };
      if (isNum(v.distance)) light.distance = Math.max(0, v.distance);
      if (isNum(v.decay)) light.decay = Math.max(0, v.decay);
      if (castShadow) {
        // Cube shadow maps cost six renders per light; not worth the memory headroom.
        console.warn(
          `[lighting] ${source}: point light "${base.id}" cannot cast shadows — flag dropped`,
        );
      }
      return light;
    }
    case "spot": {
      if (!isNum(v.angleDeg) || !isNum(v.penumbra)) {
        console.warn(
          `[lighting] ${source}: spot light "${base.id}" needs angleDeg + penumbra — dropped`,
        );
        return undefined;
      }
      const light: LightSpec = {
        ...shared,
        type: "spot",
        angleDeg: clamp(v.angleDeg, 1, 179),
        penumbra: clamp(v.penumbra, 0, 1),
      };
      if (isNum(v.distance)) light.distance = Math.max(0, v.distance);
      if (isNum(v.decay)) light.decay = Math.max(0, v.decay);
      if (castShadow) light.castShadow = true;
      return light;
    }
    case "area": {
      if (!isNum(v.width) || !isNum(v.height) || v.width <= 0 || v.height <= 0) {
        console.warn(
          `[lighting] ${source}: area light "${base.id}" needs positive width + height — dropped`,
        );
        return undefined;
      }
      const light: LightSpec = { ...shared, type: "area", width: v.width, height: v.height };
      if (castShadow) {
        // three.js cannot shadow-cast from RectAreaLight (upstream #14161).
        console.warn(
          `[lighting] ${source}: area light "${base.id}" cannot cast shadows — flag dropped`,
        );
      }
      return light;
    }
    default:
      console.warn(`[lighting] ${source}: light "${base.id}" has an unknown type — dropped`);
      return undefined;
  }
}

function parseRepeat(v: unknown, source: string, id: string): FixtureRepeat | undefined {
  if (!isRecord(v)) return undefined;
  if (!isNum(v.count) || !isNum(v.spacing) || !AXES.includes(v.axis as (typeof AXES)[number])) {
    console.warn(`[lighting] ${source}: fixture "${id}" has an invalid repeat — dropped`);
    return undefined;
  }
  const repeat: FixtureRepeat = {
    count: clamp(Math.round(v.count), 1, FIXTURE_MAX_COUNT),
    spacing: v.spacing,
    axis: v.axis as FixtureRepeat["axis"],
  };
  if (AXES.includes(v.mirrorAxis as (typeof AXES)[number])) {
    repeat.mirrorAxis = v.mirrorAxis as FixtureRepeat["axis"];
  }
  if (isNum(v.jitter)) repeat.jitter = clamp(v.jitter, 0, 1);
  return repeat;
}

function parseFixture(v: unknown, source: string): FixtureSpec | undefined {
  if (!isRecord(v)) return undefined;
  const base = parseEntryBase(v, source, "fixture");
  if (!base) return undefined;
  if (!FIXTURE_FORMS.includes(v.form as FixtureSpec["form"])) {
    console.warn(`[lighting] ${source}: fixture "${base.id}" has an unknown form — dropped`);
    return undefined;
  }
  if (
    !Array.isArray(v.size) ||
    v.size.length !== 2 ||
    !isNum(v.size[0]) ||
    !isNum(v.size[1]) ||
    v.size[0] <= 0 ||
    v.size[1] < 0
  ) {
    console.warn(`[lighting] ${source}: fixture "${base.id}" needs a [w, h] size — dropped`);
    return undefined;
  }
  if (!isNum(v.emissive) || !isNum(v.lightIntensity)) {
    console.warn(
      `[lighting] ${source}: fixture "${base.id}" needs emissive + lightIntensity — dropped`,
    );
    return undefined;
  }
  const placement = parsePlacement(v.placement);
  if (!placement) {
    console.warn(`[lighting] ${source}: fixture "${base.id}" has an invalid placement — dropped`);
    return undefined;
  }
  const fixture: FixtureSpec = {
    ...base,
    form: v.form as FixtureSpec["form"],
    size: [v.size[0], v.size[1]],
    emissive: Math.max(0, v.emissive),
    lightIntensity: Math.max(0, v.lightIntensity),
    placement,
  };
  assignColour(fixture, v);
  if (v.envMirror === true) fixture.envMirror = true;
  if (finite3(v.rotationDeg)) {
    fixture.rotationDeg = [v.rotationDeg[0], v.rotationDeg[1], v.rotationDeg[2]];
  }
  if (v.repeat !== undefined) {
    const repeat = parseRepeat(v.repeat, source, base.id);
    if (repeat) fixture.repeat = repeat;
  }
  return fixture;
}

/** Keep-first id dedupe (the scene-file uniqueness house rule). */
function dedupeById<T extends { id: string }>(entries: T[], source: string, what: string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      console.warn(`[lighting] ${source}: duplicate ${what} id "${entry.id}" — dropped`);
      continue;
    }
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

/** Deep-validate one layer's lighting block. `themeLayer` keeps the v8 theme contract: a block with neither a renderable v8 rig (key/sun + ambient) nor any v9 content drops whole with the original warning, so legacy theme files parse to the byte-identical result. Returns null when nothing valid survives. */
export function normalizeLighting(
  raw: unknown,
  source: string,
  opts: { themeLayer?: boolean } = {},
): LightingSpec | null {
  if (!isRecord(raw)) return null;
  const out: LightingSpec = {};

  // `key` is the v8 alias for `sun`; `sun` wins when both are present. Nothing rewrites files.
  const sun = parseSun(raw.sun) ?? parseSun(raw.key);
  if (sun) out.sun = sun;
  else if (raw.sun !== undefined || raw.key !== undefined) {
    console.warn(`[lighting] ${source}: invalid sun/key light — dropped`);
  }
  if (isNum(raw.ambient)) out.ambient = raw.ambient;

  if (Array.isArray(raw.fills)) {
    const fills: ThemeLightSpec[] = [];
    for (const f of raw.fills) {
      const fill = parseV8LightSpec(f);
      if (fill) fills.push(fill);
      else console.warn(`[lighting] ${source}: invalid fill light — dropped`);
    }
    out.fills = fills;
  }

  if (raw.environment !== undefined) {
    if (isRecord(raw.environment) && isStr(raw.environment.source)) {
      out.environment = {
        source: raw.environment.source,
        intensity: isNum(raw.environment.intensity) ? raw.environment.intensity : 1,
        rotationDeg: isNum(raw.environment.rotationDeg) ? raw.environment.rotationDeg : 0,
      };
    } else {
      console.warn(`[lighting] ${source}: "environment" needs a string source — dropped`);
    }
  }

  if (Array.isArray(raw.lights)) {
    const lights = dedupeById(
      raw.lights.map((l) => parseLight(l, source)).filter((l): l is LightSpec => !!l),
      source,
      "light",
    );
    if (lights.length > MAX_SCENE_LIGHTS) {
      console.warn(
        `[lighting] ${source}: ${lights.length} lights exceeds the cap of ${MAX_SCENE_LIGHTS} — extra lights dropped`,
      );
      lights.length = MAX_SCENE_LIGHTS;
    }
    out.lights = lights;
  }

  if (Array.isArray(raw.fixtures)) {
    out.fixtures = dedupeById(
      raw.fixtures.map((f) => parseFixture(f, source)).filter((f): f is FixtureSpec => !!f),
      source,
      "fixture",
    );
  }

  if (raw.shadow !== undefined) {
    const shadow = parseShadowSpec(raw.shadow);
    if (shadow) out.shadow = shadow;
    else console.warn(`[lighting] ${source}: invalid "lighting.shadow" — dropped`);
  }
  if (isStr(raw.preset)) out.preset = raw.preset;

  // The keyframe track passes through RAW (the camera sidecar precedent); deep validation runs in normalizeLightingTrack at build, against the RESOLVED spec's ids.
  if (Array.isArray(raw.keys) && raw.keys.length > 0 && !opts.themeLayer) {
    out.keys = raw.keys as LightingKey[];
    if (Array.isArray(raw.segments)) out.segments = raw.segments as LightingSegment[];
  }

  if (opts.themeLayer && !hasV8Rig(out) && !hasV9Content(out)) {
    console.warn(`[theme] ${source}: "lighting" needs a valid key light + ambient — dropped`);
    return null;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const hasV8Rig = (spec: LightingSpec): boolean =>
  spec.sun !== undefined && spec.ambient !== undefined;
const hasV9Content = (spec: LightingSpec): boolean =>
  (spec.lights?.length ?? 0) > 0 || (spec.fixtures?.length ?? 0) > 0;

const MERGE_FIELDS = [
  "environment",
  "sun",
  "ambient",
  "fills",
  "lights",
  "fixtures",
  "shadow",
  "preset",
] as const;

/** The three-layer resolve: theme -> project -> scene, each present field fully replacing the one below (lists replace wholesale; merging by id was rejected as complexity without honesty). Returns undefined when the merged result cannot light a scene — the exact v8 rule (key/sun + ambient) widened by v9 content — so an absent-everywhere block keeps the legacy path verbatim. */
export function resolveLighting(
  theme: LightingSpec | undefined,
  project: LightingSpec | undefined,
  scene: LightingSpec | undefined,
): LightingSpec | undefined {
  if (!theme && !project && !scene) return undefined;
  const merged: LightingSpec = {};
  for (const field of MERGE_FIELDS) {
    const value = scene?.[field] ?? project?.[field] ?? theme?.[field];
    if (value !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: keyed copy over a closed field list
      (merged as any)[field] = value;
    }
  }
  return hasV8Rig(merged) || hasV9Content(merged) ? merged : undefined;
}

/** `angleDeg` (the FULL cone, how artists think) -> three's `SpotLight.angle` (radian HALF-angle). One conversion, one place, unit-tested. */
export function spotHalfAngleRad(angleDeg: number): number {
  return (angleDeg * Math.PI) / 360;
}

/** The deterministic render budget for a resolved spec, identical in preview and export. The sun takes the first shadow slot when it casts; free lights then claim caster slots in declaration order up to MAX_SHADOW_CASTERS (only directional and spot may cast), and the light list itself caps at MAX_SCENE_LIGHTS minus the sun's slot. Over-budget entries drop deterministically, counted for the caller to warn about, never silently. */
export function resolveLightBudget(
  spec: LightingSpec,
  sunCasts: boolean,
): {
  lights: LightSpec[];
  shadowCasterIds: Set<string>;
  droppedLights: number;
  droppedCasters: number;
} {
  const enabled = (spec.lights ?? []).filter((l) => l.enabled !== false);
  const lightBudget = MAX_SCENE_LIGHTS - (spec.sun && spec.sun.enabled !== false ? 1 : 0);
  const lights = enabled.slice(0, Math.max(0, lightBudget));
  const shadowCasterIds = new Set<string>();
  let casterBudget = MAX_SHADOW_CASTERS - (sunCasts ? 1 : 0);
  let droppedCasters = 0;
  for (const light of lights) {
    if (light.castShadow !== true) continue;
    if (light.type !== "directional" && light.type !== "spot") continue;
    if (casterBudget > 0) {
      shadowCasterIds.add(light.id);
      casterBudget -= 1;
    } else {
      droppedCasters += 1;
    }
  }
  return { lights, shadowCasterIds, droppedLights: enabled.length - lights.length, droppedCasters };
}

/** Sun angular diameter -> VSM softness: angularDeg / SUN_ANGULAR_REFERENCE clamped 0..1, so the v8 default softness 0.5 corresponds to angularDeg 4 (no pixel change reading existing themes). Falls back to the shadow block's raw softness when the sun doesn't carry angularDeg. */
export function sunShadowSoftness(
  sun: SunSpec | undefined,
  shadow: ThemeShadowSpec | undefined,
): number {
  if (sun?.angularDeg !== undefined) return clamp(sun.angularDeg / SUN_ANGULAR_REFERENCE, 0, 1);
  return shadow?.softness ?? 0.5;
}

/** The colour union, resolved to a hex string (the same `new Color(hex)` path every token takes): kelvin wins, then the theme token (a swap restyles the rig), then hex, then white. Unknown tokens warn and fall through rather than dropping the light. */
export function resolveLightingColour(
  spec: { kelvin?: number; colorToken?: string; color?: string },
  colors: Theme["colors"],
): string {
  if (spec.kelvin !== undefined) return kelvinToHex(spec.kelvin);
  if (spec.colorToken !== undefined) {
    const token = colors[spec.colorToken as keyof Theme["colors"]];
    if (typeof token === "string") return token;
    console.warn(`[lighting] unknown colour token "${spec.colorToken}" — falling through`);
  }
  return spec.color ?? "#ffffff";
}

// ── Lighting keyframes (v9 · PR 6) ──────────────────────────────────
// One sparse whole-rig track per scene, riding keyedTrack.ts exactly like the camera. Every sampled value is a pure function of the resolved timeline position: nothing reads the wall clock and nothing accumulates across frames (the determinism rule that survives the "lighting is static" reversal; see docs/determinism.md).

/** Validate + normalise a lighting block's keyframe track against its RESOLVED spec (degrade-don't-crash, the normalizeSceneCamera pattern): bad keys/segments drop with a console note; pose entries referencing unknown light/fixture ids drop that entry only. Returns null when nothing keyed survives. */
export function normalizeLightingTrack(
  spec: LightingSpec | undefined,
  source: string,
): LightingTrack | null {
  const rawKeys = spec?.keys;
  if (!spec || !Array.isArray(rawKeys) || rawKeys.length === 0) return null;
  const lightIds = new Set((spec.lights ?? []).map((l) => l.id));
  const fixtureIds = new Set((spec.fixtures ?? []).map((f) => f.id));
  const keys: LightingKey[] = [];
  const seen = new Set<string>();
  for (const key of rawKeys) {
    if (!key || typeof key.id !== "string" || !Number.isFinite(key.tMs) || !isRecord(key.pose)) {
      console.warn(`[lighting] ${source}: invalid lighting key — dropped`);
      continue;
    }
    if (seen.has(key.id)) {
      console.warn(`[lighting] ${source}: duplicate lighting key id "${key.id}" — dropped`);
      continue;
    }
    seen.add(key.id);
    const pose = normalizePose(key.pose, lightIds, fixtureIds, source);
    keys.push({ id: key.id, tMs: key.tMs < 0 ? 0 : key.tMs, pose });
  }
  if (keys.length === 0) return null;
  keys.sort((a, b) => a.tMs - b.tMs);

  const byId = new Map(keys.map((k) => [k.id, k]));
  const segments: LightingSegment[] = [];
  for (const seg of spec.segments ?? []) {
    const from = seg ? byId.get(seg.from) : undefined;
    const to = seg ? byId.get(seg.to) : undefined;
    if (!from || !to || from.tMs >= to.tMs) {
      console.warn(`[lighting] ${source}: invalid lighting segment — dropped`);
      continue;
    }
    segments.push({ from: seg.from, to: seg.to, ease: seg.ease });
  }
  segments.sort((a, b) => (byId.get(a.from)?.tMs ?? 0) - (byId.get(b.from)?.tMs ?? 0));
  const ordered: LightingSegment[] = [];
  for (const seg of segments) {
    const prev = ordered[ordered.length - 1];
    if (prev && (byId.get(seg.from)?.tMs ?? 0) < (byId.get(prev.to)?.tMs ?? 0)) {
      console.warn(`[lighting] ${source}: overlapping lighting segment — dropped`);
      continue;
    }
    ordered.push(seg);
  }
  return { keys, segments: ordered };
}

export type LightingTrack = { keys: LightingKey[]; segments: LightingSegment[] };

function normalizePose(
  raw: Record<string, unknown>,
  lightIds: ReadonlySet<string>,
  fixtureIds: ReadonlySet<string>,
  source: string,
): LightingPose {
  const pose: LightingPose = {};
  if (isNum(raw.ambient)) pose.ambient = raw.ambient;
  if (isNum(raw.environmentIntensity)) pose.environmentIntensity = raw.environmentIntensity;
  if (isNum(raw.environmentRotationDeg)) pose.environmentRotationDeg = raw.environmentRotationDeg;
  if (isRecord(raw.sun)) {
    const sun: NonNullable<LightingPose["sun"]> = {};
    if (isNum(raw.sun.azimuthDeg)) sun.azimuthDeg = raw.sun.azimuthDeg;
    if (isNum(raw.sun.elevationDeg)) sun.elevationDeg = raw.sun.elevationDeg;
    if (isNum(raw.sun.intensity)) sun.intensity = raw.sun.intensity;
    if (isNum(raw.sun.kelvin)) sun.kelvin = clamp(raw.sun.kelvin, KELVIN_MIN, KELVIN_MAX);
    if (Object.keys(sun).length > 0) pose.sun = sun;
  }
  if (isRecord(raw.lights)) {
    const lights: NonNullable<LightingPose["lights"]> = {};
    for (const [id, value] of Object.entries(raw.lights)) {
      if (!lightIds.has(id)) {
        console.warn(`[lighting] ${source}: key references unknown light "${id}" — entry dropped`);
        continue;
      }
      if (!isRecord(value)) continue;
      const entry: NonNullable<LightingPose["lights"]>[string] = {};
      if (isNum(value.intensity)) entry.intensity = value.intensity;
      if (isNum(value.kelvin)) entry.kelvin = clamp(value.kelvin, KELVIN_MIN, KELVIN_MAX);
      const placement = parsePlacement(value.placement);
      if (placement) entry.placement = placement;
      if (Object.keys(entry).length > 0) lights[id] = entry;
    }
    if (Object.keys(lights).length > 0) pose.lights = lights;
  }
  if (isRecord(raw.fixtures)) {
    const fixtures: NonNullable<LightingPose["fixtures"]> = {};
    for (const [id, value] of Object.entries(raw.fixtures)) {
      if (!fixtureIds.has(id)) {
        console.warn(
          `[lighting] ${source}: key references unknown fixture "${id}" — entry dropped`,
        );
        continue;
      }
      if (!isRecord(value)) continue;
      const entry: NonNullable<LightingPose["fixtures"]>[string] = {};
      if (isNum(value.emissive)) entry.emissive = Math.max(0, value.emissive);
      if (isNum(value.lightIntensity)) entry.lightIntensity = Math.max(0, value.lightIntensity);
      if (Object.keys(entry).length > 0) fixtures[id] = entry;
    }
    if (Object.keys(fixtures).length > 0) pose.fixtures = fixtures;
  }
  return pose;
}

const lerpNum = (a: number, b: number, t: number): number => a + (b - a) * t;

function mixMaybe(a: number | undefined, b: number | undefined, t: number): number | undefined {
  // A field present at only one endpoint HOLDS the from value inside the segment (sparse rule).
  if (a === undefined) return undefined;
  if (b === undefined) return a;
  return lerpNum(a, b, t);
}

/** Interpolate two placements: both orbit stays in orbit space; any point normalises both endpoints to point (the documented rule, tested; interpolating orbit against point directly is undefined). */
export function mixPlacement(a: Placement, b: Placement, t: number): Placement {
  if (a.mode === "orbit" && b.mode === "orbit") {
    return {
      mode: "orbit",
      azimuthDeg: lerpNum(a.azimuthDeg, b.azimuthDeg, t),
      elevationDeg: lerpNum(a.elevationDeg, b.elevationDeg, t),
      distance: lerpNum(a.distance, b.distance, t),
    };
  }
  const pa = a.mode === "point" ? a.position : placementPositionOf(a);
  const pb = b.mode === "point" ? b.position : placementPositionOf(b);
  return {
    mode: "point",
    position: [lerpNum(pa[0], pb[0], t), lerpNum(pa[1], pb[1], t), lerpNum(pa[2], pb[2], t)],
  };
}

function placementPositionOf(p: Extract<Placement, { mode: "orbit" }>): [number, number, number] {
  const az = (p.azimuthDeg * Math.PI) / 180;
  const el = (p.elevationDeg * Math.PI) / 180;
  return [
    p.distance * Math.cos(el) * Math.sin(az),
    p.distance * Math.sin(el),
    p.distance * Math.cos(el) * Math.cos(az),
  ];
}

function mixPose(a: LightingPose, b: LightingPose, t: number): LightingPose {
  const out: LightingPose = {};
  const ambient = mixMaybe(a.ambient, b.ambient, t);
  if (ambient !== undefined) out.ambient = ambient;
  const envI = mixMaybe(a.environmentIntensity, b.environmentIntensity, t);
  if (envI !== undefined) out.environmentIntensity = envI;
  const envR = mixMaybe(a.environmentRotationDeg, b.environmentRotationDeg, t);
  if (envR !== undefined) out.environmentRotationDeg = envR;
  if (a.sun) {
    const sun: NonNullable<LightingPose["sun"]> = {};
    for (const field of ["azimuthDeg", "elevationDeg", "intensity", "kelvin"] as const) {
      const v = mixMaybe(a.sun[field], b.sun?.[field], t);
      if (v !== undefined) sun[field] = v;
    }
    if (Object.keys(sun).length > 0) out.sun = sun;
  }
  if (a.lights) {
    const lights: NonNullable<LightingPose["lights"]> = {};
    for (const [id, from] of Object.entries(a.lights)) {
      const to = b.lights?.[id];
      const entry: NonNullable<LightingPose["lights"]>[string] = {};
      const intensity = mixMaybe(from.intensity, to?.intensity, t);
      if (intensity !== undefined) entry.intensity = intensity;
      const kelvin = mixMaybe(from.kelvin, to?.kelvin, t);
      if (kelvin !== undefined) entry.kelvin = kelvin;
      if (from.placement) {
        entry.placement = to?.placement
          ? mixPlacement(from.placement, to.placement, t)
          : from.placement;
      }
      if (Object.keys(entry).length > 0) lights[id] = entry;
    }
    if (Object.keys(lights).length > 0) out.lights = lights;
  }
  if (a.fixtures) {
    const fixtures: NonNullable<LightingPose["fixtures"]> = {};
    for (const [id, from] of Object.entries(a.fixtures)) {
      const to = b.fixtures?.[id];
      const entry: NonNullable<LightingPose["fixtures"]>[string] = {};
      const emissive = mixMaybe(from.emissive, to?.emissive, t);
      if (emissive !== undefined) entry.emissive = emissive;
      const lightIntensity = mixMaybe(from.lightIntensity, to?.lightIntensity, t);
      if (lightIntensity !== undefined) entry.lightIntensity = lightIntensity;
      if (Object.keys(entry).length > 0) fixtures[id] = entry;
    }
    if (Object.keys(fixtures).length > 0) out.fixtures = fixtures;
  }
  return out;
}

export type { LightingKey, LightingPose, LightingSegment };

/** Sample a normalized track at scene-local time (the sampleSceneCamera shape): inside a segment, eased per-field interpolation of the two sparse poses; outside, hold the latest key at/before `t`. */
export function sampleLightingPose(track: LightingTrack, localMs: number): LightingPose {
  for (const seg of track.segments) {
    const from = track.keys.find((k) => k.id === seg.from);
    const to = track.keys.find((k) => k.id === seg.to);
    if (!from || !to) continue;
    if (localMs >= from.tMs && localMs < to.tMs) {
      const p = (localMs - from.tMs) / (to.tMs - from.tMs);
      return mixPose(from.pose, to.pose, ease(seg.ease, p));
    }
  }
  let held = track.keys[0];
  for (const key of track.keys) {
    if (key.tMs <= localMs) held = key;
    else break;
  }
  return structuredClone(held.pose);
}

/** Normalize every scene's lighting track once per project load (index-aligned). Tracks live on the SCENE-DOC layer only; the resolved spec supplies the ids that keys may reference. */
export function buildLightingTracks(
  sceneThemes: readonly Theme[],
  projectLighting: LightingSpec | undefined,
  sceneDocs: readonly (SceneDocLike | undefined)[],
): (LightingTrack | null)[] {
  return sceneThemes.map((theme, i) => {
    const doc = sceneDocs[i];
    if (!doc?.lighting?.keys?.length) return null;
    const resolved = resolveLighting(theme.lighting, projectLighting, doc.lighting);
    if (!resolved) return null;
    // The track validates against the resolved spec but the raw keys/segments come from the doc layer.
    return normalizeLightingTrack(
      { ...resolved, keys: doc.lighting.keys, segments: doc.lighting.segments },
      `scene ${i}`,
    );
  });
}

/** Structural stand-in for SceneDoc (sceneDocSchema imports this module, so the real type can't be named here). */
interface SceneDocLike {
  lighting?: LightingSpec;
}

export function hasLightingTracks(
  tracks: readonly (LightingTrack | null)[] | null | undefined,
): boolean {
  return !!tracks?.some(Boolean);
}

/** One render target's sampled lighting: the scene it applies to plus the sparse pose at that target's own scene-local time. */
export interface SceneLightingSample {
  index: number;
  pose: LightingPose;
}

/** The frame's lighting plan (solo | a/b + overlay, the FrameCameraPlan shape). Null whenever no scene in the project has a lighting track: the byte-identical legacy path. On transition frames A and B are at DIFFERENT scene-local times, so each target samples its own scene's track at its own time (the camera rule; same failure mode if got wrong). */
export interface FrameLightingPlan {
  solo?: SceneLightingSample;
  a?: SceneLightingSample;
  b?: SceneLightingSample;
  overlay?: SceneLightingSample;
}

interface ResolvedLike {
  active: { index: number; localMs: number }[];
  transition?: { fromIndex: number; toIndex: number; progress: number } | null;
}

export function resolveFrameLighting(
  tracks: readonly (LightingTrack | null)[] | null | undefined,
  resolved: ResolvedLike,
): FrameLightingPlan | null {
  if (!tracks || !hasLightingTracks(tracks)) return null;
  if (resolved.active.length === 0) return null;
  const sampleFor = (active: { index: number; localMs: number }): SceneLightingSample | null => {
    const track = tracks[active.index];
    if (!track) return null;
    return { index: active.index, pose: sampleLightingPose(track, active.localMs) };
  };
  const tr = resolved.transition;
  if (resolved.active.length < 2 || !tr) {
    const solo = sampleFor(resolved.active[resolved.active.length - 1]);
    return solo ? { solo } : null;
  }
  const byIndex = new Map(resolved.active.map((s) => [s.index, s]));
  const from = byIndex.get(tr.fromIndex);
  const to = byIndex.get(tr.toIndex);
  if (!from || !to) {
    const solo = sampleFor(resolved.active[resolved.active.length - 1]);
    return solo ? { solo } : null;
  }
  const a = sampleFor(from) ?? undefined;
  const b = sampleFor(to) ?? undefined;
  if (!a && !b) return null;
  return { a, b, overlay: tr.progress < 0.5 ? a : b };
}

/** Capture the scene's CURRENT overrides as a sparse pose: only fields where the scene layer differs from the theme+project base (capturing everything would make every key a full snapshot and later base edits useless). What the "Add key" affordance writes. */
export function captureLightingPose(
  theme: Theme,
  projectLighting: LightingSpec | undefined,
  docLighting: LightingSpec | undefined,
): LightingPose {
  const base = resolveLighting(theme.lighting, projectLighting, undefined);
  const cur = resolveLighting(theme.lighting, projectLighting, docLighting);
  const pose: LightingPose = {};
  if (!cur) return pose;
  if (cur.ambient !== undefined && cur.ambient !== base?.ambient) pose.ambient = cur.ambient;
  if (cur.environment) {
    if (cur.environment.intensity !== base?.environment?.intensity) {
      pose.environmentIntensity = cur.environment.intensity;
    }
    if (cur.environment.rotationDeg !== base?.environment?.rotationDeg) {
      pose.environmentRotationDeg = cur.environment.rotationDeg;
    }
  }
  if (cur.sun) {
    const sun: NonNullable<LightingPose["sun"]> = {};
    if (cur.sun.azimuthDeg !== base?.sun?.azimuthDeg) sun.azimuthDeg = cur.sun.azimuthDeg;
    if (cur.sun.elevationDeg !== base?.sun?.elevationDeg) sun.elevationDeg = cur.sun.elevationDeg;
    if (cur.sun.intensity !== base?.sun?.intensity) sun.intensity = cur.sun.intensity;
    if (cur.sun.kelvin !== undefined && cur.sun.kelvin !== base?.sun?.kelvin) {
      sun.kelvin = cur.sun.kelvin;
    }
    if (Object.keys(sun).length > 0) pose.sun = sun;
  }
  const baseLights = new Map((base?.lights ?? []).map((l) => [l.id, l]));
  for (const light of cur.lights ?? []) {
    const b = baseLights.get(light.id);
    const entry: NonNullable<LightingPose["lights"]>[string] = {};
    if (light.intensity !== b?.intensity) entry.intensity = light.intensity;
    if (light.kelvin !== undefined && light.kelvin !== b?.kelvin) entry.kelvin = light.kelvin;
    if (JSON.stringify(light.placement) !== JSON.stringify(b?.placement)) {
      entry.placement = light.placement;
    }
    if (Object.keys(entry).length > 0) {
      pose.lights = { ...(pose.lights ?? {}), [light.id]: entry };
    }
  }
  const baseFixtures = new Map((base?.fixtures ?? []).map((f) => [f.id, f]));
  for (const fixture of cur.fixtures ?? []) {
    const b = baseFixtures.get(fixture.id);
    const entry: NonNullable<LightingPose["fixtures"]>[string] = {};
    if (fixture.emissive !== b?.emissive) entry.emissive = fixture.emissive;
    if (fixture.lightIntensity !== b?.lightIntensity) entry.lightIntensity = fixture.lightIntensity;
    if (Object.keys(entry).length > 0) {
      pose.fixtures = { ...(pose.fixtures ?? {}), [fixture.id]: entry };
    }
  }
  return pose;
}

/** Rebuild the track's segments as a chain over consecutive keys (sorted by time), preserving the ease of any pair that already had a segment. The simple-list editor's write-through; the timeline lane can still re-shape segments later. */
export function chainLightingSegments(
  keys: readonly LightingKey[],
  previous: readonly LightingSegment[] | undefined,
): LightingSegment[] {
  const sorted = [...keys].sort((a, b) => a.tMs - b.tMs);
  const eases = new Map((previous ?? []).map((s) => [`${s.from}>${s.to}`, s.ease]));
  const segments: LightingSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i].id;
    const to = sorted[i + 1].id;
    segments.push({ from, to, ease: eases.get(`${from}>${to}`) ?? "inOutSine" });
  }
  return segments;
}
