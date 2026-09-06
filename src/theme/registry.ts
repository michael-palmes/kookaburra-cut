import { invoke } from "@tauri-apps/api/core";
import {
  BUILTIN_THEME_CATALOGUE,
  discoverBuiltinThemeCatalogue,
  refreshThemeLineup,
} from "./catalogue";
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

/** Resolves a theme id from either source; async because workspace themes read through the native side. Never rejects: unknown/broken ids return `fallback` (a scene-level override falls back to its PROJECT's theme instead). */
export async function resolveTheme(
  id: string | undefined,
  fallback: Theme = defaultTheme,
): Promise<Theme> {
  // A manifest without a themeId (hand-edited project.json) degrades to the fallback instead of crashing the load.
  if (!id) return fallback;
  if (isWorkspaceThemeId(id)) {
    const slug = id.slice(WORKSPACE_THEME_PREFIX.length);
    try {
      const text = await invoke<string>("read_theme", { slug });
      const theme = parseThemeDoc(JSON.parse(text), id);
      // The folder slug is the identity (like workspace projects); the document's own id field cannot collide with another theme's.
      if (theme) return { ...theme, id };
    } catch (e) {
      console.warn(`[theme] workspace theme "${id}" failed to load:`, e);
    }
    return fallback;
  }
  const theme = builtinThemes[id];
  if (!theme) console.warn(`[theme] unknown themeId "${id}" — falling back`);
  return theme ?? fallback;
}
