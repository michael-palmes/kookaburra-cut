import { createUserCatalogue, type LibraryItemInfo, listUserPresets } from "./library";
import { watchLibraryDocuments } from "./libraryDocuments";
import { type LibraryPreviewPoint, parseLibraryPreviewPoint } from "./libraryPreviewPoint";
import { fsUrl } from "./media";
import {
  outgoingSceneTransitions,
  type ProjectManifest,
  parseProjectId,
  rememberWorkspaceLibraryPath,
  WORKSPACE_PROJECT_PREFIX,
} from "./project";
import { buildSceneTimeline, timelineTotalMs } from "./sceneTimeline";

/** The scene-preset registry, the templates registry one scene down: a preset is a single-scene project folder (`presets/<slug>/`, or `~/Kookaburra Cut/presets/<slug>/` for the user's own) and `preset.json` is the only thing that marks it one. The manifest carries only what cannot be derived: scene count, length, aspects and the theme come from the sibling `project.json`, the drift class this design exists to kill. Bundled entries are eager globs, so the gallery has no loading state; user entries hydrate in behind them (`refreshUserPresets`). */

/** Newest manifest schema this build understands (newer files are ignored with a warning). */
export const PRESET_MANIFEST_VERSION = 1;

/** Capture width of the committed card still (16:9, so 640x360; the template-preview size). */
export const PRESET_PREVIEW_WIDTH = 640;

/** The shipped categories, in rail order. */
export const PRESET_CATEGORIES = [
  { id: "starters", label: "Scene starters" },
  { id: "openers", label: "Openers" },
  { id: "features", label: "Features" },
  { id: "stats-charts", label: "Stats & charts" },
  { id: "devices", label: "Devices" },
  { id: "closers", label: "Closers" },
] as const;

export type PresetCategoryId = (typeof PRESET_CATEGORIES)[number]["id"];

export const PRESET_STATUSES = ["stable", "beta"] as const;
export type PresetStatus = (typeof PRESET_STATUSES)[number];

/** Where the folder lives: the bundled tree, an imported pack, or the user's workspace. */
export const PRESET_SOURCES = ["bundled", "pack", "user"] as const;
export type PresetSource = (typeof PRESET_SOURCES)[number];

/** The card still's capture point: a scene index (that scene's middle) or an explicit scene-local time. A one-scene project makes `scene` 0 in practice, but the shape matches templates so both catalogues capture through one code path. */
export type PresetPreviewFrame = LibraryPreviewPoint;

/** `presets/<slug>/preset.json`. The folder name is the id, never restated here, and the file is never copied into a project (inserting a preset copies the scene and its assets only). */
export interface PresetManifest {
  version: number;
  name: string;
  /** May be empty: a freshly saved preset gets its tagline in the details modal. */
  tagline: string;
  /** Absent renders under Uncategorised rather than dropping out of the gallery. */
  category?: PresetCategoryId;
  tags: string[];
  preview: PresetPreviewFrame;
  /** Within-category sort; ties break on name. */
  order: number;
  status: PresetStatus;
  source?: PresetSource;
}

export interface PresetManifestIssue {
  /** Dotted field path, empty for the document itself. */
  path: string;
  message: string;
}

export type PresetManifestResult =
  | { success: true; data: PresetManifest }
  | { success: false; error: { message: string; issues: PresetManifestIssue[] } };

const KNOWN_FIELDS = new Set([
  "version",
  "name",
  "tagline",
  "category",
  "tags",
  "preview",
  "order",
  "status",
  "source",
]);

const CATEGORY_IDS: readonly string[] = PRESET_CATEGORIES.map((c) => c.id);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(
  value: unknown,
  path: string,
  issues: PresetManifestIssue[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array of strings" });
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item === "string" && item.trim().length > 0) out.push(item);
    else issues.push({ path: `${path}[${i}]`, message: "must be a non-empty string" });
  });
  return out;
}

function previewFrame(value: unknown, issues: PresetManifestIssue[]): PresetPreviewFrame {
  const parsed = parseLibraryPreviewPoint(value);
  if (parsed !== null) return parsed;
  issues.push({ path: "preview", message: "must be a scene index or { scene, atMs? }" });
  return 0;
}

function validateManifest(raw: unknown): PresetManifestResult {
  const issues: PresetManifestIssue[] = [];
  if (!isRecord(raw)) {
    return {
      success: false,
      error: { message: "not an object", issues: [{ path: "", message: "not an object" }] },
    };
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) issues.push({ path: key, message: "unknown field" });
  }

  if (typeof raw.version !== "number" || raw.version < 1) {
    issues.push({ path: "version", message: "must be a number >= 1" });
  } else if (raw.version > PRESET_MANIFEST_VERSION) {
    issues.push({
      path: "version",
      message: `version ${raw.version} is newer than this Kookaburra Cut understands`,
    });
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    issues.push({ path: "name", message: "must be a non-empty string" });
  }
  if (typeof raw.tagline !== "string") {
    issues.push({ path: "tagline", message: "must be a string" });
  }
  if (raw.category !== undefined && !CATEGORY_IDS.includes(raw.category as string)) {
    issues.push({ path: "category", message: `must be one of ${CATEGORY_IDS.join(", ")}` });
  }
  const tags = stringArray(raw.tags, "tags", issues) ?? [];
  const preview = previewFrame(raw.preview, issues);
  if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) {
    issues.push({ path: "order", message: "must be a finite number" });
  }
  if (!PRESET_STATUSES.includes(raw.status as PresetStatus)) {
    issues.push({ path: "status", message: `must be one of ${PRESET_STATUSES.join(", ")}` });
  }
  if (raw.source !== undefined && !PRESET_SOURCES.includes(raw.source as PresetSource)) {
    issues.push({ path: "source", message: `must be one of ${PRESET_SOURCES.join(", ")}` });
  }

  if (issues.length > 0) {
    const message = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
    return { success: false, error: { message, issues } };
  }
  const manifest: PresetManifest = {
    version: raw.version as number,
    name: raw.name as string,
    tagline: raw.tagline as string,
    tags,
    preview,
    order: raw.order as number,
    status: raw.status as PresetStatus,
  };
  if (raw.category !== undefined) manifest.category = raw.category as PresetCategoryId;
  if (raw.source !== undefined) manifest.source = raw.source as PresetSource;
  return { success: true, data: manifest };
}

/** The manifest validator, shaped like a schema object so call sites read the same either way: `parse` throws with every issue named, `safeParse` returns them. Unknown fields are an issue, not stripped, the templates rule: a silently-dropped `catagory` is exactly what this exists to catch. */
export const presetManifestSchema = {
  parse(raw: unknown, source = "preset.json"): PresetManifest {
    const result = validateManifest(raw);
    if (!result.success) throw new Error(`${source}: ${result.error.message}`);
    return result.data;
  },
  safeParse(raw: unknown, _source = "preset.json"): PresetManifestResult {
    return validateManifest(raw);
  },
};

/** The capture point as one shape, the bare-index form expanded (its scene's middle is resolved by the capture path, which knows the scene's length). */
export function presetPreviewFrame(manifest: PresetManifest): Exclude<LibraryPreviewPoint, number> {
  return typeof manifest.preview === "number" ? { scene: manifest.preview } : manifest.preview;
}

// Vite resolves project globs from the repo root. Manifests are a few hundred bytes each, so eager costs nothing and buys a synchronous registry.
const presetGlob = import.meta.glob<unknown>("/presets/*/preset.json", {
  eager: true,
  import: "default",
});
const projectGlob = import.meta.glob<ProjectManifest>("/presets/*/project.json", {
  eager: true,
  import: "default",
});
// Committed card art as fingerprinted URLs; a glob (not explicit imports) so a preset shipped before its still degrades to the swatch placeholder instead of failing the build.
const previewGlob = import.meta.glob<string>("../assets/preset-previews/*.jpg", {
  query: "?url",
  import: "default",
  eager: true,
});
const posterGlob = import.meta.glob<string>("/presets/*/poster.png", {
  query: "?url",
  import: "default",
  eager: true,
});
const changedSincePoster = new Set<string>();

/** The committed card still for a bundled preset, or null while the art doesn't exist yet. */
export function bundledPresetPreview(slug: string): string | null {
  return (
    posterGlob[`/presets/${slug}/poster.png`] ??
    previewGlob[`../assets/preset-previews/${slug}.jpg`] ??
    null
  );
}

// ── Preview staleness (dev only) ──────────────────────────────────────────

/** The card-art ledger both bundled catalogues share: one content hash per slug, written by the preview autoruns through `scripts/preset-preview-stale.mjs`. Comparing it against the tree in a dev checkout is what badges a card whose art is older than the item; release ships no ledger read at all, since `import.meta.env.DEV` folds these globs away. */
export interface PreviewLedger {
  version: number;
  items: Record<string, string>;
}

/** Object keys sorted, no whitespace: the same document has to hash the same here and in `scripts/preset-preview-stale.mjs`, which sees raw files rather than Vite-parsed modules. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** FNV-1a over two independent lanes, concatenated as 16 hex chars. Mirrored exactly in `scripts/preset-preview-stale.mjs`; staleness is a hint, so a cheap non-cryptographic digest is the right trade. */
export function contentDigest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + i), 0x85ebca6b);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

/** The ledger hash for one bundled item: its manifest, its `project.json` and every scene sidecar, keyed by folder-relative path and sorted. TSX is deliberately outside the hash, so a code-only scene edit goes unbadged and still needs a manual re-render. */
export function previewContentHash(docs: readonly (readonly [string, unknown])[]): string {
  return contentDigest(
    [...docs]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([path, doc]) => `${path}\n${canonicalJson(doc)}\n`)
      .join(""),
  );
}

// Dev-only: the sidecars and the ledger are read solely to badge stale cards, so a release build folds both globs (and everything they would pull into the bundle) away.
const sidecarGlob: Record<string, unknown> = import.meta.env.DEV
  ? import.meta.glob<unknown>("/presets/*/scenes/*.json", { eager: true, import: "default" })
  : {};
const ledgerGlob: Record<string, PreviewLedger> = import.meta.env.DEV
  ? import.meta.glob<PreviewLedger>("../assets/preset-previews/*.json", {
      eager: true,
      import: "default",
    })
  : {};

/** Ledger entries for one catalogue, keyed by slug; empty until the promotion step has written one. */
export function ledgerItems(ledger: PreviewLedger | undefined): Record<string, string> {
  return ledger?.items ?? {};
}

const staleCache = new Map<string, boolean>();

/** Dev only: this bundled preset's committed still is older than its authored JSON. False in release, for a preset with no art yet (the swatch already says so) and for the user's own presets. */
export function isPresetPreviewStale(slug: string): boolean {
  if (!import.meta.env.DEV) return false;
  if (posterGlob[`/presets/${slug}/poster.png`]) return changedSincePoster.has(slug);
  const cached = staleCache.get(slug);
  if (cached !== undefined) return cached;
  const manifest = presetGlob[`/presets/${slug}/preset.json`];
  const project = projectGlob[`/presets/${slug}/project.json`];
  if (!manifest || !project || !bundledPresetPreview(slug)) return false;
  const prefix = `/presets/${slug}/`;
  const docs: [string, unknown][] = [
    ["preset.json", manifest],
    ["project.json", project],
  ];
  for (const [path, doc] of Object.entries(sidecarGlob)) {
    if (path.startsWith(`${prefix}scenes/`)) docs.push([path.slice(prefix.length), doc]);
  }
  const ledger = ledgerItems(ledgerGlob["../assets/preset-previews/ledger.json"]);
  const stale = ledger[slug] !== previewContentHash(docs);
  staleCache.set(slug, stale);
  return stale;
}

/** One catalogue row: the authored manifest, flattened, plus everything derived from `project.json`. */
export interface PresetEntry {
  /** Catalogue id: the folder slug for bundled presets, `ws:<slug>` for the user's own. */
  id: string;
  /** The folder name, whichever tree it lives in. */
  slug: string;
  /** The project id that opens this preset in the editor (`preset:` / `ws-preset:`). */
  projectId: string;
  manifest: PresetManifest;
  name: string;
  tagline: string;
  category: PresetCategoryId | null;
  categoryLabel: string | null;
  tags: readonly string[];
  order: number;
  status: PresetStatus;
  source: PresetSource;
  sceneCount: number;
  /** Timeline total, transition overlaps subtracted (what the scene actually runs for). */
  durationMs: number;
  aspects: readonly string[];
  primaryAspect: string;
  themeId: string;
  /** The committed (or captured) card still, or null while there isn't one. */
  previewUrl: string | null;
  /** Lowercased search index: name, tagline, tags, category label. */
  haystack: string;
}

export function presetCategoryLabel(id: PresetCategoryId): string {
  return PRESET_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/** Card meta: seconds under a minute, `m:ss` above it. */
export function formatPresetDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The editor project id for a catalogue id: `hero` → `preset:hero`, `ws:hero` → `ws-preset:hero`. */
export function presetProjectId(id: string): string {
  return id.startsWith(WORKSPACE_PROJECT_PREFIX)
    ? `ws-preset:${id.slice(WORKSPACE_PROJECT_PREFIX.length)}`
    : `preset:${id}`;
}

function projectDurationMs(project: ProjectManifest): number {
  const transitions = outgoingSceneTransitions(project);
  const slots = buildSceneTimeline(
    project.scenes.map((scene, i) => ({
      id: scene.file,
      durationMs: scene.durationMs,
      transition: transitions[i],
    })),
  );
  return timelineTotalMs(slots);
}

/** Everything the native listing already knows, so a user preset doesn't re-derive it from a manifest the frontend never parsed as a project. */
export interface PresetEntryOverrides {
  sceneCount?: number;
  durationMs?: number;
  previewUrl?: string | null;
}

/** Pair a manifest with its sibling project into a catalogue row; the one seam both the bundled glob and the user listing build entries through. */
export function buildPresetEntry(
  id: string,
  manifest: PresetManifest,
  project: ProjectManifest,
  overrides: PresetEntryOverrides = {},
): PresetEntry {
  const isUser = id.startsWith(WORKSPACE_PROJECT_PREFIX);
  const slug = isUser ? id.slice(WORKSPACE_PROJECT_PREFIX.length) : id;
  const category = manifest.category ?? null;
  const categoryLabel = category ? presetCategoryLabel(category) : null;
  const aspects = project.formats ?? [];
  const scenes = project.scenes ?? [];
  return {
    id,
    slug,
    projectId: presetProjectId(id),
    manifest,
    name: manifest.name,
    tagline: manifest.tagline,
    category,
    categoryLabel,
    tags: manifest.tags,
    order: manifest.order,
    status: manifest.status,
    source: isUser ? "user" : (manifest.source ?? "bundled"),
    sceneCount: overrides.sceneCount ?? scenes.length,
    durationMs: overrides.durationMs ?? projectDurationMs(project),
    aspects,
    primaryAspect: aspects[0] ?? "16:9",
    themeId: project.themeId,
    previewUrl:
      overrides.previewUrl !== undefined ? overrides.previewUrl : bundledPresetPreview(slug),
    haystack: [manifest.name, manifest.tagline, ...manifest.tags, categoryLabel ?? ""]
      .join(" ")
      .toLowerCase(),
  };
}

function categoryRank(category: PresetCategoryId | null): number {
  if (!category) return PRESET_CATEGORIES.length;
  const i = CATEGORY_IDS.indexOf(category);
  return i < 0 ? PRESET_CATEGORIES.length : i;
}

/** Gallery order: category order (uncategorised last), stable before beta, then `order`, then name. */
export function comparePresetEntries(a: PresetEntry, b: PresetEntry): number {
  const rank = categoryRank(a.category) - categoryRank(b.category);
  if (rank !== 0) return rank;
  const aBeta = a.status === "beta";
  const bBeta = b.status === "beta";
  if (aBeta !== bBeta) return aBeta ? 1 : -1;
  if (a.order !== b.order) return a.order - b.order;
  return a.name.localeCompare(b.name);
}

export function sortPresetEntries(entries: readonly PresetEntry[]): PresetEntry[] {
  return [...entries].sort(comparePresetEntries);
}

let catalogue: PresetEntry[] | null = null;

function buildCatalogue(): PresetEntry[] {
  const entries: PresetEntry[] = [];
  for (const [path, raw] of Object.entries(presetGlob)) {
    const slug = path.split("/")[2];
    const parsed = presetManifestSchema.safeParse(raw, `${slug}/preset.json`);
    if (!parsed.success) {
      console.warn(`[presets] ${slug}/preset.json ignored: ${parsed.error.message}`);
      continue;
    }
    const project = projectGlob[`/presets/${slug}/project.json`];
    if (!project) {
      console.warn(`[presets] ${slug} has a preset.json but no project.json, ignored`);
      continue;
    }
    entries.push(buildPresetEntry(slug, parsed.data, project));
  }
  return sortPresetEntries(entries);
}

/** The bundled catalogue in gallery order, refreshed by content updates during development. */
export function listPresets(): PresetEntry[] {
  catalogue ??= buildCatalogue();
  return catalogue;
}

// ── The user's own presets ────────────────────────────────────────────────

function toUserEntry(info: LibraryItemInfo): PresetEntry | null {
  const id = `${WORKSPACE_PROJECT_PREFIX}${info.slug}`;
  let manifest: PresetManifest;
  let project: ProjectManifest;
  try {
    const parsed = presetManifestSchema.safeParse(
      JSON.parse(info.manifestJson),
      `${info.slug}/preset.json`,
    );
    if (!parsed.success) {
      console.warn(`[presets] ${info.slug}/preset.json ignored: ${parsed.error.message}`);
      return null;
    }
    manifest = { ...parsed.data, source: "user" };
    project = JSON.parse(info.projectJson) as ProjectManifest;
  } catch (e) {
    console.warn(`[presets] ${info.slug} ignored:`, e);
    return null;
  }
  // Cache the folder so the asset resolvers can route `ws-preset:<slug>` synchronously.
  rememberWorkspaceLibraryPath(`ws-preset:${info.slug}`, info.path);
  return buildPresetEntry(id, manifest, project, {
    sceneCount: info.sceneCount,
    durationMs: info.durationMs,
    previewUrl: info.posterPath
      ? `${fsUrl(info.posterPath)}?v=${info.posterModifiedAt ?? 0}`
      : null,
  });
}

const userPresets = createUserCatalogue(listUserPresets, toUserEntry, "presets");

/** The user's presets as the last refresh saw them; empty until `refreshUserPresets` has run. */
export function listUserPresetEntries(): PresetEntry[] {
  return userPresets.entries();
}

/** Re-read `~/Kookaburra Cut/presets/` and notify subscribers; call after any save, edit or delete. */
export function refreshUserPresets(): Promise<PresetEntry[]> {
  return userPresets.refresh();
}

/** Subscribe to workspace refreshes and bundled document updates. */
export function subscribePresets(listener: () => void): () => void {
  bundledListeners.add(listener);
  const unsubscribe = userPresets.subscribe(listener);
  return () => {
    bundledListeners.delete(listener);
    unsubscribe();
  };
}

let merged: { version: number; entries: PresetEntry[] } | null = null;
const bundledListeners = new Set<() => void>();
const editListeners = new Set<(projectId: string) => void>();

export function subscribePresetEdits(listener: (projectId: string) => void): () => void {
  editListeners.add(listener);
  return () => {
    editListeners.delete(listener);
  };
}

function notifyBundledPresetChange() {
  catalogue = null;
  merged = null;
  staleCache.clear();
  for (const listener of bundledListeners) listener();
}

export function updateBundledPresetManifest(projectId: string, manifest: unknown): void {
  const { scope, slug } = parseProjectId(projectId);
  if (scope !== "preset" || !presetManifestSchema.safeParse(manifest).success) return;
  presetGlob[`/presets/${slug}/preset.json`] = manifest;
  notifyBundledPresetChange();
}

export function updateBundledPresetPoster(
  projectId: string,
  mtimeMs: number | null,
  nativePath?: string,
): void {
  const { scope, slug } = parseProjectId(projectId);
  if (!import.meta.env.DEV || scope !== "preset") return;
  const path = `/presets/${slug}/poster.png`;
  posterGlob[path] = `${nativePath ? fsUrl(nativePath) : path}?v=${mtimeMs ?? Date.now()}`;
  changedSincePoster.delete(slug);
  notifyBundledPresetChange();
}

watchLibraryDocuments(
  import.meta.hot,
  "presets",
  {
    "preset.json": presetGlob,
    "project.json": projectGlob,
    "poster.png": posterGlob,
    scenes: sidecarGlob,
    assets: {},
  },
  (path) => {
    const slug = path.split("/")[2];
    if (path.endsWith("/poster.png")) changedSincePoster.delete(slug);
    else {
      changedSincePoster.add(slug);
      for (const listener of editListeners) listener(`preset:${slug}`);
    }
    notifyBundledPresetChange();
  },
);

/** Bundled and user presets in one gallery order. Synchronous by design: the bundled half is there on the first frame, the user half appears when its listing lands. The result is memoised per refresh, so it is safe as a `useSyncExternalStore` snapshot. */
export function listAllPresets(): PresetEntry[] {
  const version = userPresets.version();
  if (!merged || merged.version !== version) {
    merged = { version, entries: sortPresetEntries([...listPresets(), ...userPresets.entries()]) };
  }
  return merged.entries;
}

export function findPreset(id: string): PresetEntry | undefined {
  return listAllPresets().find((entry) => entry.id === id);
}

// ── Filtering ─────────────────────────────────────────────────────────────

export interface PresetFilter {
  /** Free text over the haystack; whitespace-separated terms all have to match. */
  query?: string;
  /** null/absent is the All row. */
  category?: PresetCategoryId | null;
  /** null/absent is every source (the gallery's App presets / My presets split). */
  source?: PresetSource | null;
}

/** The gallery's filter, pure so it is testable without rendering. */
export function searchPresets(
  entries: readonly PresetEntry[],
  filter: PresetFilter = {},
): PresetEntry[] {
  const terms = (filter.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (filter.source && entry.source !== filter.source) return false;
    if (filter.category && entry.category !== filter.category) return false;
    return terms.every((term) => entry.haystack.includes(term));
  });
}

export interface PresetCounts {
  all: number;
  byCategory: Record<PresetCategoryId, number>;
  /** Presets filing under no category, which the gallery shows in an Uncategorised row. */
  uncategorised: number;
}

/** Rail counts, live against the current search and facets. */
export function presetCategoryCounts(
  entries: readonly PresetEntry[],
  filter: Omit<PresetFilter, "category"> = {},
): PresetCounts {
  const byCategory = Object.fromEntries(PRESET_CATEGORIES.map((c) => [c.id, 0])) as Record<
    PresetCategoryId,
    number
  >;
  const matched = searchPresets(entries, { ...filter, category: null });
  let uncategorised = 0;
  for (const entry of matched) {
    if (entry.category) byCategory[entry.category] += 1;
    else uncategorised += 1;
  }
  return { all: matched.length, byCategory, uncategorised };
}
