import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { type HistoryChange, pushHistory } from "../engine/history";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "../engine/project";
import { readProjectManifestSnapshot } from "../engine/projectEdit";
import { resyncFollowMediaDuration, writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc } from "../engine/sceneDocSchema";

/** The one scene-document write funnel: `patchDoc` writes a patched copy of the doc, hands the exact written doc to the host for an in-memory patch (no reload, the no-flicker rule), and records one history entry (`history: false` for the text-motion panel's live writes, since its Done records the session); a themeId change flags `reload` because resolution bakes at load; `commitDuration` writes project.json, flips the sidecar to manual mode, and records one compound history entry, then the nonce-only timing refresh. */
export function useSceneDocPatch(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
  onTimingChanged: () => void,
) {
  const [error, setError] = useState<string | null>(null);
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const scene = project.slots[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];

  /** Write a patched copy of the doc, re-sync duration when asked, and hand the exact written doc to the host for an in-memory patch (no reload, the flicker fix). */
  async function patchDoc(
    patch: (next: SceneDoc) => void,
    opts: { resync?: boolean; history?: string | false } = {},
  ): Promise<void> {
    if (!doc || !sceneFile) return;
    setError(null);
    try {
      const before = structuredClone(doc);
      const next = structuredClone(doc);
      patch(next);
      if (!slug) return;
      const changes: HistoryChange[] = [];
      await writeSceneDoc(slug, sceneFile, next);
      onDocChanged(sceneIndex, next);
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
        const wrote = await resyncFollowMediaDuration(
          slug,
          sceneIndex,
          next,
          scene.durationMs,
        ).catch((e) => {
          console.warn("[scene-doc] duration re-sync failed:", e);
          setError(`Saved, but the scene length didn't re-sync: ${String(e)}`);
          return false;
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
      }
      // history === false: the text-motion panel's live writes; its Done records one session entry, Cancel already restores and must not be undoable noise.
      if (opts.history !== false) {
        pushHistory({ label: opts.history ?? "scene edit", changes });
      }
    } catch (e) {
      setError(String(e));
    }
  }

  /** Commit a drag/gesture as ONE history entry: writes `patch` applied to `baseline` (the doc snapshotted at drag start) and records before=baseline, after. Live ticks during the drag go through `patchDoc(..., { history: false })`; this reconciles the final value and records the single undo step on release. */
  async function commitFromBaseline(
    baseline: SceneDoc,
    patch: (next: SceneDoc) => void,
  ): Promise<void> {
    if (!slug || !sceneFile) return;
    setError(null);
    try {
      const after = structuredClone(baseline);
      patch(after);
      await writeSceneDoc(slug, sceneFile, after);
      onDocChanged(sceneIndex, after);
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
    } catch (e) {
      setError(String(e));
    }
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
    commitFromBaseline,
    commitDuration,
  };
}

/** The hook-free scene-length writer (shared with the playback bar's right-click path): project.json write + the manual-mode flip as one compound history entry, then the nonce-only timing refresh; throws so each caller surfaces errors its own way. */
export async function commitSceneDuration(
  project: LoadedProject,
  sceneIndex: number,
  ms: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
  onTimingChanged: () => void,
): Promise<void> {
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const changes: HistoryChange[] = [];
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
  // Typing an explicit length flips the scene to manual mode permanently (the locked duration decision); doc-less scenes just get the project.json write.
  if (doc && doc.duration?.mode !== "manual" && slug && sceneFile) {
    const next = structuredClone(doc);
    next.duration = { mode: "manual" };
    const before = structuredClone(doc);
    await writeSceneDoc(slug, sceneFile, next);
    onDocChanged(sceneIndex, next);
    changes.push({
      kind: "sceneDoc",
      slug,
      file: sceneFile,
      sceneIndex,
      before,
      after: structuredClone(next),
    });
  }
  pushHistory({ label: "scene length", changes });
  onTimingChanged();
}
