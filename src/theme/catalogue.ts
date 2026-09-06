import { parseThemeDoc } from "./schema";
import type { Theme } from "./tokens";

export const THEME_CATEGORIES = [
  { id: "essentials", label: "Essentials" },
  { id: "quiet-technology", label: "Quiet technology" },
  { id: "human-centred-ai", label: "Human-centred AI" },
  { id: "maker-energy", label: "Maker energy" },
  { id: "sensory-and-surreal", label: "Sensory and surreal" },
  { id: "digital-assets", label: "Digital assets" },
  { id: "modern-finance", label: "Modern finance" },
] as const;

export type ThemeCategoryId = (typeof THEME_CATEGORIES)[number]["id"];

export const MY_THEMES_COLLECTION = { id: "my-themes", label: "My themes" } as const;

export type ThemeCatalogueStage = "physical" | "lighting-only" | "none";

export interface ThemeCatalogueMetadata {
  category: ThemeCategoryId;
  useLabel: string;
  tags: readonly string[];
  stage: ThemeCatalogueStage;
  hidden: boolean;
  order: number;
}

export interface ThemeCatalogueEntry {
  id: string;
  filename: string;
  theme: Theme;
  catalogue: ThemeCatalogueMetadata;
  /** The RAW document the glob imported, kept beside the parsed theme so a duplicate can copy the file rather than the resolved `Theme` (which drops `catalogue` and anything a newer build wrote). */
  doc: unknown;
}

export interface ThemeCatalogueFilters {
  category?: ThemeCategoryId;
  query?: string;
  mode?: "light" | "dark";
  stage?: ThemeCatalogueStage;
  includeHidden?: boolean;
}

const CATEGORY_ORDER = new Map(THEME_CATEGORIES.map((category, index) => [category.id, index]));
const CATEGORY_LABELS = new Map(THEME_CATEGORIES.map((category) => [category.id, category.label]));
const CATEGORY_IDS = new Set<string>(THEME_CATEGORIES.map((category) => category.id));
const STAGES = new Set<ThemeCatalogueStage>(["physical", "lighting-only", "none"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function compareText(a: string, b: string): number {
  const left = a.toLocaleLowerCase("en-AU");
  const right = b.toLocaleLowerCase("en-AU");
  return left < right ? -1 : left > right ? 1 : 0;
}

function searchable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-AU");
}

function importedDocument(value: unknown): unknown {
  return isRecord(value) && "default" in value ? value.default : value;
}

function sourceFilename(source: string): string {
  return source.slice(source.lastIndexOf("/") + 1);
}

export function parseThemeCatalogueMetadata(
  raw: unknown,
  source: string,
): ThemeCatalogueMetadata | undefined {
  if (!isRecord(raw)) {
    console.warn(`[theme catalogue] ${source}: missing or invalid "catalogue" block`);
    return undefined;
  }
  if (!isNonEmptyString(raw.category) || !CATEGORY_IDS.has(raw.category)) {
    console.warn(`[theme catalogue] ${source}: invalid category`);
    return undefined;
  }
  if (!isNonEmptyString(raw.useLabel)) {
    console.warn(`[theme catalogue] ${source}: invalid useLabel`);
    return undefined;
  }
  if (!Array.isArray(raw.tags) || !raw.tags.every(isNonEmptyString)) {
    console.warn(`[theme catalogue] ${source}: tags must be non-empty strings`);
    return undefined;
  }
  if (!isNonEmptyString(raw.stage) || !STAGES.has(raw.stage as ThemeCatalogueStage)) {
    console.warn(`[theme catalogue] ${source}: invalid stage`);
    return undefined;
  }
  if (raw.hidden !== undefined && typeof raw.hidden !== "boolean") {
    console.warn(`[theme catalogue] ${source}: hidden must be a boolean`);
    return undefined;
  }
  if (
    raw.order !== undefined &&
    (typeof raw.order !== "number" || !Number.isSafeInteger(raw.order) || raw.order < 0)
  ) {
    console.warn(`[theme catalogue] ${source}: order must be a non-negative integer`);
    return undefined;
  }

  const tags = [...new Map(raw.tags.map((tag) => [searchable(tag), tag.trim()])).values()];
  return {
    category: raw.category as ThemeCategoryId,
    useLabel: raw.useLabel.trim(),
    tags,
    stage: raw.stage as ThemeCatalogueStage,
    hidden: raw.hidden ?? false,
    order: raw.order ?? Number.MAX_SAFE_INTEGER,
  };
}

export function sortThemeCatalogue(entries: readonly ThemeCatalogueEntry[]): ThemeCatalogueEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const category =
        (CATEGORY_ORDER.get(a.entry.catalogue.category) ?? Number.MAX_SAFE_INTEGER) -
        (CATEGORY_ORDER.get(b.entry.catalogue.category) ?? Number.MAX_SAFE_INTEGER);
      if (category !== 0) return category;
      const order = a.entry.catalogue.order - b.entry.catalogue.order;
      if (order !== 0) return order;
      const name = compareText(a.entry.theme.name, b.entry.theme.name);
      if (name !== 0) return name;
      const id = compareText(a.entry.id, b.entry.id);
      return id !== 0 ? id : a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/** `catalogue.order` read on its own, leniently: the reorder commands write that one field into whatever block is there, and a catalogue the full parser rejects (a hand-written theme with no useLabel, say) must still keep the sort key the user just dragged into place. */
export function readCatalogueOrder(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  const order = raw.order;
  return typeof order === "number" && Number.isSafeInteger(order) && order >= 0 ? order : undefined;
}

/** The workspace half of a theme listing sorts on the same key the bundled catalogue does: `catalogue.order` first (lower first, no block last), then name, then id. Workspace themes have no collection to sort within, so this is the whole comparator. */
export function sortWorkspaceThemes<T extends { id: string; name: string; order?: number }>(
  entries: readonly T[],
): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const order =
        (a.entry.order ?? Number.MAX_SAFE_INTEGER) - (b.entry.order ?? Number.MAX_SAFE_INTEGER);
      if (order !== 0) return order;
      const name = compareText(a.entry.name, b.entry.name);
      if (name !== 0) return name;
      const id = compareText(a.entry.id, b.entry.id);
      return id !== 0 ? id : a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export function filterThemeCatalogue(
  entries: readonly ThemeCatalogueEntry[],
  filters: ThemeCatalogueFilters = {},
): ThemeCatalogueEntry[] {
  const terms = searchable(filters.query?.trim() ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return sortThemeCatalogue(
    entries.filter((entry) => {
      if (!filters.includeHidden && entry.catalogue.hidden) return false;
      if (filters.category && entry.catalogue.category !== filters.category) return false;
      if (filters.mode && entry.theme.mode !== filters.mode) return false;
      if (filters.stage && entry.catalogue.stage !== filters.stage) return false;
      if (terms.length === 0) return true;
      const haystack = searchable(
        [
          entry.id,
          entry.theme.name,
          entry.catalogue.useLabel,
          CATEGORY_LABELS.get(entry.catalogue.category) ?? entry.catalogue.category,
          ...entry.catalogue.tags,
        ].join(" "),
      );
      return terms.every((term) => haystack.includes(term));
    }),
  );
}

export function searchThemeCatalogue(
  entries: readonly ThemeCatalogueEntry[],
  query: string,
  filters: Omit<ThemeCatalogueFilters, "query"> = {},
): ThemeCatalogueEntry[] {
  return filterThemeCatalogue(entries, { ...filters, query });
}

export function countThemesByCategory(
  entries: readonly ThemeCatalogueEntry[],
  filters: Omit<ThemeCatalogueFilters, "category"> = {},
): Record<ThemeCategoryId, number> {
  const counts = Object.fromEntries(THEME_CATEGORIES.map(({ id }) => [id, 0])) as Record<
    ThemeCategoryId,
    number
  >;
  for (const entry of filterThemeCatalogue(entries, filters)) counts[entry.catalogue.category] += 1;
  return counts;
}

export function discoverBuiltinThemeCatalogue(
  modules: Record<string, unknown>,
): ThemeCatalogueEntry[] {
  const entries: ThemeCatalogueEntry[] = [];
  const ids = new Set<string>();
  for (const [source, imported] of Object.entries(modules)) {
    const doc = importedDocument(imported);
    const theme = parseThemeDoc(doc, source);
    if (!theme) throw new Error(`Bundled theme ${source} failed to parse`);
    const filename = sourceFilename(source);
    const expectedFilename = `${theme.id}.json`;
    if (filename !== expectedFilename) {
      throw new Error(
        `Bundled theme ${source} has id "${theme.id}", expected ${filename.slice(0, -5)}`,
      );
    }
    if (ids.has(theme.id)) throw new Error(`Duplicate bundled theme id "${theme.id}"`);
    ids.add(theme.id);
    const rawCatalogue = isRecord(doc) ? doc.catalogue : undefined;
    const catalogue = parseThemeCatalogueMetadata(rawCatalogue, source);
    if (!catalogue) throw new Error(`Bundled theme ${source} has invalid catalogue metadata`);
    entries.push({ id: theme.id, filename, theme, catalogue, doc });
  }
  return sortThemeCatalogue(entries);
}

const BUILTIN_THEME_MODULES = import.meta.glob("./builtin/*.json", {
  eager: true,
  import: "default",
});

export const BUILTIN_THEME_CATALOGUE = discoverBuiltinThemeCatalogue(BUILTIN_THEME_MODULES);

export let THEME_LINEUP: readonly string[] = filterThemeCatalogue(BUILTIN_THEME_CATALOGUE).map(
  ({ id }) => id,
);

export function refreshThemeLineup(): void {
  const sorted = sortThemeCatalogue(BUILTIN_THEME_CATALOGUE);
  BUILTIN_THEME_CATALOGUE.splice(0, BUILTIN_THEME_CATALOGUE.length, ...sorted);
  THEME_LINEUP = filterThemeCatalogue(BUILTIN_THEME_CATALOGUE).map(({ id }) => id);
}
