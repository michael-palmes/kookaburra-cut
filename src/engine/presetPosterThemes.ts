import { invoke } from "@tauri-apps/api/core";
import { defaultTheme, resolveTheme } from "../theme/registry";
import { parseThemeDoc } from "../theme/schema";
import type { Theme } from "../theme/tokens";

export async function resolveSavedPosterTheme(
  id: string | undefined,
  fallback: Theme = defaultTheme,
  dev = import.meta.env.DEV,
): Promise<Theme> {
  if (!dev || id?.startsWith("ws:")) return resolveTheme(id, fallback);
  id ??= fallback.id;
  const text = await invoke<string>("read_builtin_theme", { id });
  const theme = parseThemeDoc(JSON.parse(text), id);
  if (!theme) throw new Error(`Saved theme "${id}" is invalid`);
  return theme;
}
