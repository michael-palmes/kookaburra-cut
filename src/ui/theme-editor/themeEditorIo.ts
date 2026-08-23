import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { devWriteBuiltinTheme, readBuiltinTheme } from "../../engine/library";
import { themeScope } from "./themeDraft";

/** The theme editor's IO seam: read the RAW document text for either scope, write it back, and tell the other windows a theme changed. Kept out of the components so the window's React tree never invokes directly. */

/** Bundled themes are only writable from a checkout: a release build has no repo-write commands at all, so the Save control is not rendered. */
export const canEditBundledThemes = import.meta.env.DEV;

/** True when this build can open the editor on `themeId` at all. */
export function canEditTheme(themeId: string): boolean {
  return themeScope(themeId).kind === "workspace" || canEditBundledThemes;
}

/** Open (or retarget) the theme editor window on `themeId`. */
export function openThemeEditor(themeId: string): Promise<void> {
  return invoke<void>("open_theme_editor_window", { themeId });
}

export function readThemeDocText(themeId: string): Promise<string> {
  const scope = themeScope(themeId);
  return scope.kind === "workspace"
    ? invoke<string>("read_theme", { slug: scope.slug })
    : readBuiltinTheme(scope.id);
}

export function writeThemeDocText(themeId: string, text: string): Promise<void> {
  const scope = themeScope(themeId);
  if (scope.kind === "workspace") {
    return invoke<void>("write_theme", { slug: scope.slug, text });
  }
  if (!canEditBundledThemes) {
    return Promise.reject(
      new Error("Built-in themes are read-only here: duplicate it to your library before editing"),
    );
  }
  return devWriteBuiltinTheme(scope.id, text);
}

/** A theme document was saved. Windows showing that theme re-list (and reload) off this; bundled saves in dev also ride Vite's own HMR of the builtin glob, so the event is the workspace half's equivalent. */
export const THEME_SAVED_EVENT = "kookaburra://theme-saved";

export interface ThemeSavedPayload {
  themeId: string;
  /** The document as written, so a listener can refresh previews without a second read. */
  json: string;
}

export function emitThemeSaved(payload: ThemeSavedPayload): Promise<void> {
  return emit(THEME_SAVED_EVENT, payload);
}

/** Subscribe to saves from the editor window; returns a disposer suitable for a `useEffect` cleanup. */
export function onThemeSaved(handler: (payload: ThemeSavedPayload) => void): () => void {
  const pending = listen<ThemeSavedPayload>(THEME_SAVED_EVENT, (event) => handler(event.payload));
  let disposed = false;
  void pending.then((un) => {
    if (disposed) un();
  });
  return () => {
    disposed = true;
    void pending.then((un) => un());
  };
}
