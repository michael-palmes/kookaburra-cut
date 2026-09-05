import { THEME_CATEGORIES, type ThemeCategoryId } from "../../theme/catalogue";
import { WORKSPACE_THEME_PREFIX } from "../../theme/registry";
import { parseThemeDoc } from "../../theme/schema";
import type { TextLookSpec, Theme, ThemeShadowSpec } from "../../theme/tokens";

/** The theme editor's draft model: the RAW theme document as parsed JSON, never the resolved `Theme`. Every section patches this object, so the `catalogue` block, any block the editor has no form for yet, and anything a newer build writes all survive a round trip untouched. Pure module (no IO, no React) so the patch maths is unit-testable. */

export type ThemeDoc = Record<string, unknown>;

/** Where a theme id lives: `ws:<slug>` reads and writes through the workspace commands, a bare id through the bundled (dev-only) ones. */
export type ThemeScope = { kind: "workspace"; slug: string } | { kind: "bundled"; id: string };

export function themeScope(themeId: string): ThemeScope {
  return themeId.startsWith(WORKSPACE_THEME_PREFIX)
    ? { kind: "workspace", slug: themeId.slice(WORKSPACE_THEME_PREFIX.length) }
    : { kind: "bundled", id: themeId };
}

export const isRecord = (value: unknown): value is ThemeDoc =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Immutable set at a dotted path, creating missing objects on the way down; `undefined` deletes the leaf (and never leaves an empty parent behind, so clearing the last field drops the block). */
export function setIn(doc: ThemeDoc, path: readonly string[], value: unknown): ThemeDoc {
  const [head, ...rest] = path;
  if (head === undefined) return doc;
  if (rest.length === 0) {
    const next = { ...doc };
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const child = isRecord(doc[head]) ? (doc[head] as ThemeDoc) : {};
  const patched = setIn(child, rest, value);
  const next = { ...doc };
  if (Object.keys(patched).length === 0) delete next[head];
  else next[head] = patched;
  return next;
}

export function getIn(doc: ThemeDoc, path: readonly string[]): unknown {
  let cursor: unknown = doc;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** Pretty JSON with a trailing newline, the shape the native writers emit. */
export function serialiseThemeDoc(doc: ThemeDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Deep key-sorted JSON. Both write commands round-trip the text through serde_json, which orders object keys alphabetically, so only an order-insensitive form can tell an edit from a rewrite. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value ?? null);
}

/** True when the draft differs from the text on disk, comparing canonical forms so key order and whitespace never masquerade as an edit. */
export function isDirty(doc: ThemeDoc, savedText: string): boolean {
  let saved: unknown;
  try {
    saved = JSON.parse(savedText);
  } catch {
    return true;
  }
  return !isRecord(saved) || canonicalJson(doc) !== canonicalJson(saved);
}

export interface ThemeDraftParse {
  /** The resolved theme, absent when a REQUIRED block (colors/typography/motion) is invalid. */
  theme?: Theme;
  /** Everything the schema warned about, surfaced in the editor instead of hiding in the console. */
  warnings: string[];
}

/** Parse the draft through the shipping schema, capturing its drop-and-warn messages: `parseThemeDoc` reports by console, and the editor must show those without blocking the edit that caused them. */
export function parseThemeDraft(doc: ThemeDoc, source: string): ThemeDraftParse {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };
  try {
    const theme = parseThemeDoc(doc, source);
    return { theme, warnings };
  } finally {
    console.warn = original;
  }
}

// ── Identity ──────────────────────────────────────────────────────────────

export interface ThemeIdentity {
  name: string;
  mode: "light" | "dark";
  category: ThemeCategoryId;
  tags: string[];
  useLabel: string;
  order: number | null;
  hidden: boolean;
}

const DEFAULT_CATEGORY: ThemeCategoryId = THEME_CATEGORIES[0].id;

export function readIdentity(doc: ThemeDoc): ThemeIdentity {
  const catalogue = isRecord(doc.catalogue) ? doc.catalogue : {};
  const category = typeof catalogue.category === "string" ? catalogue.category : "";
  const tags = Array.isArray(catalogue.tags)
    ? catalogue.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
    : [];
  return {
    name: typeof doc.name === "string" ? doc.name : "",
    mode: doc.mode === "light" ? "light" : "dark",
    category: THEME_CATEGORIES.some(({ id }) => id === category)
      ? (category as ThemeCategoryId)
      : DEFAULT_CATEGORY,
    tags,
    useLabel: typeof catalogue.useLabel === "string" ? catalogue.useLabel : "",
    order: isNum(catalogue.order) ? catalogue.order : null,
    hidden: catalogue.hidden === true,
  };
}

/** The stand-in `useLabel` when the field is blank: the catalogue block only parses with a non-empty one, and a theme whose metadata drops loses its collection and tags too. */
export const FALLBACK_USE_LABEL = "Custom theme";

/** Catalogue writes keep the block whole: `parseThemeCatalogueMetadata` rejects a partial block outright, so writing one field seeds the rest from what `readIdentity` resolved. */
export function writeIdentity(doc: ThemeDoc, patch: Partial<ThemeIdentity>): ThemeDoc {
  const next = { ...readIdentity(doc), ...patch };
  let out = doc;
  out = setIn(out, ["name"], next.name.trim() === "" ? undefined : next.name);
  out = setIn(out, ["mode"], next.mode);
  out = setIn(out, ["catalogue", "category"], next.category);
  out = setIn(
    out,
    ["catalogue", "useLabel"],
    next.useLabel.trim() === "" ? FALLBACK_USE_LABEL : next.useLabel,
  );
  out = setIn(out, ["catalogue", "tags"], next.tags);
  out = setIn(
    out,
    ["catalogue", "order"],
    next.order === null ? undefined : Math.max(0, Math.round(next.order)),
  );
  out = setIn(out, ["catalogue", "hidden"], next.hidden ? true : undefined);
  // `stage` is derived elsewhere and has no form yet; a catalogue block without it never parses.
  const stage = getIn(doc, ["catalogue", "stage"]);
  if (typeof stage !== "string") out = setIn(out, ["catalogue", "stage"], inferredStage(doc));
  return out;
}

/** The card's staging hint, read off the doc the same way `ThemePicker` infers it for workspace themes. */
export function inferredStage(doc: ThemeDoc): "physical" | "lighting-only" | "none" {
  const backdrop = doc.backdrop;
  if (isRecord(backdrop) && backdrop.type !== "none") return "physical";
  return doc.lighting !== undefined ? "lighting-only" : "none";
}

/** Tag chips: trimmed, de-duplicated case-insensitively, order preserved. */
export function addTag(tags: readonly string[], raw: string): string[] {
  const tag = raw.trim();
  if (tag === "") return [...tags];
  const seen = new Set(tags.map((existing) => existing.toLocaleLowerCase("en-AU")));
  if (seen.has(tag.toLocaleLowerCase("en-AU"))) return [...tags];
  return [...tags, tag];
}

export function removeTag(tags: readonly string[], tag: string): string[] {
  return tags.filter((existing) => existing !== tag);
}

/** A duplicate as the browser makes one: the SOURCE DOCUMENT with a new id and name, never the resolved `Theme` (which has no `catalogue` block, so a copy of it lost its collection, use label and tags). `hidden` drops, since a copy the user just asked for must be listed. */
export function duplicateThemeDoc(doc: ThemeDoc, id: string, name: string): ThemeDoc {
  const out: ThemeDoc = { ...doc, id, name };
  if (isRecord(out.catalogue)) {
    const { hidden: _hidden, ...rest } = out.catalogue;
    out.catalogue = rest;
  }
  return out;
}

// ── Colours ───────────────────────────────────────────────────────────────

export const COLOUR_SLOTS = ["background", "text", "accent", "muted"] as const;
export type ColourSlot = (typeof COLOUR_SLOTS)[number];

export function readColour(doc: ThemeDoc, slot: ColourSlot, fallback: string): string {
  const value = getIn(doc, ["colors", slot]);
  return typeof value === "string" ? value : fallback;
}

export function readChartColours(doc: ThemeDoc): string[] {
  return Array.isArray(doc.chartColors)
    ? doc.chartColors.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Chart swatches keep at least one entry: an empty array parses back to "no palette", which silently reverts to the derived accent ramp. */
export function writeChartColours(doc: ThemeDoc, colours: readonly string[]): ThemeDoc {
  return setIn(doc, ["chartColors"], colours.length === 0 ? undefined : [...colours]);
}

// ── Gradients ─────────────────────────────────────────────────────────────

export interface GradientEntry {
  name: string;
  type: "linear" | "radial";
  angleDeg: number;
  stops: [string, number][];
  space?: "oklch";
}

/** A fresh pair of stops: the shape a new gradient starts from, and the repair for a doc entry the schema would drop. */
export function defaultGradientStops(): [string, number][] {
  return [
    ["#101318", 0],
    ["#3a4a5a", 1],
  ];
}

export function readGradients(doc: ThemeDoc): GradientEntry[] {
  if (!isRecord(doc.gradients)) return [];
  return Object.entries(doc.gradients).map(([name, value]) => {
    const spec = isRecord(value) ? value : {};
    const stops = Array.isArray(spec.stops)
      ? spec.stops.flatMap((stop): [string, number][] =>
          Array.isArray(stop) && typeof stop[0] === "string" && isNum(stop[1])
            ? [[stop[0], stop[1]]]
            : [],
        )
      : [];
    return {
      name,
      type: spec.type === "radial" ? "radial" : "linear",
      angleDeg: isNum(spec.angleDeg) ? spec.angleDeg : 0,
      // A gradient the schema would drop still needs two editable stops, so the form can repair it.
      stops: stops.length >= 2 ? stops : defaultGradientStops(),
      ...(spec.space === "oklch" ? { space: "oklch" as const } : {}),
    };
  });
}

/** Rewrites the whole `gradients` block from the editor's list, so a rename keeps its position instead of jumping to the end. */
export function writeGradients(doc: ThemeDoc, entries: readonly GradientEntry[]): ThemeDoc {
  const previous = readBlock(doc, "gradients");
  const block: Record<string, unknown> = {};
  for (const entry of entries) {
    const original = previous[entry.name];
    block[entry.name] = {
      ...(isRecord(original) ? original : {}),
      type: entry.type,
      angleDeg: entry.angleDeg,
      stops: entry.stops.map(([colour, position]) => [colour, position]),
      ...(entry.space ? { space: entry.space } : {}),
    };
    if (!entry.space) delete (block[entry.name] as ThemeDoc).space;
  }
  let next = setIn(doc, ["gradients"], entries.length ? block : undefined);
  for (const [name, spec] of Object.entries(previous)) {
    if (!(name in block)) next = mapGradientReferences(next, name, undefined, spec);
  }
  return next;
}

function mapGradientReferences(
  doc: ThemeDoc,
  oldName: string,
  newName: string | undefined,
  spec: unknown,
): ThemeDoc {
  const patch = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    let next = value;
    if (value.type === "gradient" && value.gradient === oldName) {
      next = setIn(value, ["gradient"], newName);
      if (!newName && value.spec === undefined) next = setIn(next, ["spec"], spec);
    }
    if (isRecord(value.backing)) next = { ...next, backing: patch(value.backing) };
    return next;
  };
  let next = doc;
  for (const key of ["background", "backdrop"]) {
    if (doc[key] !== undefined) next = setIn(next, [key], patch(doc[key]));
  }
  return next;
}

export function renameGradient(doc: ThemeDoc, oldName: string, wanted: string): ThemeDoc {
  const entries = readGradients(doc);
  const index = entries.findIndex(({ name }) => name === oldName);
  if (index < 0) return doc;
  const newName = uniqueGradientName(entries, wanted, index);
  if (newName === oldName) return doc;
  const gradients = readBlock(doc, "gradients");
  const renamed = Object.fromEntries(
    Object.entries(gradients).map(([name, spec]) => [name === oldName ? newName : name, spec]),
  );
  return mapGradientReferences(setIn(doc, ["gradients"], renamed), oldName, newName, undefined);
}

export function writeStageGradient(
  doc: ThemeDoc,
  key: "background" | "backdrop",
  name: string,
): ThemeDoc {
  return setIn(setIn(doc, [key, "gradient"], name), [key, "spec"], undefined);
}

/** A gradient name free in `entries`, ignoring the entry at `skipIndex` (its own name during a rename). */
export function uniqueGradientName(
  entries: readonly GradientEntry[],
  wanted: string,
  skipIndex = -1,
): string {
  const taken = new Set(
    entries.flatMap((entry, index) => (index === skipIndex ? [] : [entry.name])),
  );
  const base = wanted.trim() === "" ? "gradient" : wanted.trim();
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ── Typography and motion ─────────────────────────────────────────────────

export interface FontSlotValue {
  family: string;
  weight: number;
}

export function readFontSlot(
  doc: ThemeDoc,
  slot: "headline" | "body",
  fallbackWeight: number,
): FontSlotValue {
  const value = getIn(doc, ["typography", slot]);
  if (typeof value === "string") return { family: value, weight: fallbackWeight };
  if (isRecord(value) && typeof value.family === "string") {
    return { family: value.family, weight: isNum(value.weight) ? value.weight : fallbackWeight };
  }
  return { family: "Inter", weight: fallbackWeight };
}

export const SCALE_RANGE = { min: 1, max: 2 } as const;
export const CARD_RADIUS_RANGE = { min: 0, max: 0.5 } as const;
export const DURATION_RANGE = { min: 0, max: 5000 } as const;

export function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, value));
}

export const DURATION_KEYS = ["fast", "base", "slow"] as const;
export type DurationKey = (typeof DURATION_KEYS)[number];

export function readDuration(doc: ThemeDoc, key: DurationKey, fallback: number): number {
  const value = getIn(doc, ["motion", "durations", key]);
  return isNum(value) ? value : fallback;
}

export const EASING_KEYS = ["standard", "emphasized"] as const;
export type EasingKey = (typeof EASING_KEYS)[number];

export function readEasing(doc: ThemeDoc, key: EasingKey, fallback: string): string {
  const value = getIn(doc, ["motion", "easings", key]);
  return typeof value === "string" && value !== "" ? value : fallback;
}

export function readCardRadius(doc: ThemeDoc): number | null {
  const value = getIn(doc, ["card", "radius"]);
  return isNum(value) ? value : null;
}

// ── Stage ─────────────────────────────────────────────────────────────────

/** `off` covers both an absent block and an explicit `{ type: "none" }`: for a theme they render identically (the frame clears to `colors.background`), so the form offers one state and only writes when the user picks another. */
export type BackdropKind = "off" | "floor" | "gradient" | "image";
export type BackgroundKind = "off" | "color" | "gradient" | "image" | "shader" | "scene3d";

const BACKDROP_KINDS = new Set<string>(["floor", "gradient", "image"]);
const BACKGROUND_KINDS = new Set<string>(["color", "gradient", "image", "shader", "scene3d"]);

export function readBackdropKind(doc: ThemeDoc): BackdropKind {
  const type = getIn(doc, ["backdrop", "type"]);
  return typeof type === "string" && BACKDROP_KINDS.has(type) ? (type as BackdropKind) : "off";
}

export function readBackgroundKind(doc: ThemeDoc): BackgroundKind {
  const type = getIn(doc, ["background", "type"]);
  return typeof type === "string" && BACKGROUND_KINDS.has(type) ? (type as BackgroundKind) : "off";
}

/** The block as a record, for a form reading its own fields back. */
export function readBlock(doc: ThemeDoc, key: string): ThemeDoc {
  const value = doc[key];
  return isRecord(value) ? value : {};
}

/** The first gradient a backdrop/background can reference by name, or null when the theme has none. */
export function firstGradientName(doc: ThemeDoc): string | null {
  return isRecord(doc.gradients) ? (Object.keys(doc.gradients)[0] ?? null) : null;
}

// ── Lighting ──────────────────────────────────────────────────────────────

/** Where this document keeps its key light. Bundled themes are all v8 (`lighting.key`), which normalises to `sun` in memory but stays `key` on disk, so edits write back to whichever spelling the file already uses instead of churning 34 theme files. */
export function sunPath(doc: ThemeDoc): string[] {
  const lighting = readBlock(doc, "lighting");
  return isRecord(lighting.key) && !isRecord(lighting.sun)
    ? ["lighting", "key"]
    : ["lighting", "sun"];
}

/** Where this document keeps its environment: the v9 `lighting.environment` outranks the v8 top-level `environment` at render, so an edit follows the one that is actually live, and a fresh block lands in the v8 slot the bundled themes use. */
export function environmentPath(doc: ThemeDoc): string[] {
  return isRecord(readBlock(doc, "lighting").environment)
    ? ["lighting", "environment"]
    : ["environment"];
}

export interface EnvironmentDraft {
  source: string;
  intensity: number;
  rotationDeg: number;
}

/** The environment as the form edits it; `source: ""` means the document declares none. */
export function readEnvironment(doc: ThemeDoc): EnvironmentDraft {
  const block = getIn(doc, environmentPath(doc));
  const record = isRecord(block) ? block : {};
  return {
    source: typeof record.source === "string" ? record.source : "",
    intensity: isNum(record.intensity) ? record.intensity : 1,
    rotationDeg: isNum(record.rotationDeg) ? record.rotationDeg : 0,
  };
}

/** Writes the environment whole (the parser needs a string source); a blank source drops the block. */
export function writeEnvironment(doc: ThemeDoc, patch: Partial<EnvironmentDraft>): ThemeDoc {
  const next = { ...readEnvironment(doc), ...patch };
  const path = environmentPath(doc);
  if (next.source.trim() === "") return setIn(doc, path, undefined);
  return setIn(doc, path, {
    ...(isRecord(getIn(doc, path)) ? (getIn(doc, path) as ThemeDoc) : {}),
    source: next.source,
    intensity: next.intensity,
    rotationDeg: next.rotationDeg,
  });
}

export interface SunDraft {
  azimuthDeg: number;
  elevationDeg: number;
  intensity: number;
  color: string;
  angularDeg: number | null;
  castShadow: boolean;
  enabled: boolean;
}

export const DEFAULT_SUN: SunDraft = {
  azimuthDeg: 35,
  elevationDeg: 45,
  intensity: 2,
  color: "#ffffff",
  angularDeg: null,
  castShadow: true,
  enabled: true,
};

export function readSun(doc: ThemeDoc): SunDraft | null {
  const block = getIn(doc, sunPath(doc));
  if (!isRecord(block)) return null;
  return {
    azimuthDeg: isNum(block.azimuthDeg) ? block.azimuthDeg : DEFAULT_SUN.azimuthDeg,
    elevationDeg: isNum(block.elevationDeg) ? block.elevationDeg : DEFAULT_SUN.elevationDeg,
    intensity: isNum(block.intensity) ? block.intensity : DEFAULT_SUN.intensity,
    color: typeof block.color === "string" ? block.color : DEFAULT_SUN.color,
    angularDeg: isNum(block.angularDeg) ? block.angularDeg : null,
    castShadow: block.castShadow !== false,
    enabled: block.enabled !== false,
  };
}

export function setSunEnabled(doc: ThemeDoc, enabled: boolean): ThemeDoc {
  return writeSun(doc, { ...(readSun(doc) ?? DEFAULT_SUN), enabled });
}

export function writeThemeShadow(doc: ThemeDoc, shadow: ThemeShadowSpec): ThemeDoc {
  const parsed = parseThemeDraft(doc, "theme shadow");
  const base = parsed.theme?.lighting ? doc : setSunEnabled(doc, true);
  const previous = getIn(base, ["lighting", "shadow"]);
  return setIn(base, ["lighting", "shadow"], {
    ...(isRecord(previous) ? previous : {}),
    ...shadow,
  });
}

export function writeThemeTextLook(doc: ThemeDoc, spec: TextLookSpec | undefined): ThemeDoc {
  if (!spec) return setIn(doc, ["textLook"], undefined);
  const next = { ...(isRecord(doc.textLook) ? doc.textLook : {}) };
  for (const key of [
    "preset",
    "colorA",
    "colorB",
    "angleDeg",
    "strokeEm",
    "hollow",
    "intensity",
    "offsetEm",
    "curveDeg",
  ] satisfies (keyof TextLookSpec)[])
    delete next[key];
  return setIn(doc, ["textLook"], { ...next, ...spec });
}

/** Rewrites the key light whole, keeping every optional field out of the file unless it differs from the engine default (`angularDeg` absent, shadows on, enabled). `null` removes it. */
export function writeSun(doc: ThemeDoc, sun: SunDraft | null): ThemeDoc {
  const path = sunPath(doc);
  if (!sun)
    return setIn(setIn(doc, ["lighting", "sun"], undefined), ["lighting", "key"], undefined);
  const original = getIn(doc, path);
  const next: ThemeDoc = {
    ...(isRecord(original) ? original : {}),
    azimuthDeg: sun.azimuthDeg,
    elevationDeg: sun.elevationDeg,
    intensity: sun.intensity,
    color: sun.color,
    ...(sun.angularDeg === null ? {} : { angularDeg: sun.angularDeg }),
    ...(sun.castShadow ? {} : { castShadow: false }),
    ...(sun.enabled ? {} : { enabled: false }),
  };
  if (sun.angularDeg === null) delete next.angularDeg;
  if (sun.castShadow) delete next.castShadow;
  if (sun.enabled) delete next.enabled;
  if (sun.color !== readSun(doc)?.color) {
    delete next.kelvin;
    delete next.colorToken;
  }
  const out = setIn(doc, path, next);
  return readAmbient(doc) === null ? setIn(out, ["lighting", "ambient"], 0) : out;
}

export function readAmbient(doc: ThemeDoc): number | null {
  const value = getIn(doc, ["lighting", "ambient"]);
  return isNum(value) ? value : null;
}

export function readAmbientColor(doc: ThemeDoc): string | null {
  const value = getIn(doc, ["lighting", "ambientColor"]);
  return typeof value === "string" ? value : null;
}

/** One v8 fill light: the shape 34 bundled themes still author, and the one the `fills` list edits. */
export interface FillDraft {
  azimuthDeg: number;
  elevationDeg: number;
  intensity: number;
  color: string;
}

export const DEFAULT_FILL: FillDraft = {
  azimuthDeg: -60,
  elevationDeg: 20,
  intensity: 0.6,
  color: "#ffffff",
};

export function readFills(doc: ThemeDoc): FillDraft[] {
  const fills = readBlock(doc, "lighting").fills;
  if (!Array.isArray(fills)) return [];
  return fills.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    return {
      ...record,
      azimuthDeg: isNum(record.azimuthDeg) ? record.azimuthDeg : DEFAULT_FILL.azimuthDeg,
      elevationDeg: isNum(record.elevationDeg) ? record.elevationDeg : DEFAULT_FILL.elevationDeg,
      intensity: isNum(record.intensity) ? record.intensity : DEFAULT_FILL.intensity,
      color: typeof record.color === "string" ? record.color : DEFAULT_FILL.color,
    };
  });
}

export function writeFills(doc: ThemeDoc, fills: readonly FillDraft[]): ThemeDoc {
  return setIn(
    doc,
    ["lighting", "fills"],
    fills.length === 0 ? undefined : fills.map((f) => ({ ...f })),
  );
}

// ── Effects ───────────────────────────────────────────────────────────────

export const EFFECT_KEYS = ["bloom", "vignette", "lut", "grain"] as const;
export type EffectKey = (typeof EFFECT_KEYS)[number];

/** Every field of an effect is required by the parser, so enabling one writes the whole block from these. */
export const EFFECT_DEFAULTS: Record<EffectKey, Record<string, number | string>> = {
  bloom: { intensity: 0.8, luminanceThreshold: 0.6, luminanceSmoothing: 0.2 },
  vignette: { offset: 0.3, darkness: 0.5 },
  lut: { url: "", intensity: 1 },
  grain: { intensity: 0.08 },
};

export function readEffect(doc: ThemeDoc, key: EffectKey): Record<string, number | string> | null {
  const block = getIn(doc, ["effects", key]);
  if (!isRecord(block)) return null;
  const out: Record<string, number | string> = { ...EFFECT_DEFAULTS[key] };
  for (const field of Object.keys(EFFECT_DEFAULTS[key])) {
    const value = block[field];
    if (typeof out[field] === "string" && typeof value === "string") out[field] = value;
    if (typeof out[field] === "number" && isNum(value)) out[field] = value;
  }
  return out;
}

export function writeEffect(
  doc: ThemeDoc,
  key: EffectKey,
  values: Record<string, number | string> | null,
): ThemeDoc {
  const previous = getIn(doc, ["effects", key]);
  return setIn(
    doc,
    ["effects", key],
    values ? { ...(isRecord(previous) ? previous : {}), ...values } : undefined,
  );
}
