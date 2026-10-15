/** Native project.json edit surface for workspace projects: thin typed wrappers over the Rust patch commands, every write atomic (tmp+rename) on the native side. Callers apply the result through `onTimingChanged` (the nonce-only stale-while-revalidate reload): a transition changes overlaps/totalMs, so it's a TIMING edit, never `handleDocChanged` and never the module-reload token. Index-based edits also name the scene file the caller saw there, so an outside insert or reorder is refused (and reloaded) rather than editing the wrong scene. */

import { invoke } from "@tauri-apps/api/core";
import { asWriteConflict, type FileWrite, reportOutsideChange } from "./sceneDocBase";
import type { TransitionSpec } from "./sceneTimeline";
import { noteSourceWrite } from "./sourceBaseline";

const MANIFEST = "project.json";

/** One manifest command: a refusal reports the outside change (the editor reloads) and throws a readable `WriteConflictError`; a landed single-file write moves the reload poll's baseline. */
async function manifestCommand<T>(
  command: string,
  args: { slug: string } & Record<string, unknown>,
  writtenSlug = args.slug,
): Promise<T> {
  try {
    const result = await invoke<T>(command, args);
    if (isFileWrite(result)) noteSourceWrite(writtenSlug, result);
    return result;
  } catch (e) {
    const conflict = asWriteConflict(e);
    if (!conflict) throw e;
    for (const slug of new Set([args.slug, writtenSlug])) {
      reportOutsideChange({ slug, files: [MANIFEST], action: "dropped" });
    }
    throw conflict;
  }
}

function isFileWrite(value: unknown): value is FileWrite {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FileWrite).hash === "string" &&
    typeof (value as FileWrite).stamp === "string"
  );
}

/** Set or remove the OUTGOING transition of `project.slots[index]` (ws projects only, manifest v2). `null` removes the key, a hard cut which also returns the overlap to the timeline (the project gets LONGER). The last scene is rejected natively (nothing to exit into). */
export async function updateSceneTransition(
  slug: string,
  index: number,
  spec: TransitionSpec | null,
  file: string | undefined,
): Promise<void> {
  await manifestCommand("update_project_scene_transition", {
    slug,
    index,
    transition: spec,
    file: file ?? null,
  });
}

/** Atomically apply one transition to every boundary and save it as this project's new-boundary default. */
export async function applyTransitionToAll(
  slug: string,
  spec: TransitionSpec | null,
): Promise<void> {
  await manifestCommand("apply_project_transition_to_all", { slug, transition: spec });
}

/** Set one scene's `durationMs` in project.json. */
export async function updateSceneDuration(
  slug: string,
  index: number,
  durationMs: number,
  file: string | undefined,
): Promise<void> {
  await manifestCommand("update_project_scene", {
    slug,
    index,
    durationMs,
    file: file ?? null,
  });
}

/** Remove a scene (manifest entry; the TSX + sidecar ride to the Trash). */
export async function removeProjectScene(
  slug: string,
  index: number,
  file: string | undefined,
): Promise<void> {
  await manifestCommand("remove_project_scene", { slug, index, file: file ?? null });
}

/** Move a scene within the project (its outgoing transition travels with it). */
export async function moveProjectScene(
  slug: string,
  from: number,
  to: number,
  file: string | undefined,
): Promise<void> {
  await manifestCommand("move_project_scene", { slug, from, to, file: file ?? null });
}

/** The scenes an inserting command expects: `file` at the source index, `positionFile` at the landing position. */
export interface InsertGuard {
  file?: string;
  positionFile?: string;
}

/** Duplicate a scene (TSX + sidecar copy to a freshly numbered stem, with a fresh unique `defineScene` id); the new entry lands at `position` (omitted = append). A new TSX file, so callers must bump the module reload token. */
export function duplicateProjectScene(
  slug: string,
  index: number,
  position: number | undefined,
  guard: InsertGuard,
): Promise<{ file: string; docFile: string; sceneId: string; durationMs: number }> {
  return manifestCommand("duplicate_scene", { slug, index, position: position ?? null, guard });
}

/** Copy a scene into another workspace project: files, referenced assets and a fresh manifest entry land in the destination; the current project is untouched. */
export function copySceneToProject(
  slug: string,
  index: number,
  destSlug: string,
  position?: number,
  guard: InsertGuard = {},
  name?: string,
): Promise<{
  file: string;
  docFile: string;
  sceneId: string;
  durationMs: number;
  index: number;
  name?: string | null;
}> {
  return manifestCommand(
    "copy_scene_to_project",
    {
      slug,
      index,
      destSlug,
      position: position ?? null,
      guard,
      name: name ?? null,
    },
    destSlug,
  );
}

/** Another project's scenes for the copy-from picker: manifest order, sidecar display names with the file-stem fallback. */
export function listProjectScenes(
  slug: string,
): Promise<{ index: number; file: string; name: string; durationMs: number }[]> {
  return invoke("list_project_scenes", { slug });
}

/** The raw project.json text; the undo history's manifest snapshot. */
export function readProjectManifestSnapshot(slug: string): Promise<string> {
  return invoke("read_project_manifest_snapshot", { slug });
}

/** Write a whole manifest snapshot (undo/redo and read-modify-write callers). `baseHash` is the hash of the text it was derived from (`contentHash`), so a snapshot never lands over a project.json that changed outside the app. */
export async function writeProjectManifestSnapshot(
  slug: string,
  text: string,
  baseHash: string | undefined,
): Promise<FileWrite | null> {
  return manifestCommand<FileWrite | null>("write_project_manifest_snapshot", {
    slug,
    text,
    baseHash: baseHash ?? null,
  });
}
