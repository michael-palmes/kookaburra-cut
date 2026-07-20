import { useCallback, useEffect, useState } from "react";
import { pushHistory } from "../engine/history";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "../engine/project";
import { writeSceneDoc } from "../engine/sceneDoc";
import type {
  LayeredScreenshotPose,
  SceneDoc,
  SceneDocLayeredScreenshot,
} from "../engine/sceneDocSchema";
import {
  defaultLayeredScreenshotPose,
  normalizeLayeredScreenshot,
  resolveLayeredScreenshotPose,
} from "../engine/sceneLayeredScreenshot";

/** Shared layered-screenshot doc plumbing (the useCameraDoc pattern) used by the builder panel, tool overlay and animation lane: the in-flight draft, live preview via the edit store, sidecar commit with history + write-error surface, and the applied-pose sampler. `onDocChanged` receives the exact doc each commit wrote so the host patches the loaded project in memory instead of reloading. */

/** The builder's seed for a scene with no block yet. */
export function emptyLayeredScreenshot(): SceneDocLayeredScreenshot {
  return { layers: [], pose: defaultLayeredScreenshotPose() };
}

export function useLayeredScreenshotDoc(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
) {
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  // The in-flight (or just-committed, pre-reload) block; cleared when the reload lands.
  const [localDraft, setLocalDraft] = useState<SceneDocLayeredScreenshot | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity IS the reload signal
  useEffect(() => setLocalDraft(null), [project, sceneIndex]);

  const block: SceneDocLayeredScreenshot =
    localDraft ?? doc?.layeredScreenshot ?? emptyLayeredScreenshot();

  /** Push a live preview of `next` (the stack re-renders through the store draft). */
  const preview = useCallback(
    (next: SceneDocLayeredScreenshot, committed: boolean) => {
      setLocalDraft(next);
      useLayeredScreenshotEditStore.getState().setDraft({
        projectId: project.id,
        sceneIndex,
        normalized: normalizeLayeredScreenshot(next, "ls-edit"),
        committed,
      });
    },
    [project.id, sceneIndex],
  );

  /** Write `next` to the sidecar (creating a minimal doc for doc-less scenes) and hand the written doc to the host for the in-memory patch. */
  const commit = useCallback(
    async (next: SceneDocLayeredScreenshot) => {
      if (!slug || !sceneFile) return;
      preview(next, true); // hold the stack until the patched project lands
      const written: SceneDoc = doc
        ? { ...structuredClone(doc), layeredScreenshot: next }
        : { version: 1, layeredScreenshot: next };
      try {
        await writeSceneDoc(slug, sceneFile, written);
        onDocChanged(sceneIndex, written);
        pushHistory({
          label: "layered screenshot edit",
          changes: [
            {
              kind: "sceneDoc",
              slug,
              file: sceneFile,
              sceneIndex,
              before: doc ? structuredClone(doc) : null,
              after: structuredClone(written),
            },
          ],
        });
        useLayeredScreenshotEditStore.getState().setWriteError(null);
      } catch (e) {
        // The draft keeps the stack on screen even though the disk write failed; without a surface this would be silent data loss.
        console.warn("[ls-edit] sidecar write failed:", e);
        useLayeredScreenshotEditStore.getState().setWriteError(String(e));
      }
    },
    [slug, sceneFile, doc, preview, onDocChanged, sceneIndex],
  );

  /** The pose the stack actually shows at scene-local `t` under the current block + animated track; tool gestures and preset scaffolds seed from this so an edit never visibly moves the stack until the user drags. */
  const appliedPoseAt = useCallback(
    (localT: number): LayeredScreenshotPose => {
      const normalized = normalizeLayeredScreenshot(block, "ls-edit");
      if (!normalized) return defaultLayeredScreenshotPose();
      return resolveLayeredScreenshotPose(normalized, doc?.animatedTrack, localT);
    },
    [block, doc?.animatedTrack],
  );

  return { slug, doc, block, preview, commit, appliedPoseAt };
}
