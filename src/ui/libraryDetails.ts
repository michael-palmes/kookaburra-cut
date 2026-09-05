import {
  devWritePresetManifest,
  devWriteTemplateManifest,
  writeUserPresetManifest,
  writeUserTemplateManifest,
} from "../engine/library";
import type { PresetCategoryId, PresetManifest, PresetStatus } from "../engine/presets";
import type {
  TemplateCategoryId,
  TemplateLevel,
  TemplateManifest,
  TemplateStatus,
  TemplateTier,
} from "../engine/templates";

/** The details modal's contract: what the user may edit, how it folds back into a manifest, and how that manifest reaches disk. The patch and serialise halves are pure so the field rules (a cleared category drops the field, tags trim and de-duplicate, everything else survives untouched) are unit-tested without a modal. */

export type LibraryKind = "template" | "preset";
/** Which tree the folder lives in: the user's workspace, or the checkout (dev only). */
export type LibrarySource = "user" | "bundled";

/** The editable fields, one shape for both catalogues; presets ignore `level` and `tier`. */
export interface ItemDetailsDraft {
  name: string;
  tagline: string;
  /** null files the item under Uncategorised. */
  category: string | null;
  tags: string[];
  level: TemplateLevel;
  tier: TemplateTier;
  status: TemplateStatus & PresetStatus;
}

/** One item the modal is open on. */
export interface ItemDetailsTarget {
  kind: LibraryKind;
  source: LibrarySource;
  /** The folder name, which is what every write command takes. */
  slug: string;
  manifest: TemplateManifest | PresetManifest;
}

export function templateDetailsDraft(manifest: TemplateManifest): ItemDetailsDraft {
  return {
    name: manifest.name,
    tagline: manifest.tagline,
    category: manifest.category ?? null,
    tags: [...manifest.tags],
    level: manifest.level,
    tier: manifest.tier,
    status: manifest.status,
  };
}

export function presetDetailsDraft(manifest: PresetManifest): ItemDetailsDraft {
  return {
    name: manifest.name,
    tagline: manifest.tagline,
    category: manifest.category ?? null,
    tags: [...manifest.tags],
    level: "standard",
    tier: "safe",
    status: manifest.status,
  };
}

export function itemDetailsDraft(target: ItemDetailsTarget): ItemDetailsDraft {
  return target.kind === "template"
    ? templateDetailsDraft(target.manifest as TemplateManifest)
    : presetDetailsDraft(target.manifest as PresetManifest);
}

/** Trimmed, empties dropped, first spelling of a repeat wins. */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function patchTemplateManifest(
  manifest: TemplateManifest,
  draft: ItemDetailsDraft,
): TemplateManifest {
  const next: TemplateManifest = {
    ...manifest,
    name: draft.name.trim(),
    tagline: draft.tagline.trim(),
    tags: cleanTags(draft.tags),
    level: draft.level,
    tier: draft.tier,
    status: draft.status,
  };
  if (draft.category) next.category = draft.category as TemplateCategoryId;
  else delete next.category;
  return next;
}

export function patchPresetManifest(
  manifest: PresetManifest,
  draft: ItemDetailsDraft,
): PresetManifest {
  const next: PresetManifest = {
    ...manifest,
    name: draft.name.trim(),
    tagline: draft.tagline.trim(),
    tags: cleanTags(draft.tags),
    status: draft.status,
  };
  if (draft.category) next.category = draft.category as PresetCategoryId;
  else delete next.category;
  return next;
}

/** Emit only the fields the manifest actually carries, in the order the authored files use, so an edit reads as a field change in git rather than a rewrite. */
function manifestJson(source: Record<string, unknown>, order: readonly string[]): string {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (!order.includes(key) && value !== undefined) out[key] = value;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

const TEMPLATE_FIELD_ORDER = [
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
] as const;

const PRESET_FIELD_ORDER = [
  "version",
  "name",
  "tagline",
  "category",
  "tags",
  "preview",
  "order",
  "status",
  "source",
] as const;

export function templateManifestJson(manifest: TemplateManifest): string {
  return manifestJson(manifest as unknown as Record<string, unknown>, TEMPLATE_FIELD_ORDER);
}

export function presetManifestJson(manifest: PresetManifest): string {
  return manifestJson(manifest as unknown as Record<string, unknown>, PRESET_FIELD_ORDER);
}

/** The manifest text an edit would write, without writing it. */
export function itemDetailsJson(target: ItemDetailsTarget, draft: ItemDetailsDraft): string {
  return target.kind === "template"
    ? templateManifestJson(patchTemplateManifest(target.manifest as TemplateManifest, draft))
    : presetManifestJson(patchPresetManifest(target.manifest as PresetManifest, draft));
}

/** Write the edited manifest back to its own tree: the workspace commands for the user's items, the dev-only checkout commands for bundled ones (which a release build refuses outright). */
export function writeItemDetails(
  target: ItemDetailsTarget,
  draft: ItemDetailsDraft,
): Promise<void> {
  const text = itemDetailsJson(target, draft);
  if (target.kind === "template") {
    return target.source === "user"
      ? writeUserTemplateManifest(target.slug, text)
      : devWriteTemplateManifest(target.slug, text);
  }
  return target.source === "user"
    ? writeUserPresetManifest(target.slug, text)
    : devWritePresetManifest(target.slug, text);
}
