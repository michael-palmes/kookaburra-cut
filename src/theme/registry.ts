import { invoke } from "@tauri-apps/api/core";
import kookaburraAbyssDoc from "./builtin/kookaburra-abyss.json";
import kookaburraDefaultDoc from "./builtin/kookaburra-default.json";
import kookaburraEmberDoc from "./builtin/kookaburra-ember.json";
import kookaburraFxDoc from "./builtin/kookaburra-fx.json";
import kookaburraGalleryDoc from "./builtin/kookaburra-gallery.json";
import kookaburraLoftDoc from "./builtin/kookaburra-loft.json";
import kookaburraMidnightDoc from "./builtin/kookaburra-midnight.json";
import kookaburraNeonDoc from "./builtin/kookaburra-neon.json";
import kookaburraPacificDoc from "./builtin/kookaburra-pacific.json";
import kookaburraPaperDoc from "./builtin/kookaburra-paper.json";
import kookaburraStudioWhiteDoc from "./builtin/kookaburra-studio-white.json";
import kookaburraSunriseDoc from "./builtin/kookaburra-sunrise.json";
import { parseThemeDoc } from "./schema";
import type { Theme } from "./tokens";

/** Theme resolution: bundled themes ship as JSON beside this module; user themes live at `~/Kookaburra Cut/themes/<slug>/theme.json` and resolve via the native `read_theme` command under `ws:<slug>` ids. Unknown or broken ids fall back to the default theme; a theme reference can degrade but never crash a project load. */

// Explicit imports (not a glob) keep the bundled set type-checked and vitest-loadable; new themes must register here AND in schema.test.ts (a silently-degraded builtin must fail unit tests, not gates).
const BUILTIN_DOCS: { doc: unknown; source: string }[] = [
  { doc: kookaburraDefaultDoc, source: "builtin kookaburra-default" },
  { doc: kookaburraFxDoc, source: "builtin kookaburra-fx" },
  // The lineup: 6 light / 4 dark themes, in picker order.
  { doc: kookaburraStudioWhiteDoc, source: "builtin kookaburra-studio-white" },
  { doc: kookaburraPacificDoc, source: "builtin kookaburra-pacific" },
  { doc: kookaburraPaperDoc, source: "builtin kookaburra-paper" },
  { doc: kookaburraGalleryDoc, source: "builtin kookaburra-gallery" },
  { doc: kookaburraSunriseDoc, source: "builtin kookaburra-sunrise" },
  { doc: kookaburraLoftDoc, source: "builtin kookaburra-loft" },
  { doc: kookaburraMidnightDoc, source: "builtin kookaburra-midnight" },
  { doc: kookaburraNeonDoc, source: "builtin kookaburra-neon" },
  { doc: kookaburraAbyssDoc, source: "builtin kookaburra-abyss" },
  { doc: kookaburraEmberDoc, source: "builtin kookaburra-ember" },
];

/** Bundled themes keyed by id. */
export const builtinThemes: Record<string, Theme> = {};
for (const { doc, source } of BUILTIN_DOCS) {
  const theme = parseThemeDoc(doc, source);
  if (theme) builtinThemes[theme.id] = theme;
}

const fallback = builtinThemes["kookaburra-default"];
if (!fallback) {
  // Unreachable when schema.test.ts is green; a missing default must fail loudly, not propagate a null theme through every scene.
  throw new Error("builtin theme kookaburra-default failed to parse");
}

/** The app-wide fallback theme (and the editor store's initial value). */
export const defaultTheme: Theme = fallback;

/** The picker lineup (6 light, then 4 dark). The legacy `kookaburra-default`/`kookaburra-fx` themes are engine fallbacks for pre-v8 projects, not picker entries. */
export const THEME_LINEUP: readonly string[] = [
  "kookaburra-studio-white",
  "kookaburra-pacific",
  "kookaburra-paper",
  "kookaburra-gallery",
  "kookaburra-sunrise",
  "kookaburra-loft",
  "kookaburra-midnight",
  "kookaburra-neon",
  "kookaburra-abyss",
  "kookaburra-ember",
];

/** The lineup as resolved Theme objects, in picker order. */
export function lineupThemes(): Theme[] {
  return THEME_LINEUP.map((id) => builtinThemes[id]).filter((t): t is Theme => Boolean(t));
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
