/** Native project.json edit surface for workspace projects: thin typed wrappers over the Rust patch commands, every write atomic (tmp+rename) on the native side. Callers apply the result through `onTimingChanged` (the nonce-only stale-while-revalidate reload): a transition changes overlaps/totalMs, so it's a TIMING edit, never `handleDocChanged` and never the module-reload token. */

import { invoke } from "@tauri-apps/api/core";
import type { TransitionSpec } from "./sceneTimeline";

/** Set or remove the OUTGOING transition of `project.slots[index]` (ws projects only, manifest v2). `null` removes the key, a hard cut which also returns the overlap to the timeline (the project gets LONGER). The last scene is rejected natively (nothing to exit into). */
export async function updateSceneTransition(
  slug: string,
  index: number,
  spec: TransitionSpec | null,
): Promise<void> {
  await invoke("update_project_scene_transition", { slug, index, transition: spec });
}

/** Atomically apply one transition to every boundary and save it as this project's new-boundary default. */
export async function applyTransitionToAll(
  slug: string,
  spec: TransitionSpec | null,
): Promise<void> {
  await invoke("apply_project_transition_to_all", { slug, transition: spec });
}

/** Remove a scene (manifest entry; the TSX + sidecar ride to the Trash). */
export function removeProjectScene(slug: string, index: number): Promise<void> {
  return invoke("remove_project_scene", { slug, index });
}

/** Move a scene within the project (its incoming transition travels with it). */
export function moveProjectScene(slug: string, from: number, to: number): Promise<void> {
  return invoke("move_project_scene", { slug, from, to });
}

/** Duplicate a scene (TSX + sidecar copy to a freshly numbered stem, with a fresh unique `defineScene` id); the new entry lands at `position` (omitted = append). A new TSX file, so callers must bump the module reload token. */
export function duplicateProjectScene(
  slug: string,
  index: number,
  position?: number,
): Promise<{ file: string; docFile: string; sceneId: string; durationMs: number }> {
  return invoke("duplicate_scene", { slug, index, position: position ?? null });
}

/** Copy a scene into another workspace project: files, referenced assets and a fresh manifest entry land in the destination; the current project is untouched. */
export function copySceneToProject(
  slug: string,
  index: number,
  destSlug: string,
): Promise<{ file: string; docFile: string; sceneId: string; durationMs: number }> {
  return invoke("copy_scene_to_project", { slug, index, destSlug });
}

/** Another project's scenes for the copy-from picker: manifest order, sidecar display names with the file-stem fallback. */
export function listProjectScenes(
  slug: string,
): Promise<{ index: number; name: string; durationMs: number }[]> {
  return invoke("list_project_scenes", { slug });
}

/** The raw project.json text; the undo history's manifest snapshot. */
export function readProjectManifestSnapshot(slug: string): Promise<string> {
  return invoke("read_project_manifest_snapshot", { slug });
}

/** Restore a manifest snapshot; the undo/redo write surface only. */
export function writeProjectManifestSnapshot(slug: string, text: string): Promise<void> {
  return invoke("write_project_manifest_snapshot", { slug, text });
}
