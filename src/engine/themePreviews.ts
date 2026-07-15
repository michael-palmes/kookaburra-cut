import { invoke } from "@tauri-apps/api/core";
import { canvasCommittedProject } from "./exportBridge";
import { fsUrl } from "./media";
import type { LoadedProject } from "./project";
import { captureFrameAt, withBorrowedClock } from "./snapshots";

/** Theme previews (locked decision 14): the middle frame of each of the 4 standard `theme-starter` scenes, 640px JPEG, captured off the live preview canvas via the borrowed clock (the scene-thumbs precedent, never the export loop). Bundled themes' previews are rendered by `kookaburra:run --action theme-previews` and committed under `src/assets/theme-previews/`; user themes cache at `$APPDATA/cache/theme-previews/<key>/` keyed by a content hash of the theme JSON. */

export const THEME_PREVIEW_WIDTH = 640;
export const THEME_PREVIEW_COUNT = 4;

// Committed bundled previews as fingerprinted URLs; a glob (not explicit imports) so a not-yet-generated preview degrades to placeholder art instead of failing the build.
const bundledGlob = import.meta.glob<string>("../assets/theme-previews/*.jpg", {
  query: "?url",
  import: "default",
  eager: true,
});

/** The committed preview URLs for a bundled theme, all 4 in scene order, or null. */
export function bundledThemePreviews(themeId: string): string[] | null {
  const urls: string[] = [];
  for (let i = 1; i <= THEME_PREVIEW_COUNT; i++) {
    const url = bundledGlob[`../assets/theme-previews/${themeId}-${i}.jpg`];
    if (!url) return null;
    urls.push(url);
  }
  return urls;
}

/** The capture points: each scene's middle frame on the global clock (overlap-aware). */
export function sceneMiddles(project: LoadedProject): number[] {
  return project.slots.map((slot) => Math.round(slot.startMs + slot.durationMs / 2));
}

/** Waits until the canvas tree has committed this project (the CompositorDriver stamp); a project swap (`applyLoadedProject`) renders on React's concurrent lane while a capture's clock write is sync-lane, so without this barrier the clock stamp can land on the old tree and the capture reads the previous theme's content (the stale scene-1 preview bug, 2026-07-07: every batch theme's first capture was one theme behind). */
export async function awaitProjectCommitted(project: LoadedProject): Promise<void> {
  for (let spins = 0; canvasCommittedProject() !== project; spins++) {
    if (spins > 5000) {
      throw new Error("Canvas tree never committed the swapped project.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Captures the loaded project's per-scene middle frames as JPEGs. The caller has already swapped the target project (with its theme override) into the canvas; null when capture isn't possible right now (export in progress, canvas unmounted). */
export function captureThemePreviewFrames(project: LoadedProject): Promise<Uint8Array[] | null> {
  return withBorrowedClock(async () => {
    const frames: Uint8Array[] = [];
    for (const tMs of sceneMiddles(project)) {
      const bytes = await captureFrameAt(tMs, THEME_PREVIEW_WIDTH, "jpeg");
      if (!bytes) throw new Error(`theme-preview capture failed at ${tMs}ms`);
      frames.push(bytes);
    }
    return frames;
  });
}

/** Persist a captured preview set natively (raw-body invokes, the write_snapshot path). */
export async function writeThemePreviews(
  kind: "autorun" | "cache",
  key: string,
  frames: Uint8Array[],
): Promise<void> {
  for (let i = 0; i < frames.length; i++) {
    await invoke("write_theme_preview", frames[i], {
      headers: {
        "x-kookaburra-kind": kind,
        "x-kookaburra-key": key,
        "x-kookaburra-index": String(i + 1),
      },
    });
  }
}

/** A user theme's cache key: sha-256 of its JSON text (hex, truncated, slug-safe). */
export async function themePreviewKey(themeJson: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(themeJson));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Cached user-theme preview URLs for a content-hash key, all 4 in scene order, or null. */
export async function cachedThemePreviews(key: string): Promise<string[] | null> {
  const paths = await invoke<string[] | null>("list_theme_previews", { key });
  return paths ? paths.map(fsUrl) : null;
}

/** Generates (or reuses) a user theme's preview set by borrowing the canvas: loads the starter under the theme, captures the 4 scene middles, caches them under the theme JSON's content hash, then hands the canvas back via `restore`. UI-only, the export guards inside `withBorrowedClock`/`captureFrameAt` still apply. Returns the cached URLs, or null when capture wasn't possible (previews stay placeholders). */
export async function ensureUserThemePreviews(
  themeId: string,
  themeJson: string,
  applyProject: (loaded: LoadedProject) => void,
  restore: () => Promise<void>,
): Promise<string[] | null> {
  const key = await themePreviewKey(themeJson);
  const existing = await cachedThemePreviews(key).catch(() => null);
  if (existing) return existing;
  const { loadProject } = await import("./project");
  const { awaitSceneHostsCommitted } = await import("./exporter");
  const { preloadBundledBackdrops } = await import("../toolkit/stage/backdrops");
  try {
    await preloadBundledBackdrops();
    const starter = await loadProject("theme-starter", { themeId });
    applyProject(starter);
    await awaitProjectCommitted(starter);
    await awaitSceneHostsCommitted(starter.slots.length);
    const frames = await captureThemePreviewFrames(starter);
    if (!frames) return null;
    await writeThemePreviews("cache", key, frames);
    return cachedThemePreviews(key);
  } finally {
    await restore();
  }
}
