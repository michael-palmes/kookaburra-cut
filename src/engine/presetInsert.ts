import { copySceneToProject, moveProjectScene } from "./projectEdit";

/** Inserting a scene preset is the cross-project copy machinery pointed at a preset folder: `copy_scene_to_project` already copies the TSX, the sidecar and just the assets they name, and mints ids unique in the DESTINATION, so nothing preset-specific travels. It always appends, so landing a scene mid-project is that copy plus one move; the placement maths lives here, pure, and the two invokes sit under it. */

/** The move that walks a freshly appended scene back to `position`, or null when it already landed there. `sceneCountBefore` is the manifest length BEFORE the copy, so the new scene sits at that index. */
export function presetInsertMove(
  sceneCountBefore: number,
  position: number,
): { from: number; to: number } | null {
  const from = Math.max(0, Math.trunc(sceneCountBefore));
  const to = Math.min(from, Math.max(0, Math.trunc(position)));
  return to === from ? null : { from, to };
}

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
  sceneCountBefore: number;
  /** Which of the preset's scenes to copy; presets are single-scene, so 0. */
  sceneIndex?: number;
}): Promise<InsertedPresetScene> {
  const copied = await copySceneToProject(
    opts.presetProjectId,
    opts.sceneIndex ?? 0,
    opts.destSlug,
  );
  const move = presetInsertMove(opts.sceneCountBefore, opts.position);
  if (move) await moveProjectScene(opts.destSlug, move.from, move.to);
  return { ...copied, index: move ? move.to : Math.max(0, Math.trunc(opts.sceneCountBefore)) };
}
