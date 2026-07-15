import { invoke } from "@tauri-apps/api/core";
import { isWorkspaceProjectId, type LoadedProject, sceneFileStem, workspaceSlug } from "./project";
import { captureFrameAt, withBorrowedClock } from "./snapshots";
import { projectFingerprint } from "./workspace";

/** Scene-picker thumbnails: one centre-frame PNG per scene, captured lazily off the live preview canvas when a picker opens (never during export/autorun, the clock borrow guards it) and cached natively under the workspace state dir (`.kookaburra/scene-thumbs/<slug>/<stem>.png`). The set is stamped with the `project_fingerprint` it was captured under, so any scenes/project.json change invalidates every thumb at once; coarse, but per-scene staleness isn't knowable from a project-wide fingerprint anyway. */

const THUMB_WIDTH = 320;

interface SceneThumbsListing {
  stamp: string | null;
  thumbs: Record<string, string>;
}

/** Read-only thumb lookup: whatever the cache holds right now, fresh or stale, with no capture and no borrowed-clock scrubbing, since the transition picker must never seek the stage on open and staleness is fine for a preview backdrop. Missing thumbs simply aren't in the record; callers fall back to sample slides. */
export async function listCachedSceneThumbs(
  project: LoadedProject,
): Promise<Record<string, string>> {
  if (!isWorkspaceProjectId(project.id)) return {};
  try {
    const listing = await invoke<SceneThumbsListing>("list_scene_thumbs", {
      slug: workspaceSlug(project.id),
    });
    return listing.thumbs;
  } catch {
    return {};
  }
}

/** Absolute thumb paths by scene file stem, capturing any missing/stale set first; returns what it has on partial failure, since a card with a placeholder beats a blocked picker. Non-workspace projects get `{}` (pickers only exist for workspace projects). */
export async function ensureSceneThumbs(project: LoadedProject): Promise<Record<string, string>> {
  if (!isWorkspaceProjectId(project.id)) return {};
  const slug = workspaceSlug(project.id);
  const stems = project.sceneFiles.map(sceneFileStem);
  try {
    const [fingerprint, listing] = await Promise.all([
      projectFingerprint(slug),
      invoke<SceneThumbsListing>("list_scene_thumbs", { slug }),
    ]);
    const fresh = listing.stamp === fingerprint && stems.every((s) => listing.thumbs[s]);
    if (fresh) return listing.thumbs;

    await withBorrowedClock(async () => {
      for (let i = 0; i < project.slots.length; i++) {
        const slot = project.slots[i];
        const stem = stems[i];
        if (!stem) continue;
        const bytes = await captureFrameAt(
          Math.round(slot.startMs + slot.durationMs / 2),
          THUMB_WIDTH,
        );
        if (!bytes) continue;
        await invoke("write_scene_thumb", bytes, {
          headers: {
            "x-kookaburra-slug": slug,
            "x-kookaburra-stem": stem,
            "x-kookaburra-stamp": fingerprint,
          },
        });
      }
    });
    return (await invoke<SceneThumbsListing>("list_scene_thumbs", { slug })).thumbs;
  } catch (e) {
    console.warn("[sceneThumbs] capture failed:", e);
    return {};
  }
}
