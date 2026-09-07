import { readProjectManifestSnapshot, writeProjectManifestSnapshot } from "./edit/projectEdit";
import { type HistoryChange, pushHistory } from "./history";
import {
  isEditableProjectId,
  type LoadedProject,
  nativeProjectSlug,
  type ProjectManifest,
} from "./project";
import { writeSceneDoc } from "./sceneDoc";
import type { SceneDoc } from "./sceneDocSchema";

/** The host's in-memory doc patch. Always pass the `sceneFile` the write targeted and the project id it belongs to: the index alone cannot survive the await (see `resolveDocPatchIndex`), and a write landing after a project switch must never patch the project now open. */
export type DocChangedHandler = (
  sceneIndex: number,
  doc: SceneDoc,
  sceneFile?: string,
  projectId?: string,
) => void;

export function docPatchMatchesProject(
  currentProjectId: string,
  writtenProjectId?: string,
): boolean {
  return writtenProjectId === undefined || currentProjectId === writtenProjectId;
}

export interface SceneDocPatchQueue {
  identity: string;
  latestDoc: SceneDoc | undefined;
  pending: number;
  tail: Promise<void>;
}

const sceneDocPatchQueues = new Map<string, SceneDocPatchQueue>();

const IDENTITY_SEPARATOR = String.fromCharCode(0);

export function sceneDocPatchQueueIdentity(
  projectId: string,
  sceneFile: string | undefined,
  sceneIndex: number,
): string {
  return `${projectId}${IDENTITY_SEPARATOR}${sceneFile ?? sceneIndex}`;
}

export async function settleSceneDocPatches(): Promise<void> {
  let pending = [...sceneDocPatchQueues.values()].filter((queue) => queue.pending > 0);
  while (pending.length) {
    await Promise.all(pending.map((queue) => queue.tail));
    pending = [...sceneDocPatchQueues.values()].filter((queue) => queue.pending > 0);
  }
}

/** One queue per scene document. An idle queue adopts the caller's document (a reload or an undo replay hands it the newer one that way); while a patch is in flight the queue's own latest document is the truth every later patch rebases on. */
export function sceneDocPatchQueue(
  identity: string,
  doc: SceneDoc | undefined,
): SceneDocPatchQueue {
  const existing = sceneDocPatchQueues.get(identity);
  if (existing) {
    if (existing.pending === 0) existing.latestDoc = doc;
    return existing;
  }
  const created = { identity, latestDoc: doc, pending: 0, tail: Promise.resolve() };
  sceneDocPatchQueues.set(identity, created);
  return created;
}

export function enqueueSceneDocPatch<T>(
  queue: SceneDocPatchQueue,
  execute: () => Promise<T>,
): Promise<T> {
  queue.pending += 1;
  const result = queue.tail.then(execute, execute);
  const tracked = result.then(
    (value) => {
      queue.pending -= 1;
      return value;
    },
    (error) => {
      queue.pending -= 1;
      throw error;
    },
  );
  queue.tail = tracked.then(
    () => undefined,
    () => undefined,
  );
  return tracked;
}

export interface SceneDocCommit {
  project: LoadedProject;
  sceneIndex: number;
  /** The undo label; `false` records nothing, for a caller that batches the returned change into its own entry. */
  label: string | false;
  onDocChanged: DocChangedHandler;
  /** The document a gesture started from, recorded as the undo `before`; the queue's latest document otherwise. */
  baseline?: SceneDoc | null;
}

export interface SceneDocCommitResult {
  doc: SceneDoc;
  change: HistoryChange;
}

/** Mutates a clone of the latest document in place (a doc-less scene starts from `{ version: 1 }`), or returns a replacement document; returning `false` aborts the write. */
export type SceneDocPatch = (next: SceneDoc) => unknown;

function isSceneDoc(value: unknown): value is SceneDoc {
  return typeof value === "object" && value !== null && "version" in value;
}

/** The queued sidecar write every direct writer shares: the patch applies to the LATEST document, so two writers on one scene keep both edits; the write lands, the host patches by file and project id, and one history entry records it. Resolves null when the scene cannot be written or the patch aborted; rejects on a failed write so each caller keeps its own error surface. */
export function commitSceneDocPatch(
  commit: SceneDocCommit,
  patch: SceneDocPatch,
): Promise<SceneDocCommitResult | null> {
  const { project, sceneIndex, onDocChanged } = commit;
  const slug = isEditableProjectId(project.id) ? nativeProjectSlug(project.id) : null;
  const sceneFile = project.sceneFiles[sceneIndex];
  if (!slug || !sceneFile) return Promise.resolve(null);
  const queue = sceneDocPatchQueue(
    sceneDocPatchQueueIdentity(project.id, sceneFile, sceneIndex),
    project.sceneDocs[sceneIndex],
  );
  return enqueueSceneDocPatch(queue, async () => {
    const current = queue.latestDoc;
    const draft: SceneDoc = structuredClone(current ?? { version: 1 });
    const result = patch(draft);
    if (result === false) return null;
    const next = isSceneDoc(result) ? result : draft;
    await writeSceneDoc(slug, sceneFile, next);
    queue.latestDoc = next;
    onDocChanged(sceneIndex, next, sceneFile, project.id);
    const before = commit.baseline === undefined ? current : commit.baseline;
    const change: HistoryChange = {
      kind: "sceneDoc",
      slug,
      file: sceneFile,
      sceneIndex,
      before: before ? structuredClone(before) : null,
      after: structuredClone(next),
    };
    if (before?.themeId !== next.themeId) change.reload = true;
    if (commit.label !== false) pushHistory({ label: commit.label, changes: [change] });
    return { doc: next, change };
  });
}

/** Stamps one scene's background + backdrop overrides onto every OTHER scene (raw fields, so "follow theme" copies as absence and named gradients still resolve per-scene) AND onto the manifest as `appliedBackground`, so new scenes scaffold with the same look: one compound undo entry covering both, doc-less targets get a minimal doc, and a single bad scene loses only itself. Returns counts so the caller can surface partial failures. */
export async function applyBackgroundToAllScenes(
  project: LoadedProject,
  sourceIndex: number,
  onDocChanged: DocChangedHandler,
): Promise<{ applied: number; failed: number }> {
  if (!isEditableProjectId(project.id)) return { applied: 0, failed: 0 };
  const slug = nativeProjectSlug(project.id);
  const source = project.sceneDocs[sourceIndex];
  const changes: HistoryChange[] = [];
  let applied = 0;
  let failed = 0;
  for (let i = 0; i < project.sceneFiles.length; i++) {
    if (i === sourceIndex) continue;
    if (!project.sceneFiles[i]) continue;
    try {
      const result = await commitSceneDocPatch(
        { project, sceneIndex: i, label: false, onDocChanged },
        (next) => {
          next.background = source?.background ? structuredClone(source.background) : undefined;
          next.backdrop = source?.backdrop ? structuredClone(source.backdrop) : undefined;
        },
      );
      if (!result) continue;
      applied++;
      changes.push(result.change);
    } catch (e) {
      failed++;
      console.warn(`[sceneDoc] apply-background-to-all failed for scene ${i}:`, e);
    }
  }
  try {
    const before = await readProjectManifestSnapshot(slug);
    const manifest = JSON.parse(before) as ProjectManifest;
    const stamp: NonNullable<ProjectManifest["appliedBackground"]> = {};
    if (source?.background) stamp.background = structuredClone(source.background);
    if (source?.backdrop) stamp.backdrop = structuredClone(source.backdrop);
    const stamped = stamp.background !== undefined || stamp.backdrop !== undefined;
    // Applying a theme-default scene CLEARS the stamp, so new scenes go back to following the theme.
    if (stamped || manifest.appliedBackground !== undefined) {
      if (stamped) manifest.appliedBackground = stamp;
      else delete manifest.appliedBackground;
      await writeProjectManifestSnapshot(slug, JSON.stringify(manifest, null, 2));
      changes.push({
        kind: "manifest",
        slug,
        before,
        after: await readProjectManifestSnapshot(slug),
        reload: false,
      });
    }
  } catch (e) {
    console.warn("[sceneDoc] apply-background-to-all: manifest stamp failed:", e);
  }
  if (changes.length > 0) {
    pushHistory({ label: "apply background to all scenes", changes });
  }
  return { applied, failed };
}
