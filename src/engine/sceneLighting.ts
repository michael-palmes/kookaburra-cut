import type {
  FixtureRepeat,
  FixtureSpec,
  LightingSpec,
  LightSpace,
  LightSpec,
  Placement,
  SunSpec,
  Theme,
  ThemeLightSpec,
  ThemeShadowSpec,
} from "../theme/tokens";
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
