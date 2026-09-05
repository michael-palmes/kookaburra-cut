import { isWorkspaceBackedProjectId, nativeProjectSlug, parseProjectId } from "./project";
import { copySceneToProject } from "./projectEdit";
import { ensureProjectTrusted } from "./projectTrust";

/** Native insertion copies the scene and its assets at the requested position in one manifest write. */

export interface InsertedPresetScene {
  /** Manifest-relative path of the new scene (`scenes/07-stat-hero.tsx`). */
  file: string;
  docFile: string;
  sceneId: string;
  durationMs: number;
  /** Where the scene ended up, so the host can select it after its reload. */
  index: number;
}

/** Copy a preset's scene into a workspace project at `position` (past the end appends). `presetProjectId` is the scoped id the catalogue carries (`preset:<slug>` bundled, `ws-preset:<slug>` the user's own); the native side resolves it like any project. */
export async function insertPresetScene(opts: {
  /** Destination workspace project slug (no `ws:` prefix). */
  destSlug: string;
  presetProjectId: string;
  position: number;
}): Promise<InsertedPresetScene> {
  if (isWorkspaceBackedProjectId(opts.presetProjectId)) {
    await ensureProjectTrusted(
      nativeProjectSlug(opts.presetProjectId),
      parseProjectId(opts.presetProjectId).slug,
    );
  }
  const copied = await copySceneToProject(
    opts.presetProjectId,
    0,
    opts.destSlug,
    Math.max(0, Math.trunc(opts.position)),
  );
  return copied;
}
