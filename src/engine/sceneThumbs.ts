import { invoke } from "@tauri-apps/api/core";
import {
  isEditableProjectId,
  type LoadedProject,
  nativeProjectSlug,
  sceneFileStem,
} from "./project";

/** Scene-picker thumbnails: one centre-frame PNG per scene, rendered by the hidden render window's fast tier (render/bridgeService.ts) and cached natively under the workspace state dir (`.kookaburra/scene-thumbs/<slug>/<stem>.png`). Each thumb carries its own source stamp (that scene's module plus sidecar), so adding or editing ONE scene recaptures ONE thumb; capture never borrows the editor's clock (the pre-window pipeline scrubbed the timeline under the user). Grids paint the cached set immediately and refresh on `kookaburra://thumbs-updated` as fresh thumbs land. */

interface SceneThumbsListing {
  stamp: string | null;
  thumbs: Record<string, string>;
  stamps: Record<string, string>;
  sourceStamps: Record<string, string>;
}

/** Read-only thumb lookup: whatever the cache holds right now, fresh or stale, with no capture, since the transition picker must never seek the stage on open and staleness is fine for a preview backdrop. Missing thumbs simply aren't in the record; callers fall back to sample slides. */
export async function listCachedSceneThumbs(
  project: LoadedProject,
): Promise<Record<string, string>> {
  if (!isEditableProjectId(project.id)) return {};
  try {
    const listing = await invoke<SceneThumbsListing>("list_scene_thumbs", {
      slug: nativeProjectSlug(project.id),
    });
    return listing.thumbs;
  } catch {
    return {};
  }
}

/** Cached thumb paths by scene file stem, submitting the missing/stale ones to the render window's queue (latest submission wins). Resolves immediately with what the cache holds; fresh thumbs announce themselves via `kookaburra://thumbs-updated`. An aborted `signal` cancels this submission's queue (the requesting dialog closed). Read-only projects get `{}` (the pickers only exist where scenes can be edited). */
export async function ensureSceneThumbs(
  project: LoadedProject,
  opts?: { signal?: AbortSignal },
): Promise<Record<string, string>> {
  if (!isEditableProjectId(project.id)) return {};
  const slug = nativeProjectSlug(project.id);
  const stems = project.sceneFiles.map(sceneFileStem);
  try {
    const listing = await invoke<SceneThumbsListing>("list_scene_thumbs", { slug });
    // A stem with no source stamp has no scene module on disk, so there is nothing to capture from.
    const jobs = stems
      .filter((stem) => {
        const source = listing.sourceStamps[stem];
        return !!source && (!listing.thumbs[stem] || listing.stamps[stem] !== source);
      })
      .map((stem) => ({ stem, stamp: listing.sourceStamps[stem] }));
    if (jobs.length === 0) return listing.thumbs;
    const generation = Date.now();
    await invoke("render_submit_thumbs", { batch: { slug, generation, jobs } });
    opts?.signal?.addEventListener("abort", () => {
      void invoke("render_cancel_thumbs", { generation }).catch(() => {});
    });
    return listing.thumbs;
  } catch (e) {
    console.warn("[sceneThumbs] submit failed:", e);
    return {};
  }
}
