import { invoke } from "@tauri-apps/api/core";
import type { CatalogueOrderEntry } from "./catalogueOrder";

/** Frontend face of the native library module: the user's templates and presets under `~/Kookaburra Cut/templates|presets/<slug>/`, plus the dev-only writes that land in the checkout. The native side owns every path; this file only types the wire. Bundled catalogues stay synchronous globs (engine/templates.ts, engine/presets.ts) and hydrate their user half through `createUserCatalogue` below, so nothing here ever puts a loading state in front of shipped content. */

/** One workspace (or freshly converted) library folder, as the native side reports it. Text fields travel raw so the frontend keeps sole ownership of both schemas. */
export interface LibraryItemInfo {
  slug: string;
  /** Absolute folder path; the asset resolvers cache it so a library project loads like any other. */
  path: string;
  /** The `template.json` / `preset.json` text. */
  manifestJson: string;
  /** The sibling `project.json` text. */
  projectJson: string;
  /** Timeline total, transition overlaps subtracted (computed natively, like the project listing). */
  durationMs: number;
  sceneCount: number;
  /** The card still, absent until one has been captured. */
  posterPath: string | null;
}

/** Dev-only commands are registered under `#[cfg(debug_assertions)]`, so a release binary carries no repo-write surface at all; failing here names that rather than surfacing a bare "command not found". */
function devInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!import.meta.env.DEV) {
    return Promise.reject(
      new Error(`${command} is a dev-only command and this is a release build`),
    );
  }
  return invoke<T>(command, args);
}

const slugOrders = (entries: readonly CatalogueOrderEntry[]) =>
  entries.map((entry) => ({ slug: entry.id, order: entry.order }));

// ── Workspace templates and presets ───────────────────────────────────────

export function listUserTemplates(): Promise<LibraryItemInfo[]> {
  return invoke<LibraryItemInfo[]>("list_user_templates");
}

export function listUserPresets(): Promise<LibraryItemInfo[]> {
  return invoke<LibraryItemInfo[]>("list_user_presets");
}

/** Snapshot a workspace project into `~/Kookaburra Cut/templates/<slug>/` with a minimal manifest; later edits to the project never reach the template. */
export function convertProjectToTemplate(slug: string): Promise<LibraryItemInfo> {
  return invoke<LibraryItemInfo>("convert_project_to_template", { slug });
}

/** Save one scene as a preset: the TSX, its sidecar and just the assets they reference. */
export function saveSceneAsPreset(
  projectSlug: string,
  sceneStem: string,
): Promise<LibraryItemInfo> {
  return invoke<LibraryItemInfo>("save_scene_as_preset", { projectSlug, sceneStem });
}

/** Copy a template into the workspace so it becomes editable; `templateId` is a bundled slug or `ws:<slug>`. */
export function duplicateTemplateToWorkspace(templateId: string): Promise<LibraryItemInfo> {
  return invoke<LibraryItemInfo>("duplicate_template_to_workspace", { templateId });
}

export function duplicatePresetToWorkspace(presetId: string): Promise<LibraryItemInfo> {
  return invoke<LibraryItemInfo>("duplicate_preset_to_workspace", { presetId });
}

/** Atomic manifest write (tmp + rename); the native side only checks it parses as JSON, the schema stays here. */
export function writeUserTemplateManifest(slug: string, text: string): Promise<void> {
  return invoke<void>("write_user_template_manifest", { slug, text });
}

export function writeUserPresetManifest(slug: string, text: string): Promise<void> {
  return invoke<void>("write_user_preset_manifest", { slug, text });
}

export function deleteUserTemplate(slug: string): Promise<void> {
  return invoke<void>("delete_user_template", { slug });
}

export function deleteUserPreset(slug: string): Promise<void> {
  return invoke<void>("delete_user_preset", { slug });
}

/** Rewrite `order` in each named workspace manifest; `id` is the folder slug. */
export function setUserTemplateOrders(entries: readonly CatalogueOrderEntry[]): Promise<void> {
  return invoke<void>("set_user_template_orders", { entries: slugOrders(entries) });
}

export function setUserPresetOrders(entries: readonly CatalogueOrderEntry[]): Promise<void> {
  return invoke<void>("set_user_preset_orders", { entries: slugOrders(entries) });
}

/** Rewrite `catalogue.order` inside each workspace `theme.json`, creating the block when a hand-written theme has none. */
export function setWorkspaceThemeOrders(entries: readonly CatalogueOrderEntry[]): Promise<void> {
  return invoke<void>("set_workspace_theme_orders", { entries: slugOrders(entries) });
}

/** A bundled theme's JSON text from the checkout. Dev only in practice: release builds have the theme glob compiled in and never call this. */
export function readBuiltinTheme(id: string): Promise<string> {
  return invoke<string>("read_builtin_theme", { id });
}

// ── Dev-only repo writes (checkout trees; a release binary has none of these) ──

export function devWriteBuiltinTheme(id: string, text: string): Promise<void> {
  return devInvoke<void>("dev_write_builtin_theme", { id, text });
}

export function devDeleteBuiltinTheme(id: string): Promise<void> {
  return devInvoke<void>("dev_delete_builtin_theme", { id });
}

/** Rewrite `catalogue.order` in each builtin theme JSON; `id` is the theme id. */
export function devSetBuiltinThemeOrders(entries: readonly CatalogueOrderEntry[]): Promise<void> {
  return devInvoke<void>("dev_set_builtin_theme_orders", {
    entries: entries.map((entry) => ({ id: entry.id, order: entry.order })),
  });
}

export function devWriteTemplateManifest(slug: string, text: string): Promise<void> {
  return devInvoke<void>("dev_write_template_manifest", { slug, text });
}

/** Removes the whole `projects/<slug>/` folder from the checkout. */
export function devDeleteBundledTemplate(slug: string): Promise<void> {
  return devInvoke<void>("dev_delete_bundled_template", { slug });
}

export function devWritePresetManifest(slug: string, text: string): Promise<void> {
  return devInvoke<void>("dev_write_preset_manifest", { slug, text });
}

/** Removes the whole `presets/<slug>/` folder from the checkout. */
export function devDeleteBundledPreset(slug: string): Promise<void> {
  return devInvoke<void>("dev_delete_bundled_preset", { slug });
}

export function devSetTemplateOrders(entries: readonly CatalogueOrderEntry[]): Promise<void> {
  return devInvoke<void>("dev_set_template_orders", { entries: slugOrders(entries) });
}

export function devSetPresetOrders(entries: readonly CatalogueOrderEntry[]): Promise<void> {
  return devInvoke<void>("dev_set_preset_orders", { entries: slugOrders(entries) });
}

// ── The hydrating user half of a catalogue ────────────────────────────────

/** The user side of a catalogue: entries start empty (bundled content renders on the first frame), `refresh` fills them in, and `version` bumps so callers can memoise the merged list instead of rebuilding it per render. Subscribers exist for `useSyncExternalStore`; a failed listing degrades to no user entries with a warning, never to a broken picker. */
export interface UserCatalogue<E> {
  entries(): E[];
  version(): number;
  refresh(): Promise<E[]>;
  subscribe(listener: () => void): () => void;
}

export function createUserCatalogue<E>(
  list: () => Promise<LibraryItemInfo[]>,
  toEntry: (info: LibraryItemInfo) => E | null,
  label: string,
): UserCatalogue<E> {
  let entries: E[] = [];
  let version = 0;
  let ticket = 0;
  const listeners = new Set<() => void>();

  const refresh = async (): Promise<E[]> => {
    const mine = ++ticket;
    let infos: LibraryItemInfo[] = [];
    try {
      infos = await list();
    } catch (e) {
      console.warn(`[${label}] listing user items failed:`, e);
    }
    // A refresh started later (a write, then its re-list) owns the result; this one is stale.
    if (mine !== ticket) return entries;
    entries = infos.flatMap((info) => {
      const entry = toEntry(info);
      return entry ? [entry] : [];
    });
    version += 1;
    for (const listener of listeners) listener();
    return entries;
  };

  return {
    entries: () => entries,
    version: () => version,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
