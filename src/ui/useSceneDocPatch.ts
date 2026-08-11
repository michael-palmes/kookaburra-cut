import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useClockStore } from "../engine/clock";
import { FPS } from "../engine/format";
import { type HistoryChange, pushHistory } from "../engine/history";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "../engine/project";
import { readProjectManifestSnapshot } from "../engine/projectEdit";
import type { RigDoc } from "../engine/sceneCameraEdit";
import {
  clampDocTracksToDuration,
  resyncFollowMediaDuration,
  writeSceneDoc,
} from "../engine/sceneDoc";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { rebakeRigBindings } from "../engine/sceneRigConvert";
import { resolveOverlapMs } from "../engine/sceneTimeline";

/** The host's in-memory doc patch. Always pass the `sceneFile` the write targeted: the index alone cannot survive the await (see `resolveDocPatchIndex`). */
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

/** Manifest module paths may carry a leading `./`; `sceneMountKey` normalises the same way. */
const normFile = (file: string) => file.replace(/^\.?\//, "");

interface SceneDocPatchQueue {
  identity: string;
  latestDoc: SceneDoc | undefined;
  pending: number;
  tail: Promise<void>;
}

const sceneDocPatchQueues = new Map<string, SceneDocPatchQueue>();

function sceneDocPatchQueue(identity: string, doc: SceneDoc | undefined): SceneDocPatchQueue {
  const existing = sceneDocPatchQueues.get(identity);
  if (existing) {
    if (existing.pending === 0) existing.latestDoc = doc;
    return existing;
  }
  const created = { identity, latestDoc: doc, pending: 0, tail: Promise.resolve() };
  sceneDocPatchQueues.set(identity, created);
  return created;
}

function enqueueSceneDocPatch<T>(queue: SceneDocPatchQueue, execute: () => Promise<T>): Promise<T> {
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
    () => {},
    () => {},
  );
  return tracked;
}

export function applySceneDocPatch(doc: SceneDoc, patch: (next: SceneDoc) => void): SceneDoc {
  const next = structuredClone(doc);
  patch(next);
  if (next.cameraRig) {
    next.cameraRig = rebakeRigBindings(next.cameraRig as RigDoc, next);
  }
  return next;
}

function applyAbortableSceneDocPatch(
  doc: SceneDoc,
  patch: (next: SceneDoc) => unknown,
): SceneDoc | null {
  const next = structuredClone(doc);
  if (patch(next) === false) return null;
  if (next.cameraRig) {
    next.cameraRig = rebakeRigBindings(next.cameraRig as RigDoc, next);
  }
  return next;
}

/** Which slot an awaited doc write must patch. A write is a real IPC round trip, so an insert or reorder that lands first shifts every later scene and the captured index now names someone else's scene: the FILE is the identity, exactly as it is for mount keys. Null drops the patch, the scene left the project mid-write. A caller with no file keeps the old bounds-checked behaviour. */
export function resolveDocPatchIndex(
  sceneFiles: readonly string[],
  sceneIndex: number,
  sceneFile?: string,
): number | null {
  if (sceneFile === undefined) {
    return sceneIndex >= 0 && sceneIndex < sceneFiles.length ? sceneIndex : null;
  }
  const wanted = normFile(sceneFile);
  const here = sceneFiles[sceneIndex];
  if (here !== undefined && normFile(here) === wanted) return sceneIndex;
  const moved = sceneFiles.findIndex((f) => normFile(f) === wanted);
  return moved >= 0 ? moved : null;
}

/** The one scene-document write funnel: `patchDoc` writes a patched copy of the doc, hands the exact written doc AND its file to the host for an in-memory patch (no reload, the no-flicker rule), and records one history entry (`history: false` for the text-motion panel's live writes, since its Done records the session); a themeId change flags `reload` because resolution bakes at load; `commitDuration` writes project.json, flips the sidecar to manual mode, and records one compound history entry, then the nonce-only timing refresh. */
export function useSceneDocPatch(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: DocChangedHandler,
  onTimingChanged: () => void,
) {
  const [error, setError] = useState<string | null>(null);
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const scene = project.slots[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const queueIdentity = `${project.id}\u0000${sceneFile ?? sceneIndex}`;
  const patchQueue = sceneDocPatchQueue(queueIdentity, doc);

  /** Write a patched copy of the doc, re-sync duration when asked, and report whether the complete operation succeeded. */
  async function patchDocResult(
    patch: (next: SceneDoc) => unknown,
    opts: { resync?: boolean; history?: string | false } = {},
  ): Promise<boolean> {
    if (!patchQueue.latestDoc || !sceneFile || !slug || (opts.resync && !scene)) return false;
    const execute = async (): Promise<boolean> => {
      const current = patchQueue.latestDoc;
      if (!current) return false;
      setError(null);
      try {
        const before = structuredClone(current);
        const next = applyAbortableSceneDocPatch(current, patch);
        if (!next) return false;
        // Object-bound camera aims refresh in the SAME write, so moving a device and the keys
        // following it are one undo. The engine only ever READS bindings; this is the editor's half.
        const changes: HistoryChange[] = [];
        let resyncFailed = false;
        await writeSceneDoc(slug, sceneFile, next);
        patchQueue.latestDoc = next;
        onDocChanged(sceneIndex, next, sceneFile, project.id);
        changes.push({
          kind: "sceneDoc",
          slug,
          file: sceneFile,
          sceneIndex,
          before,
          after: structuredClone(next),
          // themeId resolution bakes at load; replay must nonce-reload.
          reload: before.themeId !== next.themeId,
        });
        if (opts.resync) {
          const manifestBefore = await readProjectManifestSnapshot(slug);
          const { wrote, clampedDoc } = await resyncFollowMediaDuration(
            slug,
            sceneIndex,
            next,
            scene.durationMs,
            sceneFile,
          ).catch((e) => {
            console.warn("[scene-doc] duration re-sync failed:", e);
            setError(`Saved, but the scene length didn't re-sync: ${String(e)}`);
            resyncFailed = true;
            return { wrote: false, clampedDoc: null };
          });
          if (wrote) {
            onTimingChanged();
            changes.push({
              kind: "manifest",
              slug,
              before: manifestBefore,
              after: await readProjectManifestSnapshot(slug),
              reload: false,
            });
          }
          if (clampedDoc) {
            patchQueue.latestDoc = clampedDoc;
            onDocChanged(sceneIndex, clampedDoc, sceneFile, project.id);
            changes.push({
              kind: "sceneDoc",
              slug,
              file: sceneFile,
              sceneIndex,
              before: structuredClone(next),
              after: structuredClone(clampedDoc),
            });
          }
        }
        // history === false: the text-motion panel's live writes; its Done records one session entry, Cancel already restores and must not be undoable noise.
        if (opts.history !== false) {
          pushHistory({ label: opts.history ?? "scene edit", changes });
        }
        return !resyncFailed;
      } catch (e) {
        setError(String(e));
        return false;
      }
    };
    return enqueueSceneDocPatch(patchQueue, execute);
  }

  /** Preserve the existing fire-and-forget-compatible API for callers that do not need a result. */
  async function patchDoc(
    patch: (next: SceneDoc) => void,
    opts: { resync?: boolean; history?: string | false } = {},
  ): Promise<void> {
    await patchDocResult(patch, opts);
  }

  /** Commit a drag/gesture as ONE history entry: writes `patch` applied to `baseline` (the doc snapshotted at drag start) and records before=baseline, after. Live ticks during the drag go through `patchDoc(..., { history: false })`; this reconciles the final value and records the single undo step on release. */
  async function commitFromBaselineResult(
    baseline: SceneDoc,
    patch: (next: SceneDoc) => unknown,
  ): Promise<boolean> {
    if (!slug || !sceneFile) return false;
    const execute = async (): Promise<boolean> => {
      setError(null);
      try {
        const after = applyAbortableSceneDocPatch(baseline, patch);
        if (!after) return false;
        await writeSceneDoc(slug, sceneFile, after);
        patchQueue.latestDoc = after;
        onDocChanged(sceneIndex, after, sceneFile, project.id);
        pushHistory({
          label: "scene edit",
          changes: [
            {
              kind: "sceneDoc",
              slug,
              file: sceneFile,
              sceneIndex,
              before: baseline,
              after: structuredClone(after),
              reload: baseline.themeId !== after.themeId,
            },
          ],
        });
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      }
    };
    return enqueueSceneDocPatch(patchQueue, execute);
  }

  async function commitFromBaseline(
    baseline: SceneDoc,
    patch: (next: SceneDoc) => void,
  ): Promise<void> {
    await commitFromBaselineResult(baseline, patch);
  }

  async function commitDuration(ms: number) {
    setError(null);
    try {
      await commitSceneDuration(project, sceneIndex, ms, onDocChanged, onTimingChanged);
    } catch (e) {
      setError(String(e));
    }
  }

  return {
    slug,
    doc,
    scene,
    sceneFile,
    error,
    setError,
    patchDoc,
    patchDocResult,
    commitFromBaseline,
    commitFromBaselineResult,
    commitDuration,
  };
}

/** The hook-free scene-length writer (shared with the playback bar's right-click path): project.json write + the manual-mode flip + any shrink-fit of overhanging keyframe tracks as ONE compound history entry, then the nonce-only timing refresh; a shrink also lands the playhead just before the scene's new safe end. Throws so each caller surfaces errors its own way. */
async function commitSceneDurationNow(
  project: LoadedProject,
  sceneIndex: number,
  ms: number,
  onDocChanged: DocChangedHandler,
  onTimingChanged: () => void,
): Promise<SceneDoc | undefined> {
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  // Pre-write snapshot: the shrink maths read the old slots before any write lands.
  const slot = project.slots[sceneIndex];
  const nextSlot = project.slots[sceneIndex + 1];
  const shrinking = slot !== undefined && ms < slot.durationMs;
  const changes: HistoryChange[] = [];
  let writtenDoc: SceneDoc | undefined;
  const manifestBefore = slug ? await readProjectManifestSnapshot(slug) : null;
  await invoke("update_project_scene", { slug, index: sceneIndex, durationMs: ms });
  if (slug && manifestBefore !== null) {
    changes.push({
      kind: "manifest",
      slug,
      before: manifestBefore,
      after: await readProjectManifestSnapshot(slug),
      reload: false,
    });
  }
  // Typing an explicit length flips the scene to manual mode permanently (the locked duration decision); a shrink also clamps overhanging keyframe tracks in the SAME write; doc-less scenes just get the project.json write.
  if (doc && slug && sceneFile) {
    let next = structuredClone(doc);
    let dirty = false;
    if (doc.duration?.mode !== "manual") {
      next.duration = { mode: "manual" };
      dirty = true;
    }
    if (shrinking) {
      const clamped = clampDocTracksToDuration(next, ms);
      if (clamped) {
        next = clamped;
        dirty = true;
      }
    }
    if (dirty) {
      const before = structuredClone(doc);
      await writeSceneDoc(slug, sceneFile, next);
      writtenDoc = next;
      onDocChanged(sceneIndex, next, sceneFile, project.id);
      changes.push({
        kind: "sceneDoc",
        slug,
        file: sceneFile,
        sceneIndex,
        before,
        after: structuredClone(next),
      });
    }
  }
  pushHistory({ label: "scene length", changes });
  // A stranded playhead lands just before the new safe end: the outgoing overlap re-clamped against the new duration, or one frame short of the boundary (half-open intervals hand the exact boundary to the next scene). The scene's own start can move LATER on shrink too (its incoming overlap is bounded by its own duration), so both edges are re-derived from the pre-write neighbours.
  if (shrinking) {
    const clock = useClockStore.getState();
    const local = clock.currentMs - slot.startMs;
    const prevSlot = project.slots[sceneIndex - 1];
    const newStartMs = prevSlot
      ? prevSlot.endMs - resolveOverlapMs(slot.transitionIn, prevSlot.durationMs, ms)
      : 0;
    const overlap = resolveOverlapMs(nextSlot?.transitionIn, ms, nextSlot?.durationMs ?? 0);
    const safeLocal = Math.max(0, overlap > 0 ? ms - overlap : ms - Math.ceil(1000 / FPS));
    if (local >= 0 && local <= slot.durationMs && clock.currentMs > newStartMs + safeLocal) {
      clock.setCurrentMs(newStartMs + safeLocal);
    }
  }
  onTimingChanged();
  return writtenDoc;
}

export async function commitSceneDuration(
  project: LoadedProject,
  sceneIndex: number,
  ms: number,
  onDocChanged: DocChangedHandler,
  onTimingChanged: () => void,
): Promise<SceneDoc | undefined> {
  const sceneFile = project.sceneFiles[sceneIndex];
  const identity = `${project.id}\u0000${sceneFile ?? sceneIndex}`;
  const queue = sceneDocPatchQueue(identity, project.sceneDocs[sceneIndex]);
  return enqueueSceneDocPatch(queue, async () => {
    const queuedProject = queue.latestDoc
      ? {
          ...project,
          sceneDocs: project.sceneDocs.map((candidate, index) =>
            index === sceneIndex ? queue.latestDoc : candidate,
          ),
        }
      : project;
    const written = await commitSceneDurationNow(
      queuedProject,
      sceneIndex,
      ms,
      onDocChanged,
      onTimingChanged,
    );
    if (written) queue.latestDoc = written;
    return written;
  });
}
