import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { isExporting } from "./exportState";

/** Asset revisions: every workspace asset URL carries `?r=<size>-<mtimeNs>` from the native stamp walk (`list_project_asset_stamps`, separate from the trust fingerprint), so a file replaced in place under the same name is a new URL in every window, and every texture, decode and media cache keyed by URL re-fetches. The asset protocol ignores the query, so the bytes served never depend on it. Bundled projects stay bare (Vite fingerprints them) unless dev HMR replaced a file. Inventories refresh at project load, after the app's own imports, and on the editor poll's settled asset-stamp change; never mid-export (callers guard). Its own module, free of project.ts, so media.ts can refresh it without an import cycle. */

interface AssetStampRow {
  rel: string;
  size: number;
  mtimeNs: string;
}

interface ProjectAssetStamps {
  stamp: string;
  assets: AssetStampRow[];
}

interface Inventory {
  stamp: string;
  revs: Map<string, string>;
}

const WORKSPACE_BACKED = /^(ws|ws-template|ws-preset):/;
/** Mirrors Rust's IMAGE_EXTENSIONS: the subset `resolveAssetUrl` accepts. */
const IMAGE_REL = /\.(png|jpe?g|webp)$/i;

const inventories = new Map<string, Inventory>();
/** Local bumps where no stamp exists: dev HMR on bundled projects, or a write while the listing failed. */
const localBumps = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const changeListeners = new Set<AssetChangeListener>();
const pendingStamps = new Map<string, string>();
const inflight = new Map<string, Promise<string[]>>();

/** Called with the rels whose revision moved and the revisions they had (undefined for a new file). */
export type AssetChangeListener = (
  projectId: string,
  changes: readonly { rel: string; before: string | undefined }[],
) => void;

function cleanRel(rel: string): string {
  return rel.replace(/^\.?\//, "");
}

function revKey(projectId: string, rel: string): string {
  return `${projectId}::${cleanRel(rel)}`;
}

function nativeSlug(projectId: string): string {
  return projectId.startsWith("ws:") ? projectId.slice(3) : projectId;
}

function notify(projectId: string, changes: { rel: string; before: string | undefined }[]): void {
  if (changes.length === 0) return;
  for (const listener of changeListeners) listener(projectId, changes);
  for (const { rel } of changes) {
    for (const listener of listeners.get(revKey(projectId, rel)) ?? []) listener();
  }
}

function changedRels(
  before: ReadonlyMap<string, string> | undefined,
  after: ReadonlyMap<string, string>,
): { rel: string; before: string | undefined }[] {
  const changes: { rel: string; before: string | undefined }[] = [];
  for (const [rel, rev] of after) {
    if (before?.get(rel) !== rev) changes.push({ rel, before: before?.get(rel) });
  }
  for (const [rel, rev] of before ?? []) {
    if (!after.has(rel)) changes.push({ rel, before: rev });
  }
  return changes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

async function readInventory(projectId: string): Promise<string[]> {
  let listing: ProjectAssetStamps | undefined;
  try {
    listing = await invoke<ProjectAssetStamps>("list_project_asset_stamps", {
      slug: nativeSlug(projectId),
    });
  } catch {
    listing = undefined;
  }
  if (!listing || !Array.isArray(listing.assets)) {
    inventories.delete(projectId);
    return [];
  }
  const revs = new Map(
    listing.assets.map((a) => [cleanRel(a.rel), `${a.size}-${a.mtimeNs}`] as const),
  );
  const previous = inventories.get(projectId);
  inventories.set(projectId, { stamp: listing.stamp, revs });
  const changes = changedRels(previous?.revs, revs);
  notify(projectId, changes);
  return previous ? changes.map((c) => c.rel) : [];
}

/** Re-read a workspace project's asset stamps (no-op for bundled ids). Returns the rels whose revision moved since the last listing (none on the first). A failed listing drops the inventory, which fails open: no missing-file check, bare URLs. */
export function refreshWorkspaceAssets(projectId: string): Promise<string[]> {
  if (!WORKSPACE_BACKED.test(projectId)) return Promise.resolve([]);
  const pending = inflight.get(projectId);
  // A refresh already running may have read the disk before the caller's write: chain one more.
  const next = (pending ?? Promise.resolve([] as string[]))
    .catch(() => [] as string[])
    .then(() => readInventory(projectId))
    .finally(() => {
      if (inflight.get(projectId) === next) inflight.delete(projectId);
    });
  inflight.set(projectId, next);
  return next;
}

/** True only when the inventory is loaded AND the path is not one of its images. */
export function workspaceAssetMissing(projectId: string, relPath: string): boolean {
  const inventory = inventories.get(projectId);
  if (!inventory) return false;
  const rel = cleanRel(relPath);
  return !(IMAGE_REL.test(rel) && inventory.revs.has(rel));
}

/** The asset's revision (`<size>-<mtimeNs>` for workspace files), or undefined: no listing, not a loadable asset, or a bundled file HMR never touched. */
export function assetRevision(projectId: string, rel: string): string | undefined {
  const clean = cleanRel(rel);
  const stamped = inventories.get(projectId)?.revs.get(clean);
  if (stamped !== undefined) return stamped;
  const bumps = localBumps.get(revKey(projectId, clean));
  return bumps ? `v${bumps}` : undefined;
}

/** `url` with `r=<rev>` appended (`?` or `&`, so it composes with the poster renderer's `?poster=`); unchanged without a revision. */
export function withAssetRevision(url: string, rev?: string): string {
  if (!rev) return url;
  return `${url}${url.includes("?") ? "&" : "?"}r=${encodeURIComponent(rev)}`;
}

function bumpLocal(projectId: string, rel: string): void {
  const key = revKey(projectId, rel);
  const before = assetRevision(projectId, rel);
  localBumps.set(key, (localBumps.get(key) ?? 0) + 1);
  notify(projectId, [{ rel: cleanRel(rel), before }]);
}

/** An in-place writer (app icon, terminal bake, website capture) landed `rel`: re-read the stamps so every reader moves to the new URL. Without a listing, a local bump still forces one. */
export async function noteAssetWritten(projectId: string, rel: string): Promise<void> {
  await refreshWorkspaceAssets(projectId);
  if (!inventories.has(projectId)) bumpLocal(projectId, rel);
}

/** Dev HMR replaced a bundled project's asset: a local revision makes the next URL a new one. */
export function noteBundledAssetChanged(projectId: string, rel: string): void {
  bumpLocal(projectId, rel);
}

/** One poll tick of the editor's asset watch: true once a stamp that differs from the inventory's has read the same on two ticks (the source poll's settle rule). False until the project's first listing lands. */
export function observeAssetStamp(projectId: string, stamp: string): boolean {
  const known = inventories.get(projectId)?.stamp;
  if (known === undefined || stamp === known) {
    pendingStamps.delete(projectId);
    return false;
  }
  if (pendingStamps.get(projectId) !== stamp) {
    pendingStamps.set(projectId, stamp);
    return false;
  }
  pendingStamps.delete(projectId);
  return true;
}

/** The aggregate asset stamp the poll and the render window compare (null when unreadable). */
export function projectAssetsStamp(projectId: string): Promise<string | null> {
  if (!WORKSPACE_BACKED.test(projectId)) return Promise.resolve(null);
  return invoke<string>("project_assets_stamp", { slug: nativeSlug(projectId) }).catch(() => null);
}

/** The stamp of the listing the inventory holds, if any. */
export function inventoryStamp(projectId: string): string | null {
  return inventories.get(projectId)?.stamp ?? null;
}

/** Listen for revision changes app-wide (project.ts drops drei's cached textures for replaced URLs). */
export function subscribeAssetChanges(listener: AssetChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Listen for one asset's revision changing. */
export function subscribeAssetRevision(
  projectId: string,
  rel: string,
  listener: () => void,
): () => void {
  const key = revKey(projectId, rel);
  const set = listeners.get(key) ?? new Set<() => void>();
  listeners.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** A window that never loaded the project (the video editor) lists it on first use; never mid-export. */
function useInventoryLoaded(projectId: string | null | undefined): void {
  useEffect(() => {
    if (!projectId || !WORKSPACE_BACKED.test(projectId) || isExporting()) return;
    if (!inventories.has(projectId) && !inflight.has(projectId)) {
      void refreshWorkspaceAssets(projectId);
    }
  }, [projectId]);
}

const noop = () => {};

/** One asset's revision, re-rendering when it moves. */
export function useAssetRevision(
  projectId: string | null | undefined,
  rel: string | null | undefined,
): string | undefined {
  useInventoryLoaded(projectId);
  const subscribe = useCallback(
    (listener: () => void) =>
      projectId && rel ? subscribeAssetRevision(projectId, rel, listener) : noop,
    [projectId, rel],
  );
  const snapshot = () => (projectId && rel ? assetRevision(projectId, rel) : undefined);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Several assets' revisions as one string (a memo dependency), re-rendering when any moves. */
export function useAssetRevisions(
  projectId: string | null | undefined,
  rels: readonly string[],
): string {
  useInventoryLoaded(projectId);
  const joined = rels.join("\n");
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!projectId || !joined) return noop;
      const offs = joined
        .split("\n")
        .map((rel) => subscribeAssetRevision(projectId, rel, listener));
      return () => {
        for (const off of offs) off();
      };
    },
    [projectId, joined],
  );
  const snapshot = () =>
    projectId ? rels.map((rel) => assetRevision(projectId, rel) ?? "").join("|") : "";
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Per rel, the revision once it has moved past the first one this component saw (else undefined), for media elements mounted before a window's first listing lands: that listing must not reload them, a later replace must. */
export function useReplacedRevisions(
  projectId: string | null | undefined,
  rels: readonly string[],
): (string | undefined)[] {
  const current = useAssetRevisions(projectId, rels).split("|");
  const firstSeen = useRef(new Map<string, string>());
  return rels.map((rel, i) => {
    const rev = current[i] || undefined;
    if (rev === undefined) return undefined;
    const first = firstSeen.current.get(rel);
    if (first === undefined) firstSeen.current.set(rel, rev);
    return first === undefined || first === rev ? undefined : rev;
  });
}

export function resetAssetRevisionsForTests(): void {
  inventories.clear();
  localBumps.clear();
  listeners.clear();
  pendingStamps.clear();
  inflight.clear();
}
