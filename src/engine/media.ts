import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { refreshWorkspaceAssets } from "./assetRevisions";

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

/** One scene's terminal snapshot PNG, overwriting the canonical `assets/terminal-<stem>.png` in place (recaptures re-bake at one home; its refreshed revision moves mounted readers to a new URL). Same inventory refresh and media-changed broadcast as the other imports. */
export async function writeTerminalSnapshot(
  slug: string,
  sceneStem: string,
  bytes: Uint8Array,
): Promise<string> {
  const rel = await invoke<string>("write_terminal_snapshot", bytes, {
    headers: { "x-kookaburra-slug": slug, "x-kookaburra-stem": sceneStem },
  });
  await refreshWorkspaceAssets(`ws:${slug}`);
  await emit("kookaburra://media-changed", null);
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

/** Probe + thumbnail one asset (cached by content hash; first call generates). A file a conform is still writing (a clip placed while it conforms) answers once the job ends. */
export async function mediaMeta(slug: string, rel: string): Promise<MediaMeta> {
  try {
    return await invoke<MediaMeta>("media_meta", { slug, rel });
  } catch (e) {
    if (!(await conformEnded(slug, rel))) throw e;
    return invoke<MediaMeta>("media_meta", { slug, rel });
  }
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

// ── Ingest conform (src-tauri/src/conform.rs) ──────────────────────────────────

/** One conform the app is running: `rel` is where the mezzanine appears when it lands. */
export interface ConformJob {
  slug: string;
  rel: string;
  original: string;
  frame: number;
  total: number;
}

/** A conform job's progress, broadcast app-wide. */
export interface ConformProgress {
  slug: string;
  rel: string;
  stage: "queued" | "conforming" | "done" | "failed";
  frame: number;
  total: number;
  error: string | null;
}

export const CONFORM_PROGRESS_EVENT = "kookaburra://conform-progress";

/** A library card's conform flag, from a probe verdict cached by content sha. */
export interface ConformStatus {
  needsConform: boolean;
  verdict: "ok" | "suspect" | "ffmpeg-misdecodes";
  reasons: string[];
  why: string[];
  /** Why the file can't be conformed, when it can't. */
  refused: string | null;
}

export function listConformJobs(slug: string): Promise<ConformJob[]> {
  return invoke<ConformJob[]>("list_conform_jobs", { slug });
}

/** Conform a project video in place: the original moves to `assets/.originals/` and the mezzanine keeps the name, so references stay valid. Resolves once the job is queued. */
export function conformMedia(slug: string, rel: string): Promise<string> {
  return invoke<string>("conform_media", { slug, rel });
}

export function conformStatus(slug: string, rel: string, sha: string): Promise<ConformStatus> {
  return invoke<ConformStatus>("conform_status", { slug, rel, sha });
}

/** How many of `rels` are still conforming (an import's toast says so). */
export async function conformingAmong(slug: string, rels: readonly string[]): Promise<number> {
  const jobs = await listConformJobs(slug).catch(() => [] as ConformJob[]);
  return rels.filter((rel) => jobs.some((job) => job.rel === rel)).length;
}

/** A job's progress as a whole percentage; 0 while it waits for a slot. */
export function conformPercent(job: Pick<ConformJob, "frame" | "total">): number {
  return job.total > 0 ? Math.min(100, Math.floor((job.frame / job.total) * 100)) : 0;
}

/** Fold one progress event into the job list: queued and conforming upsert in place (the queue keeps its order), done and failed drop the job. */
export function applyConformProgress(
  jobs: readonly ConformJob[],
  event: ConformProgress,
  original = "",
): ConformJob[] {
  const same = (job: ConformJob) => job.slug === event.slug && job.rel === event.rel;
  if (event.stage === "done" || event.stage === "failed") return jobs.filter((job) => !same(job));
  const prior = jobs.find(same);
  const next: ConformJob = {
    slug: event.slug,
    rel: event.rel,
    original: prior?.original || original,
    frame: event.frame,
    total: event.total,
  };
  return prior ? jobs.map((job) => (job === prior ? next : job)) : [...jobs, next];
}

/** The error a conform stopped from the queue reports (its stage is `failed`). */
export const CONFORM_CANCELLED = "cancelled";

/** Whether an event is a stop rather than a failure worth showing. */
export function conformWasCancelled(event: Pick<ConformProgress, "stage" | "error">): boolean {
  return event.stage === "failed" && event.error === CONFORM_CANCELLED;
}

/** Stop a running or queued conform: an import comes back as its original, a plain file; an in-place conform leaves the file as it was. */
export function cancelConform(slug: string, rel: string): Promise<void> {
  return invoke<void>("cancel_conform", { slug, rel });
}

/** The frame rate every mezzanine is written at (conform.rs `CONFORM_FPS`). */
export const CONFORM_FPS = 60;

/** Resolves when a conform writing `rel` ends, landed or not; false at once when none is running. */
async function conformEnded(slug: string, rel: string): Promise<boolean> {
  const running = async () =>
    (await listConformJobs(slug).catch(() => [] as ConformJob[])).some((job) => job.rel === rel);
  if (!(await running())) return false;
  await new Promise<void>((resolve) => {
    let ended = false;
    let unlisten: (() => void) | null = null;
    const end = () => {
      if (ended) return;
      ended = true;
      unlisten?.();
      resolve();
    };
    listen<ConformProgress>(CONFORM_PROGRESS_EVENT, ({ payload }) => {
      if (payload.slug !== slug || payload.rel !== rel) return;
      if (payload.stage === "done" || payload.stage === "failed") end();
    })
      .then(async (fn) => {
        unlisten = fn;
        if (ended) fn();
        // The job may have ended between the first look and the listener going up.
        else if (!(await running())) end();
      })
      .catch(end);
  });
  return true;
}

const pendingMetaLoads = new Map<string, Promise<MediaMeta>>();

/** A still-conforming import's card meta, read off its original (`assets/.originals/…`: same picture size and length) under the mezzanine's rel and frame rate, so the card shows a poster and can be placed before the file exists. */
export async function pendingConformMeta(
  slug: string,
  job: Pick<ConformJob, "rel" | "original">,
): Promise<MediaMeta> {
  let original = job.original;
  if (!original) {
    const jobs = await listConformJobs(slug);
    original = jobs.find((candidate) => candidate.rel === job.rel)?.original ?? "";
    if (!original) throw new Error(`${job.rel} isn't conforming`);
  }
  const key = `${slug}\n${original}`;
  let load = pendingMetaLoads.get(key);
  if (!load) {
    load = invoke<MediaMeta>("media_meta", { slug, rel: original });
    pendingMetaLoads.set(key, load);
    // Shared while it runs only: a later import can reuse the original's name for another file.
    void load.then(
      () => pendingMetaLoads.delete(key),
      () => pendingMetaLoads.delete(key),
    );
  }
  const meta = await load;
  return { ...meta, rel: job.rel, fps: CONFORM_FPS };
}

// ── Kept originals (`assets/.originals/`) ──────────────────────────────────────

/** One kept original, as `list_originals` reports it. */
export interface OriginalFile {
  /** `assets/.originals/<file>`. */
  rel: string;
  bytes: number;
  /** The conformed clip made from it, while that clip exists. */
  clip: string | null;
  /** Why it can't be removed now (still conforming, or a project file names it), else null. */
  busy: string | null;
}

export interface RemovedOriginals {
  count: number;
  bytes: number;
}

export function listOriginals(slug: string): Promise<OriginalFile[]> {
  return invoke<OriginalFile[]>("list_originals", { slug });
}

/** The originals Remove originals would take: count and total bytes. */
export function removableOriginals(originals: readonly OriginalFile[]): RemovedOriginals {
  const free = originals.filter((original) => original.busy === null);
  return { count: free.length, bytes: free.reduce((sum, original) => sum + original.bytes, 0) };
}

/** The original `rel` (a conformed clip) was made from, if one is kept. */
export function originalOfClip(
  originals: readonly OriginalFile[],
  rel: string,
): OriginalFile | null {
  return originals.find((original) => original.clip === rel) ?? null;
}

/** Move a clip's original to the Trash; the clip stays. Other windows' libraries re-scan. */
export async function removeOriginal(slug: string, rel: string): Promise<RemovedOriginals> {
  const removed = await invoke<RemovedOriginals>("remove_original", { slug, rel });
  await emit("kookaburra://media-changed", null);
  return removed;
}

/** Move every original nothing needs to the Trash. */
export async function removeOriginals(slug: string): Promise<RemovedOriginals> {
  const removed = await invoke<RemovedOriginals>("remove_originals", { slug });
  if (removed.count > 0) await emit("kookaburra://media-changed", null);
  return removed;
}

/** Settings: Conform new videos (on unless switched off). */
export function setConformNewVideosSetting(enabled: boolean): Promise<void> {
  return invoke<void>("set_conform_new_videos", { enabled });
}
