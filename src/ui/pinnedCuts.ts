import type { ProjectMusic } from "../engine/musicTime";
import { type LoadedProject, nativeProjectSlug, outgoingSceneTransitions } from "../engine/project";
import { readProjectManifestSnapshot, writeProjectManifestSnapshot } from "../engine/projectEdit";
import { type CutEntry, keepCutsForTransition, resolveSceneCuts } from "../engine/sceneCuts";
import { contentHash } from "../engine/sceneDocBase";
import type { TransitionSpec } from "../engine/sceneTimeline";

interface RawManifest {
  version?: number;
  scenes: CutEntry[];
}

function stale(project: LoadedProject, manifest: RawManifest): boolean {
  return (
    !Array.isArray(manifest.scenes) ||
    manifest.scenes.length !== project.sceneFiles.length ||
    manifest.scenes.some((entry, i) => entry.file !== project.sceneFiles[i])
  );
}

/** A load that re-resolved pinned lengths writes them back to project.json, so disk keeps in step (no history: nothing was edited). */
export async function writeCutCaches(
  project: LoadedProject,
  indices: readonly number[],
): Promise<void> {
  try {
    const slug = nativeProjectSlug(project.id);
    const text = await readProjectManifestSnapshot(slug);
    const manifest = JSON.parse(text) as RawManifest;
    if (stale(project, manifest)) return;
    let changed = false;
    for (const i of indices) {
      const entry = manifest.scenes[i];
      const length = project.slots[i]?.durationMs;
      if (typeof entry?.cutAt !== "string" || length === undefined || entry.durationMs === length) {
        continue;
      }
      entry.durationMs = length;
      changed = true;
    }
    if (changed) {
      await writeProjectManifestSnapshot(
        slug,
        JSON.stringify(manifest, null, 2),
        await contentHash(text),
      );
    }
  } catch (e) {
    console.warn("[cuts] pinned scene lengths didn't save:", e);
  }
}

/** Re-resolves every pinned length under `music` (a grid edit) and writes the moved ones in one manifest write, so the edit's history snapshot already holds them. */
export async function writeCutsForMusic(
  project: LoadedProject,
  music: ProjectMusic | undefined,
): Promise<void> {
  const slug = nativeProjectSlug(project.id);
  const text = await readProjectManifestSnapshot(slug);
  const manifest = JSON.parse(text) as RawManifest;
  if (stale(project, manifest)) return;
  const outgoing = outgoingSceneTransitions(manifest as never);
  const cuts = resolveSceneCuts(
    manifest.scenes.map((entry, i) => ({
      durationMs:
        typeof entry.durationMs === "number" ? entry.durationMs : project.scenes[i].durationMs,
      transition: outgoing[i],
      cutAt: entry.cutAt,
      align: entry.align,
    })),
    music,
  );
  if (cuts.changed.length === 0) return;
  for (const i of cuts.changed) manifest.scenes[i].durationMs = cuts.durations[i];
  await writeProjectManifestSnapshot(
    slug,
    JSON.stringify(manifest, null, 2),
    await contentHash(text),
  );
}

/** The transition picker's beat-keeping write: boundary `index` takes `spec` (null = hard cut) and every later cut stays where it is (`keepCutsForTransition`), in one manifest write. */
export async function writeTransitionKeepingCuts(
  project: LoadedProject,
  index: number,
  spec: TransitionSpec | null,
): Promise<void> {
  const slug = nativeProjectSlug(project.id);
  const text = await readProjectManifestSnapshot(slug);
  const manifest = JSON.parse(text) as RawManifest;
  if (stale(project, manifest)) {
    throw new Error("project.json changed outside the app; reopen the project and try again");
  }
  if ((manifest.version ?? 1) < 2) {
    const outgoing = outgoingSceneTransitions(manifest as never);
    manifest.scenes.forEach((entry, i) => {
      if (outgoing[i]) entry.transition = outgoing[i];
      else delete entry.transition;
    });
    manifest.version = 2;
  }
  const durations = manifest.scenes.map((entry, i) =>
    typeof entry.durationMs === "number" ? entry.durationMs : project.scenes[i].durationMs,
  );
  manifest.scenes = keepCutsForTransition(
    manifest.scenes,
    durations,
    index,
    spec,
    project.music,
  ).entries;
  await writeProjectManifestSnapshot(
    slug,
    JSON.stringify(manifest, null, 2),
    await contentHash(text),
  );
}
