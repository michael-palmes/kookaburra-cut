import { invoke } from "@tauri-apps/api/core";
import { collectParseWarnings } from "../engine/parseWarnings";
import {
  BUILTIN_THEME_CATALOGUE,
  discoverBuiltinThemeCatalogue,
  refreshThemeLineup,
} from "./catalogue";
import { collectThemeChain, resolveThemeDocument, type ThemeDocLookup } from "./extends";
import { parseThemeDoc } from "./schema";
import type { Theme } from "./tokens";

/** Theme resolution: bundled themes ship as JSON beside this module; user themes live at `~/Kookaburra Cut/themes/<slug>/theme.json` and resolve via the native `read_theme` command under `ws:<slug>` ids. Unknown or broken ids fall back to the default theme; a theme reference can degrade but never crash a project load. */

/** Bundled themes keyed by id. */
export const builtinThemes: Record<string, Theme> = {};
for (const { theme } of BUILTIN_THEME_CATALOGUE) builtinThemes[theme.id] = theme;

export function updateBuiltinTheme(id: string, doc: unknown): void {
  const index = BUILTIN_THEME_CATALOGUE.findIndex((entry) => entry.id === id);
  const entries = doc === null ? [] : discoverBuiltinThemeCatalogue({ [`${id}.json`]: doc });
  if (index >= 0) BUILTIN_THEME_CATALOGUE.splice(index, 1, ...entries);
  else BUILTIN_THEME_CATALOGUE.push(...entries);
  if (entries[0]) builtinThemes[id] = entries[0].theme;
  else delete builtinThemes[id];
  refreshThemeLineup();
}

if (import.meta.hot) {
  import.meta.hot.on("kookaburra:theme-document", ({ id, content }) => {
    updateBuiltinTheme(id, content);
    window.dispatchEvent(new Event("kookaburra:themes-changed"));
  });
}

const fallback = builtinThemes["kookaburra-default"];
if (!fallback) {
  // Unreachable when schema.test.ts is green; a missing default must fail loudly, not propagate a null theme through every scene.
  throw new Error("builtin theme kookaburra-default failed to parse");
}

/** The app-wide fallback theme (and the editor store's initial value). */
export const defaultTheme: Theme = fallback;

export { BUILTIN_THEME_CATALOGUE, THEME_LINEUP } from "./catalogue";

/** The lineup as resolved Theme objects, in picker order. */
export function lineupThemes(): Theme[] {
  return BUILTIN_THEME_CATALOGUE.filter((entry) => !entry.catalogue.hidden).map(
    (entry) => entry.theme,
  );
}

export const WORKSPACE_THEME_PREFIX = "ws:";

export function isWorkspaceThemeId(id: string): boolean {
  return id.startsWith(WORKSPACE_THEME_PREFIX);
}

/** The raw document behind any theme id, for an `extends` chain: bundled ones off the catalogue, workspace ones through the native read. */
export async function readThemeDocument(id: string): Promise<unknown> {
  if (isWorkspaceThemeId(id)) {
    const slug = id.slice(WORKSPACE_THEME_PREFIX.length);
    return JSON.parse(await invoke<string>("read_theme", { slug }));
  }
  return BUILTIN_THEME_CATALOGUE.find((entry) => entry.id === id)?.doc;
}

/** A lookup over an already-read map (the picker's listing, a prefetched chain), then the bundled documents. */
export function themeDocLookup(docs: ReadonlyMap<string, unknown>): ThemeDocLookup {
  return (id) =>
    docs.has(id) ? docs.get(id) : BUILTIN_THEME_CATALOGUE.find((entry) => entry.id === id)?.doc;
}

/** A raw document with its `extends` chain merged, bases read through the native side; undefined (warned) when the chain is broken. */
export async function resolveThemeJson(raw: unknown, source: string): Promise<unknown> {
  const docs = await collectThemeChain(raw, readThemeDocument);
  return resolveThemeDocument(raw, source, themeDocLookup(docs));
}

export interface ThemeReport {
  theme: Theme;
  /** What the document dropped, or why the theme fell back, as parser messages. */
  warnings: string[];
}

/** `resolveTheme` plus the warnings its parse raised, for a load that surfaces them. Never rejects. */
export async function resolveThemeReport(
  id: string | undefined,
  fallback: Theme = defaultTheme,
): Promise<ThemeReport> {
  // A manifest without a themeId (hand-edited project.json) degrades to the fallback instead of crashing the load.
  if (!id) return { theme: fallback, warnings: [] };
  if (isWorkspaceThemeId(id)) {
    let raw: unknown;
    let docs: Map<string, unknown>;
    try {
      raw = await readThemeDocument(id);
      docs = await collectThemeChain(raw, readThemeDocument);
    } catch (e) {
      console.warn(`[theme] workspace theme "${id}" failed to load:`, e);
      return {
        theme: fallback,
        warnings: [`[theme] ${id}: can't be read, so a fallback theme shows`],
      };
    }
    const { result: theme, warnings } = collectParseWarnings(() => {
      const doc = resolveThemeDocument(raw, id, themeDocLookup(docs));
      return doc === undefined ? undefined : parseThemeDoc(doc, id);
    });
    // The folder slug is the identity (like workspace projects); the document's own id field cannot collide with another theme's.
    return theme ? { theme: { ...theme, id }, warnings } : { theme: fallback, warnings };
  }
  const theme = builtinThemes[id];
  if (theme) return { theme, warnings: [] };
  console.warn(`[theme] unknown themeId "${id}", falling back`);
  return {
    theme: fallback,
    warnings: [`[theme] ${id}: isn't a theme this version knows, so a fallback theme shows`],
  };
}

/** Resolves a theme id from either source; async because workspace themes read through the native side. Never rejects: unknown/broken ids return `fallback` (a scene-level override falls back to its PROJECT's theme instead). */
export async function resolveTheme(
  id: string | undefined,
  fallback: Theme = defaultTheme,
): Promise<Theme> {
  const report = await resolveThemeReport(id, fallback);
  for (const warning of report.warnings) console.warn(warning);
  return report.theme;
}
