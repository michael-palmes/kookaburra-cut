import { outgoingSceneTransitions, type ProjectManifest } from "./project";
import { buildSceneTimeline, timelineTotalMs } from "./sceneTimeline";

/** The template registry. A bundled project is a template iff it ships `projects/<slug>/template.json`, so spikes and preview labs self-exclude with no hand-maintained allowlist. The manifest carries only what cannot be derived: duration, scene count, aspects and the default theme come from the sibling `project.json`, which is the drift class this design exists to kill. Card art is globbed (not imported) so a template shipped before its previews degrades to a swatch instead of failing the build, the theme-preview precedent. Everything here is synchronous, so the picker has no metadata loading state. */

/** Newest manifest schema this build understands (newer files are ignored with a warning). */
export const TEMPLATE_MANIFEST_VERSION = 1;

/** Committed stills per template, in hover order. */
export const TEMPLATE_PREVIEW_COUNT = 4;

/** Pinned first in every view, outside the category rail, and the picker's default selection. */
export const BLANK_TEMPLATE_ID = "blank";

/** The six shipped categories, in rail order. Explainers fold into `app-updates` for v1. */
export const TEMPLATE_CATEGORIES = [
  { id: "app-updates", label: "App updates" },
  { id: "product-launch", label: "Product launch" },
  { id: "marketing-social", label: "Marketing & social" },
  { id: "presentations", label: "Presentations" },
  { id: "finance-crypto", label: "Finance & crypto" },
  { id: "ai-developer", label: "AI & developer" },
] as const;

export type TemplateCategoryId = (typeof TEMPLATE_CATEGORIES)[number]["id"];

export const TEMPLATE_PERSONAS = ["marketer", "co-founder", "pm", "developer", "finance"] as const;
export type TemplatePersona = (typeof TEMPLATE_PERSONAS)[number];

/** Editing effort: `showcase` means impressive, but you will be editing camera keys. */
export const TEMPLATE_LEVELS = ["starter", "standard", "showcase"] as const;
export type TemplateLevel = (typeof TEMPLATE_LEVELS)[number];

/** Motion tier: restrained versus outside the box, and the one facet chip in v1. */
export const TEMPLATE_TIERS = ["safe", "bold"] as const;
export type TemplateTier = (typeof TEMPLATE_TIERS)[number];

export const TEMPLATE_STATUSES = ["stable", "beta"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** Capability chips, verified against the sidecars by the validation suite so they cannot drift. */
export const TEMPLATE_USES = [
  "device",
  "chart",
  "overlay",
  "camera-rig",
  "layered-screenshot",
  "video-window",
  "compare",
  "objects",
  "text-motion",
  "background",
  "audio",
  "multi-device",
] as const;
export type TemplateUse = (typeof TEMPLATE_USES)[number];

/** Chip copy for the card's `uses` row. */
export const TEMPLATE_USE_LABELS: Record<TemplateUse, string> = {
  device: "Device",
  chart: "Chart",
  overlay: "Overlay",
  "camera-rig": "Camera rig",
  "layered-screenshot": "Layered screenshot",
  "video-window": "Video window",
  compare: "Compare",
  objects: "3D objects",
  "text-motion": "Text motion",
  background: "Background",
  audio: "Soundtrack",
  "multi-device": "Multi-device",
};

/** A capture point: a scene index (that scene's middle) or an explicit scene-local time. */
export type TemplatePreviewFrame = number | { scene: number; atMs: number };

/** `projects/<slug>/template.json`. The folder name is the id, never restated here, and the file is never copied into a created project (`create_project` copies `scenes/` and `assets/` only). */
export interface TemplateManifest {
  version: number;
  name: string;
  tagline: string;
  /** Absent only for `blank`, which pins above the rail instead of living in a category. */
  category?: TemplateCategoryId;
  tags: string[];
  personas: TemplatePersona[];
  level: TemplateLevel;
  tier: TemplateTier;
  storeLegal?: boolean;
  uses: TemplateUse[];
  /** Up to 3, shown on the selected card only. */
  highlights?: string[];
  preview: { poster: number; frames: TemplatePreviewFrame[] };
  /** Within-category sort; ties break on name. */
  order: number;
  status: TemplateStatus;
  /** Reserved: only meaningful once packs carry templates. */
  minAppVersion?: string;
  /** Reserved for the pack tier, always absent in v1. */
  source?: "bundled" | "pack";
}

/** 03's name for the same shape. */
export type TemplateDoc = TemplateManifest;

export interface TemplateManifestIssue {
  /** Dotted field path, empty for the document itself. */
  path: string;
  message: string;
}

export type TemplateManifestResult =
  | { success: true; data: TemplateManifest }
  | { success: false; error: { message: string; issues: TemplateManifestIssue[] } };

const KNOWN_FIELDS = new Set([
  "version",
  "name",
  "tagline",
  "category",
  "tags",
  "personas",
  "level",
  "tier",
  "storeLegal",
  "uses",
  "highlights",
  "preview",
  "order",
  "status",
  "minAppVersion",
  "source",
]);

const CATEGORY_IDS: readonly string[] = TEMPLATE_CATEGORIES.map((c) => c.id);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function stringArray(
  value: unknown,
  path: string,
  issues: TemplateManifestIssue[],
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

function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: TemplateManifestIssue[],
): T[] | undefined {
  const raw = stringArray(value, path, issues);
  if (raw === undefined) return undefined;
  const out: T[] = [];
  raw.forEach((item, i) => {
    if ((allowed as readonly string[]).includes(item)) out.push(item as T);
    else issues.push({ path: `${path}[${i}]`, message: `must be one of ${allowed.join(", ")}` });
  });
  return out;
}

function previewFrames(value: unknown, issues: TemplateManifestIssue[]): TemplatePreviewFrame[] {
  if (!Array.isArray(value)) {
    issues.push({ path: "preview.frames", message: "must be an array" });
    return [];
  }
  if (value.length !== TEMPLATE_PREVIEW_COUNT) {
    issues.push({
      path: "preview.frames",
      message: `must hold exactly ${TEMPLATE_PREVIEW_COUNT} capture points`,
    });
  }
  const out: TemplatePreviewFrame[] = [];
  value.forEach((item, i) => {
    if (isIndex(item)) {
      out.push(item);
      return;
    }
    if (isRecord(item) && isIndex(item.scene) && typeof item.atMs === "number" && item.atMs >= 0) {
      out.push({ scene: item.scene, atMs: item.atMs });
      return;
    }
    issues.push({
      path: `preview.frames[${i}]`,
      message: "must be a scene index or { scene, atMs }",
    });
  });
  return out;
}

function validateManifest(raw: unknown): TemplateManifestResult {
  const issues: TemplateManifestIssue[] = [];
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
  } else if (raw.version > TEMPLATE_MANIFEST_VERSION) {
    issues.push({
      path: "version",
      message: `version ${raw.version} is newer than this Kookaburra Cut understands`,
    });
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    issues.push({ path: "name", message: "must be a non-empty string" });
  }
  if (typeof raw.tagline !== "string" || raw.tagline.trim().length === 0) {
    issues.push({ path: "tagline", message: "must be a non-empty string" });
  }
  if (raw.category !== undefined && !CATEGORY_IDS.includes(raw.category as string)) {
    issues.push({ path: "category", message: `must be one of ${CATEGORY_IDS.join(", ")}` });
  }
  const tags = stringArray(raw.tags, "tags", issues) ?? [];
  const personas = enumArray(raw.personas, TEMPLATE_PERSONAS, "personas", issues) ?? [];
  if (!TEMPLATE_LEVELS.includes(raw.level as TemplateLevel)) {
    issues.push({ path: "level", message: `must be one of ${TEMPLATE_LEVELS.join(", ")}` });
  }
  if (!TEMPLATE_TIERS.includes(raw.tier as TemplateTier)) {
    issues.push({ path: "tier", message: `must be one of ${TEMPLATE_TIERS.join(", ")}` });
  }
  if (raw.storeLegal !== undefined && typeof raw.storeLegal !== "boolean") {
    issues.push({ path: "storeLegal", message: "must be a boolean" });
  }
  const uses = enumArray(raw.uses, TEMPLATE_USES, "uses", issues) ?? [];
  const highlights = stringArray(raw.highlights, "highlights", issues);
  if (highlights && highlights.length > 3) {
    issues.push({ path: "highlights", message: "holds at most 3 entries" });
  }
  let preview: TemplateManifest["preview"] = { poster: 0, frames: [] };
  if (!isRecord(raw.preview)) {
    issues.push({ path: "preview", message: "must be an object" });
  } else {
    if (!isIndex(raw.preview.poster)) {
      issues.push({ path: "preview.poster", message: "must be a scene index" });
    }
    preview = {
      poster: isIndex(raw.preview.poster) ? raw.preview.poster : 0,
      frames: previewFrames(raw.preview.frames, issues),
    };
  }
  if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) {
    issues.push({ path: "order", message: "must be a finite number" });
  }
  if (!TEMPLATE_STATUSES.includes(raw.status as TemplateStatus)) {
    issues.push({ path: "status", message: `must be one of ${TEMPLATE_STATUSES.join(", ")}` });
  }
  if (raw.minAppVersion !== undefined && typeof raw.minAppVersion !== "string") {
    issues.push({ path: "minAppVersion", message: "must be a string" });
  }
  if (raw.source !== undefined && raw.source !== "bundled" && raw.source !== "pack") {
    issues.push({ path: "source", message: "must be bundled or pack" });
  }

  if (issues.length > 0) {
    const message = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
    return { success: false, error: { message, issues } };
  }
  const manifest: TemplateManifest = {
    version: raw.version as number,
    name: raw.name as string,
    tagline: raw.tagline as string,
    tags,
    personas,
    level: raw.level as TemplateLevel,
    tier: raw.tier as TemplateTier,
    uses,
    preview,
    order: raw.order as number,
    status: raw.status as TemplateStatus,
  };
  if (raw.category !== undefined) manifest.category = raw.category as TemplateCategoryId;
  if (raw.storeLegal !== undefined) manifest.storeLegal = raw.storeLegal as boolean;
  if (highlights) manifest.highlights = highlights;
  if (raw.minAppVersion !== undefined) manifest.minAppVersion = raw.minAppVersion as string;
  if (raw.source !== undefined) manifest.source = raw.source as "bundled" | "pack";
  return { success: true, data: manifest };
}

/** The manifest validator, shaped like a schema object so call sites read the same either way: `parse` throws with every issue named, `safeParse` returns them. Unknown fields are an issue, not stripped: hand-authoring 30-plus manifests makes a typo the main failure mode, and a silently-dropped `catagory` is exactly what the validation suite exists to catch. */
export const templateManifestSchema = {
  parse(raw: unknown, source = "template.json"): TemplateManifest {
    const result = validateManifest(raw);
    if (!result.success) throw new Error(`${source}: ${result.error.message}`);
    return result.data;
  },
  safeParse(raw: unknown, _source = "template.json"): TemplateManifestResult {
    return validateManifest(raw);
  },
};

// Vite resolves project globs from the repo root. Manifests are a few hundred bytes each, so eager costs nothing and buys a synchronous registry.
const templateGlob = import.meta.glob<unknown>("/projects/*/template.json", {
  eager: true,
  import: "default",
});
const projectGlob = import.meta.glob<ProjectManifest>("/projects/*/project.json", {
  eager: true,
  import: "default",
});
// Committed card art as fingerprinted URLs; a glob (not explicit imports) so a template shipped before its previews degrades to the swatch placeholder instead of failing the build.
const previewGlob = import.meta.glob<string>("../assets/template-previews/*.jpg", {
  query: "?url",
  import: "default",
  eager: true,
});

/** The committed preview URLs for a template, all 4 in hover order, or null. */
export function bundledTemplatePreviews(templateId: string): string[] | null {
  const urls: string[] = [];
  for (let i = 1; i <= TEMPLATE_PREVIEW_COUNT; i++) {
    const url = previewGlob[`../assets/template-previews/${templateId}-${i}.jpg`];
    if (!url) return null;
    urls.push(url);
  }
  return urls;
}

/** One catalogue row: the authored manifest, flattened, plus everything derived from `project.json`. */
export interface TemplateEntry {
  id: string;
  manifest: TemplateManifest;
  name: string;
  tagline: string;
  category: TemplateCategoryId | null;
  categoryLabel: string | null;
  tags: readonly string[];
  personas: readonly TemplatePersona[];
  level: TemplateLevel;
  tier: TemplateTier;
  storeLegal: boolean;
  uses: readonly TemplateUse[];
  highlights: readonly string[];
  order: number;
  status: TemplateStatus;
  sceneCount: number;
  /** Timeline total, transition overlaps subtracted (the length the project actually exports). */
  durationMs: number;
  aspects: readonly string[];
  primaryAspect: string;
  themeId: string;
  /** The 4 committed stills in hover order, or null while the art doesn't exist yet. */
  previews: string[] | null;
  /** Lowercased search index: name, tagline, tags, personas, category label, uses. */
  haystack: string;
}

export function templateCategoryLabel(id: TemplateCategoryId): string {
  return TEMPLATE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/** Card meta: seconds under a minute, `m:ss` above it. */
export function formatTemplateDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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

function toEntry(id: string, manifest: TemplateManifest, project: ProjectManifest): TemplateEntry {
  const category = manifest.category ?? null;
  const categoryLabel = category ? templateCategoryLabel(category) : null;
  const aspects = project.formats ?? [];
  return {
    id,
    manifest,
    name: manifest.name,
    tagline: manifest.tagline,
    category,
    categoryLabel,
    tags: manifest.tags,
    personas: manifest.personas,
    level: manifest.level,
    tier: manifest.tier,
    storeLegal: manifest.storeLegal === true,
    uses: manifest.uses,
    highlights: manifest.highlights ?? [],
    order: manifest.order,
    status: manifest.status,
    sceneCount: project.scenes.length,
    durationMs: projectDurationMs(project),
    aspects,
    primaryAspect: aspects[0] ?? "16:9",
    themeId: project.themeId,
    previews: bundledTemplatePreviews(id),
    haystack: [
      manifest.name,
      manifest.tagline,
      ...manifest.tags,
      ...manifest.personas,
      categoryLabel ?? "",
      ...manifest.uses.map((use) => TEMPLATE_USE_LABELS[use]),
    ]
      .join(" ")
      .toLowerCase(),
  };
}

function categoryRank(category: TemplateCategoryId | null): number {
  if (!category) return TEMPLATE_CATEGORIES.length;
  const i = CATEGORY_IDS.indexOf(category);
  return i < 0 ? TEMPLATE_CATEGORIES.length : i;
}

function compareEntries(a: TemplateEntry, b: TemplateEntry): number {
  const aBlank = a.id === BLANK_TEMPLATE_ID;
  const bBlank = b.id === BLANK_TEMPLATE_ID;
  if (aBlank !== bBlank) return aBlank ? -1 : 1;
  const rank = categoryRank(a.category) - categoryRank(b.category);
  if (rank !== 0) return rank;
  const aBeta = a.status === "beta";
  const bBeta = b.status === "beta";
  if (aBeta !== bBeta) return aBeta ? 1 : -1;
  if (a.order !== b.order) return a.order - b.order;
  return a.name.localeCompare(b.name);
}

let catalogue: TemplateEntry[] | null = null;

function buildCatalogue(): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  for (const [path, raw] of Object.entries(templateGlob)) {
    const id = path.split("/")[2];
    const parsed = templateManifestSchema.safeParse(raw, `${id}/template.json`);
    if (!parsed.success) {
      console.warn(`[templates] ${id}/template.json ignored: ${parsed.error.message}`);
      continue;
    }
    const project = projectGlob[`/projects/${id}/project.json`];
    if (!project) {
      console.warn(`[templates] ${id} has a template.json but no project.json, ignored`);
      continue;
    }
    entries.push(toEntry(id, parsed.data, project));
  }
  return entries.sort(compareEntries);
}

/** The whole catalogue in picker order: Blank, then category order, stable before beta, then `order`, then name. Memoised, since the globs are eager and nothing here can change at runtime. */
export function listTemplates(): TemplateEntry[] {
  if (!catalogue) catalogue = buildCatalogue();
  return catalogue;
}

export function findTemplate(id: string): TemplateEntry | undefined {
  return listTemplates().find((entry) => entry.id === id);
}

export interface TemplateFilter {
  /** Free text over the haystack; whitespace-separated terms all have to match. */
  query?: string;
  /** null/absent is the All row. */
  category?: TemplateCategoryId | null;
  /** null/absent is both tiers. */
  tier?: TemplateTier | null;
}

/** The picker's filter, pure so it is testable without rendering. Blank ignores the category filter: it is pinned first in every view rather than living in a category, so a rail row must never hide it. */
export function searchTemplates(
  entries: readonly TemplateEntry[],
  filter: TemplateFilter = {},
): TemplateEntry[] {
  const terms = (filter.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    if (filter.tier && entry.tier !== filter.tier) return false;
    if (filter.category && entry.category !== filter.category && entry.id !== BLANK_TEMPLATE_ID) {
      return false;
    }
    return terms.every((term) => entry.haystack.includes(term));
  });
}

export interface TemplateCounts {
  all: number;
  byCategory: Record<TemplateCategoryId, number>;
}

/** Rail counts, live against the current search and facets. Blank counts in All only, since it belongs to no category. */
export function templateCategoryCounts(
  entries: readonly TemplateEntry[],
  filter: Omit<TemplateFilter, "category"> = {},
): TemplateCounts {
  const byCategory = Object.fromEntries(TEMPLATE_CATEGORIES.map((c) => [c.id, 0])) as Record<
    TemplateCategoryId,
    number
  >;
  const matched = searchTemplates(entries, { ...filter, category: null });
  for (const entry of matched) {
    if (entry.category) byCategory[entry.category] += 1;
  }
  return { all: matched.length, byCategory };
}
