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
  /** The copy's sidecar display name, when it has one. */
  name?: string | null;
}

/** Copy a preset's scene into a workspace project at `position` (past the end appends). `presetProjectId` is the scoped id the catalogue carries (`preset:<slug>` bundled, `ws-preset:<slug>` the user's own); the native side resolves it like any project. */
export async function insertPresetScene(opts: {
  /** Destination workspace project slug (no `ws:` prefix). */
  destSlug: string;
  presetProjectId: string;
  /** Absent appends. */
  position?: number;
  /** The scene the caller saw at `position`; the insert is refused if another scene sits there now. */
  positionFile?: string;
  /** Renames the copy (the bridge's `insertPreset`). */
  name?: string;
  /** The hidden render window never asks: an unapproved user preset fails instead. */
  trustMode?: "stored-only";
}): Promise<InsertedPresetScene> {
  if (isWorkspaceBackedProjectId(opts.presetProjectId)) {
    await ensureProjectTrusted(
      nativeProjectSlug(opts.presetProjectId),
      parseProjectId(opts.presetProjectId).slug,
      opts.trustMode,
    );
  }
  const position = opts.position === undefined ? undefined : Math.max(0, Math.trunc(opts.position));
  return copySceneToProject(
    opts.presetProjectId,
    0,
    opts.destSlug,
    position,
    { positionFile: opts.positionFile },
    opts.name,
  );
}
