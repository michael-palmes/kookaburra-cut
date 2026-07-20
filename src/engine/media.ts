import { convertFileSrc, invoke } from "@tauri-apps/api/core";

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

/** Copy files into the project's assets/; returns the imported relative paths. */
export function importMedia(slug: string, paths: string[]): Promise<string[]> {
  return invoke<string[]>("import_media", { slug, paths });
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

/** Move an asset to the Trash; refused while any scene/manifest references it. */
export function deleteMedia(slug: string, rel: string): Promise<void> {
  return invoke("delete_media", { slug, rel });
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

/** Rename an asset within assets/ (same extension); returns the new rel. */
export function renameMedia(slug: string, rel: string, newName: string): Promise<string> {
  return invoke("rename_media", { slug, rel, newName });
}
