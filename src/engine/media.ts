import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { refreshWorkspaceAssets } from "./assetInventory";

/** Media library frontend over the native module (src-tauri/src/media.rs): per-project asset listing/import and the sha-keyed poster/scrub-frame cache. */

export interface MediaMeta {
  rel: string;
  kind: "video" | "image";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  posterPath: string;
  scrubPaths: string[];
  sha: string;
}

export function listProjectMedia(slug: string): Promise<string[]> {
  return invoke<string[]>("list_project_media", { slug });
}

/** Copy files into the project's assets/; returns the imported relative paths. New files join the workspace asset inventory so `resolveAssetUrl` accepts them immediately, and the app-wide media-changed event refreshes every open picker in every window. */
export async function importMedia(slug: string, paths: string[]): Promise<string[]> {
  const rels = await invoke<string[]>("import_media", { slug, paths });
  await refreshWorkspaceAssets(`ws:${slug}`);
  if (rels.length > 0) {
    await emit("kookaburra://media-imported", { rels });
    await emit("kookaburra://media-changed", null);
  }
  return rels;
}

/** Import one file delivered as bytes (an HTML5 drop in the editor window, where WKWebView never exposes real paths); same destination, inventory refresh and media-changed broadcast as `importMedia`. */
export async function importMediaBytes(
  slug: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string | null> {
  const rel = await invoke<string | null>("import_media_bytes", bytes, {
    headers: { "x-kookaburra-slug": slug, "x-kookaburra-name": fileName },
  });
  if (rel !== null) {
    await refreshWorkspaceAssets(`ws:${slug}`);
    await emit("kookaburra://media-imported", { rels: [rel] });
    await emit("kookaburra://media-changed", null);
  }
  return rel;
}

/** Copy a picked CSV into the project's assets/ for the chart data modal; returns the project-relative path. No inventory refresh or media-changed broadcast: csv is deliberately not a media type, so it never lists in a picker. */
export function importChartData(
  slug: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  return invoke<string>("import_chart_data", bytes, {
    headers: { "x-kookaburra-slug": slug, "x-kookaburra-name": fileName },
  });
}

/** Probe + thumbnail one asset (cached by content hash; first call generates). */
export function mediaMeta(slug: string, rel: string): Promise<MediaMeta> {
  return invoke<MediaMeta>("media_meta", { slug, rel });
}

/** A native file as a webview-loadable URL: Tauri's asset protocol, one seam for both dev and packaged. The path must be inside the asset-protocol scope: the static `$APPDATA/cache/**` + `$HOME/Kookaburra Cut/**` entries in tauri.conf.json, plus the runtime workspace allow in workspace.rs `require_root` (user-chosen roots outside ~/Kookaburra Cut). */
export function fsUrl(absPath: string): string {
  return convertFileSrc(absPath);
}

/** dataTransfer type for dragging a project-relative media path (editor panel → timeline); only works in the editor window, whose webview disables Tauri's native drag-drop interception (which otherwise swallows HTML5 drag events). */
export const MEDIA_DRAG_TYPE = "application/x-kookaburra-media-rel";

export function formatMediaDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Move an asset to the Trash; refused while any scene, edit or the manifest references it. */
export function deleteMedia(slug: string, rel: string): Promise<void> {
  return invoke("delete_media", { slug, rel });
}

/** One project asset nothing points at, as `unused_media` reports it. */
export interface UnusedAsset {
  rel: string;
  bytes: number;
  kind: "video" | "image";
}

/** One file the sweep could not trash, with the reason the native side gave. */
export interface MediaDeleteFailure {
  rel: string;
  message: string;
}

/** Every media file in the project that no scene, edit or the manifest mentions, newest added first (the grid's order); decided by the same guard `deleteMedia` enforces, so the list can never disagree with what a delete will allow. */
export function unusedMedia(slug: string): Promise<UnusedAsset[]> {
  return invoke<UnusedAsset[]>("unused_media", { slug });
}

/** Trash each rel through the per-file guard, in order: a file another window started using since the list was built is refused rather than deleted, and named in the returned failures. One inventory refresh plus one media-changed broadcast at the end, so every window's pickers re-scan once instead of per file. */
export async function deleteUnusedMedia(
  slug: string,
  rels: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<MediaDeleteFailure[]> {
  const failures: MediaDeleteFailure[] = [];
  let done = 0;
  for (const rel of rels) {
    try {
      await deleteMedia(slug, rel);
    } catch (e) {
      failures.push({ rel, message: String(e) });
    }
    onProgress?.(++done, rels.length);
  }
  if (failures.length < rels.length) {
    await refreshWorkspaceAssets(`ws:${slug}`);
    await emit("kookaburra://media-changed", null);
  }
  return failures;
}

/** Reveal a file in Finder (the native side confines the path to workspace-readable roots). */
export function revealPath(absPath: string): Promise<void> {
  return invoke("reveal_in_finder", { path: absPath });
}

// ── Global screenshots (~/Kookaburra Cut/screenshots/, copy-on-use) ────────────

export interface GlobalScreenshot {
  name: string;
  absPath: string;
}

export function listGlobalScreenshots(): Promise<GlobalScreenshot[]> {
  return invoke<GlobalScreenshot[]>("list_global_screenshots");
}

/** Copy external files into the global folder; returns the stored names. */
export function importGlobalScreenshots(paths: string[]): Promise<string[]> {
  return invoke<string[]>("import_global_screenshots", { paths });
}

/** Probe + thumbnail one global screenshot (the shared content-hash cache). */
export function globalScreenshotMeta(name: string): Promise<MediaMeta> {
  return invoke<MediaMeta>("global_screenshot_meta", { name });
}

/** Copy a project asset out to the global folder; returns the stored name. */
export function copyToGlobalScreenshots(slug: string, rel: string): Promise<string> {
  return invoke<string>("copy_to_global_screenshots", { slug, rel });
}

/** Move a library file to the Trash; projects keep their copy-on-use copies. */
export async function deleteGlobalScreenshot(name: string): Promise<void> {
  await invoke("delete_global_screenshot", { name });
  await emit("kookaburra://media-changed", null);
}

/** Rename an asset within assets/ (same extension); returns the new rel. */
export function renameMedia(slug: string, rel: string, newName: string): Promise<string> {
  return invoke("rename_media", { slug, rel, newName });
}
