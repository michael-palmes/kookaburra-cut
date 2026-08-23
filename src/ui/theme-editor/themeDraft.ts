import { THEME_CATEGORIES, type ThemeCategoryId } from "../../theme/catalogue";
import { WORKSPACE_THEME_PREFIX } from "../../theme/registry";
import { parseThemeDoc } from "../../theme/schema";
import type { Theme } from "../../theme/tokens";

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
  out = setIn(out, ["catalogue", "order"], next.order ?? undefined);
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
  if (entries.length === 0) return setIn(doc, ["gradients"], undefined);
  const block: Record<string, unknown> = {};
  for (const entry of entries) {
    block[entry.name] = {
      type: entry.type,
      angleDeg: entry.angleDeg,
      stops: entry.stops.map(([colour, position]) => [colour, position]),
      ...(entry.space ? { space: entry.space } : {}),
    };
  }
  return setIn(doc, ["gradients"], block);
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
