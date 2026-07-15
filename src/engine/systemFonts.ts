import { invoke } from "@tauri-apps/api/core";
import {
  collectThemeFontRefs,
  hasPinnedWeight,
  isBundledFamily,
  registerWorkspaceFont,
} from "../theme/fonts";
import type { Theme } from "../theme/tokens";
import { fsUrl } from "./media";

/** System-font auto-pinning: a theme may reference any installed font family, and the first reference pins it (the native side copies/extracts the face into `~/Kookaburra Cut/fonts/` and records it in `fonts.json`; see src-tauri/src/fonts.rs) and registers the pinned copy's asset-protocol URL with the resolver. Exports then depend on the pinned bytes, never the OS file (which drifts with macOS updates). Failures degrade to the Inter fallback with a warning, never a crash. Projects whose themes use only bundled fonts never touch the native side (the legacy no-op path). */

interface PinnedFont {
  family: string;
  weight: number;
  postscript: string;
  file: string;
  /** Provenance when the source was a variable font instanced at pin time. */
  instanced?: { axes: Record<string, number>; instancer: string };
  /** Hydrated absolute path (the manifest stores only the file name). */
  path: string;
}

/** One pin attempt per (family, weight) per app run; a missing family must not re-invoke the native lookup on every project load. */
const pinAttempted = new Set<string>();

/** Register the workspace's pinned library with the resolver (no-op without a workspace). */
export async function refreshWorkspaceFonts(): Promise<void> {
  try {
    const fonts = await invoke<PinnedFont[]>("list_workspace_fonts");
    for (const font of fonts) {
      registerWorkspaceFont(font.family, font.weight, fsUrl(font.path));
    }
  } catch {
    // No workspace configured yet, bundled fonts only.
  }
}

/** Resolves every theme font: refreshes the pinned library, then auto-pins whatever is still unresolvable. Awaited by `loadProject` before scenes render, so `fontUrl` stays a sync lookup at render time and the export preamble's `preloadAppFonts(refs)` barrier sees final URLs. */
export async function ensureThemeFontsPinned(
  themes: readonly (Theme | undefined)[],
): Promise<void> {
  const resolved = (ref: { family: string; weight: number }) =>
    isBundledFamily(ref.family) || hasPinnedWeight(ref.family, ref.weight);
  const refs = collectThemeFontRefs(themes);
  if (refs.every(resolved)) return;
  await refreshWorkspaceFonts();
  for (const ref of refs) {
    if (resolved(ref)) continue;
    const key = `${ref.family}:${ref.weight}`;
    if (pinAttempted.has(key)) continue;
    pinAttempted.add(key);
    try {
      const pinned = await invoke<PinnedFont>("pin_system_font", {
        family: ref.family,
        weight: ref.weight,
      });
      registerWorkspaceFont(pinned.family, pinned.weight, fsUrl(pinned.path));
    } catch (e) {
      console.warn(`[fonts] pinning "${ref.family}" (${ref.weight}) failed:`, e);
    }
  }
}
