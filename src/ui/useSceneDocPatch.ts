import { useState } from "react";
import { useClockStore } from "../engine/clock";
import { FPS } from "../engine/format";
import { type HistoryChange, pushHistory } from "../engine/history";
import { isEditableProjectId, type LoadedProject, nativeProjectSlug } from "../engine/project";
import { readProjectManifestSnapshot, updateSceneDuration } from "../engine/projectEdit";
import type { RigDoc } from "../engine/sceneCameraEdit";
import { clampDocTracksToDuration, resyncFollowMediaDuration } from "../engine/sceneDoc";
import { sceneDocBase } from "../engine/sceneDocBase";
import { resolveSceneDocMusic, sceneMusicScope } from "../engine/sceneDocMusic";
import {
  commitSceneDocPatch,
  type DocChangedHandler,
  enqueueSceneDocPatch,
  noteRebasedWrite,
  sceneDocPatchQueue,
  sceneDocPatchQueueIdentity,
} from "../engine/sceneDocPatchQueue";
import { writeSceneDocRebased } from "../engine/sceneDocRebase";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { resolveAimTarget } from "../engine/sceneRig";
import { rebakeRigBindings } from "../engine/sceneRigConvert";
import { resolveOverlapMs } from "../engine/sceneTimeline";
import type { DeviceFloorY } from "../toolkit/device/worldAnchor";
import type { FormatInfo } from "../toolkit/types";

export type { DocChangedHandler } from "../engine/sceneDocPatchQueue";
export { docPatchMatchesProject, settleSceneDocPatches } from "../engine/sceneDocPatchQueue";

/** Manifest module paths may carry a leading `./`; `sceneMountKey` normalises the same way. */
const normFile = (file: string) => file.replace(/^\.?\//, "");

export function applySceneDocPatch(
  doc: SceneDoc,
  patch: (next: SceneDoc) => void,
  format?: FormatInfo,
  floorY?: DeviceFloorY,
): SceneDoc {
  const next = structuredClone(doc);
  patch(next);
  preserveRemovedBindingPositions(doc, next, format, floorY);
  if (next.cameraRig) {
    next.cameraRig = rebakeRigBindings(next.cameraRig as RigDoc, next, format, floorY);
  }
  return next;
}

function applyAbortableSceneDocPatch(
  doc: SceneDoc,
  patch: (next: SceneDoc) => unknown,
  format?: FormatInfo,
  floorY?: DeviceFloorY,
): SceneDoc | null {
  const next = structuredClone(doc);
  if (patch(next) === false) return null;
  preserveRemovedBindingPositions(doc, next, format, floorY);
  if (next.cameraRig) {
    next.cameraRig = rebakeRigBindings(next.cameraRig as RigDoc, next, format, floorY);
  }
  return next;
}

function preserveRemovedBindingPositions(
  before: SceneDoc,
  next: SceneDoc,
  format?: FormatInfo,
  floorY?: DeviceFloorY,
): void {
  if (!before.cameraRig || !next.cameraRig) return;
  const beforeById = new Map(before.cameraRig.keys.map((key) => [key.id, key]));
  const converted = next.cameraRig.keys.some((key) => {
    const previous = beforeById.get(key.id);
    return previous?.pose.aim.mode === "object" && key.pose.aim.mode === "point";
  });
  if (!converted) return;

  const resolvedBefore = rebakeRigBindings(before.cameraRig as RigDoc, before, format, floorY);
  const resolvedById = new Map(resolvedBefore.keys.map((key) => [key.id, key]));
  next.cameraRig = {
    ...next.cameraRig,
    keys: next.cameraRig.keys.map((key) => {
      const previous = beforeById.get(key.id);
      const resolved = resolvedById.get(key.id);
      if (
        previous?.pose.aim.mode !== "object" ||
        key.pose.aim.mode !== "point" ||
        resolveAimTarget(previous.pose.aim.id, next, format, floorY) !== null ||
        resolved?.pose.aim.mode !== "object"
      ) {
        return key;
      }
      return {
        ...key,
        pose: { ...key.pose, aim: { mode: "point" as const, at: [...resolved.pose.aim.at] } },
      };
    }),
  };
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
  format?: FormatInfo,
  floorY?: DeviceFloorY,
) {
  const [error, setError] = useState<string | null>(null);
  const slug = isEditableProjectId(project.id) ? nativeProjectSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const scene = project.slots[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const queueIdentity = sceneDocPatchQueueIdentity(project.id, sceneFile, sceneIndex);
  const patchQueue = sceneDocPatchQueue(queueIdentity, doc);
  const musicScope = sceneMusicScope(project, sceneIndex);

  /** Re-sync a follow-media scene's length after `next` landed; the manifest write and any clamped tracks join `changes`, the caller's one history entry. */
  async function resyncDuration(
    slug: string,
    sceneFile: string,
    next: SceneDoc,
    changes: HistoryChange[],
  ): Promise<boolean> {
    const manifestBefore = await readProjectManifestSnapshot(slug);
    let failed = false;
    const { wrote, clampedDoc } = await resyncFollowMediaDuration(
      slug,
      sceneIndex,
      next,
      scene.durationMs,
      sceneFile,
    ).catch((e) => {
      console.warn("[scene-doc] duration re-sync failed:", e);
      setError(`Saved, but the scene length didn't re-sync: ${String(e)}`);
      failed = true;
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
        hash: sceneDocBase(clampedDoc),
      });
    }
    return !failed;
  }

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
        // Object-bound camera aims refresh in the SAME write, so moving a device and the keys
        // following it are one undo. The engine only ever READS bindings; this is the editor's half.
        const written = await writeSceneDocRebased(
          slug,
          sceneFile,
          current,
          (from) => (from ? applyAbortableSceneDocPatch(from, patch, format, floorY) : null),
          musicScope,
        );
        if (!written) return false;
        const next = written.doc;
        const before = structuredClone(
          (written.rebased ? written.from : (patchQueue.outsideBase ?? current)) ?? current,
        );
        const changes: HistoryChange[] = [];
        let resyncFailed = false;
        patchQueue.latestDoc = next;
        if (opts.history === false) noteRebasedWrite(patchQueue, written);
        else patchQueue.outsideBase = null;
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
          hash: sceneDocBase(next),
        });
        if (opts.resync) resyncFailed = !(await resyncDuration(slug, sceneFile, next, changes));
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

  /** Commit a drag/gesture as ONE history entry: writes `patch` applied to `baseline` (the doc snapshotted at drag start) and records before=baseline, after. Live ticks during the drag go through `patchDoc(..., { history: false })`; this reconciles the final value and records the single undo step on release, with the follow-media re-sync in it when `resync` asks. */
  async function commitFromBaselineResult(
    baseline: SceneDoc,
    patch: (next: SceneDoc) => unknown,
    opts: { resync?: boolean } = {},
  ): Promise<boolean> {
    if (!slug || !sceneFile || (opts.resync && !scene)) return false;
    const execute = async (): Promise<boolean> => {
      setError(null);
      try {
        const latest = patchQueue.latestDoc;
        // After an outside change the baseline predates it: build on the latest document instead.
        const outside = patchQueue.outsideBase;
        const written = await writeSceneDocRebased(
          slug,
          sceneFile,
          latest,
          (from) => {
            const start = from === latest && !outside ? baseline : from;
            return start ? applyAbortableSceneDocPatch(start, patch, format, floorY) : null;
          },
          musicScope,
        );
        if (!written) return false;
        const after = written.doc;
        const before = written.rebased ? written.from : (outside ?? baseline);
        patchQueue.latestDoc = after;
        patchQueue.outsideBase = null;
        onDocChanged(sceneIndex, after, sceneFile, project.id);
        const changes: HistoryChange[] = [
          {
            kind: "sceneDoc",
            slug,
            file: sceneFile,
            sceneIndex,
            before: before ? structuredClone(before) : null,
            after: structuredClone(after),
            reload: before?.themeId !== after.themeId,
            hash: sceneDocBase(after),
          },
        ];
        const synced = !opts.resync || (await resyncDuration(slug, sceneFile, after, changes));
        pushHistory({ label: "scene edit", changes });
        return synced;
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
    opts: { resync?: boolean } = {},
  ): Promise<void> {
    await commitFromBaselineResult(baseline, patch, opts);
  }

  /** Finalise a live edit against the queued latest document while recording the drag-start document as the single undo baseline. */
  async function commitRebasedFromBaselineResult(
    baseline: SceneDoc,
    patch: (next: SceneDoc) => unknown,
    history = "scene edit",
  ): Promise<boolean> {
    if (!slug || !sceneFile) return false;
    const execute = async (): Promise<boolean> => {
      const current = patchQueue.latestDoc;
      if (!current) return false;
      setError(null);
      try {
        const written = await writeSceneDocRebased(
          slug,
          sceneFile,
          current,
          (from) => (from ? applyAbortableSceneDocPatch(from, patch, format, floorY) : null),
          musicScope,
        );
        if (!written) return false;
        const after = written.doc;
        const before = written.rebased ? written.from : (patchQueue.outsideBase ?? baseline);
        patchQueue.latestDoc = after;
        patchQueue.outsideBase = null;
        onDocChanged(sceneIndex, after, sceneFile, project.id);
        pushHistory({
          label: history,
          changes: [
            {
              kind: "sceneDoc",
              slug,
              file: sceneFile,
              sceneIndex,
              before: before ? structuredClone(before) : null,
              after: structuredClone(after),
              reload: before?.themeId !== after.themeId,
              hash: sceneDocBase(after),
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
    commitRebasedFromBaselineResult,
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
  const slug = isEditableProjectId(project.id) ? nativeProjectSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  // Pre-write snapshot: the shrink maths read the old slots before any write lands.
  const slot = project.slots[sceneIndex];
  const nextSlot = project.slots[sceneIndex + 1];
  const shrinking = slot !== undefined && ms < slot.durationMs;
  const changes: HistoryChange[] = [];
  let writtenDoc: SceneDoc | undefined;
  const manifestBefore = slug ? await readProjectManifestSnapshot(slug) : null;
  if (slug) await updateSceneDuration(slug, sceneIndex, ms, sceneFile);
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
    const written = await writeSceneDocRebased(
      slug,
      sceneFile,
      doc,
      (from) => {
        if (!from) return null;
        let next = structuredClone(from);
        let dirty = false;
        if (from.duration?.mode !== "manual") {
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
        return dirty ? next : null;
      },
      sceneMusicScope(project, sceneIndex),
    );
    if (written) {
      const next = written.doc;
      writtenDoc = next;
      onDocChanged(sceneIndex, next, sceneFile, project.id);
      changes.push({
        kind: "sceneDoc",
        slug,
        file: sceneFile,
        sceneIndex,
        before: written.from ? structuredClone(written.from) : null,
        after: structuredClone(next),
        hash: sceneDocBase(next),
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
  const queue = sceneDocPatchQueue(
    sceneDocPatchQueueIdentity(project.id, sceneFile, sceneIndex),
    project.sceneDocs[sceneIndex],
  );
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

/** The context-change path's disk half: rewrites each listed scene's `tMs` caches under `project.music` and its slots (resolve only, never detach) through the queued write, so disk keeps in step with memory. Returns the sidecar changes for the caller's history entry; a scene that fails is skipped with a warning. */
export async function writeMusicCaches(
  project: LoadedProject,
  indices: readonly number[],
  onDocChanged: DocChangedHandler,
): Promise<HistoryChange[]> {
  const changes: HistoryChange[] = [];
  for (const sceneIndex of indices) {
    const { music, sceneStartMs } = sceneMusicScope(project, sceneIndex);
    try {
      const result = await commitSceneDocPatch(
        { project, sceneIndex, label: false, onDocChanged },
        (draft) => resolveSceneDocMusic(draft, music, sceneStartMs).doc,
      );
      if (result) changes.push(result.change);
    } catch (e) {
      console.warn(`[music] scene ${sceneIndex + 1}'s musical key times didn't save:`, e);
    }
  }
  return changes;
}
