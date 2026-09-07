import { useCallback } from "react";
import {
  useLayeredScreenshotDraft,
  useLayeredScreenshotEditStore,
} from "../engine/layeredScreenshotEditStore";
import { isEditableProjectId, type LoadedProject, nativeProjectSlug } from "../engine/project";
import { commitSceneDocPatch, type DocChangedHandler } from "../engine/sceneDocPatchQueue";
import type { LayeredScreenshotPose, SceneDocLayeredScreenshot } from "../engine/sceneDocSchema";
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
  onDocChanged: DocChangedHandler,
) {
  const slug = isEditableProjectId(project.id) ? nativeProjectSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const draft = useLayeredScreenshotDraft(project.id, sceneIndex);

  const block: SceneDocLayeredScreenshot =
    draft?.block ?? doc?.layeredScreenshot ?? emptyLayeredScreenshot();

  /** Push a live preview of `next` (the stack re-renders through the store draft). */
  const preview = useCallback(
    (next: SceneDocLayeredScreenshot, committed: boolean) => {
      useLayeredScreenshotEditStore.getState().setDraft({
        projectId: project.id,
        sceneIndex,
        normalized: normalizeLayeredScreenshot(next, "ls-edit"),
        block: next,
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
      try {
        await commitSceneDocPatch(
          { project, sceneIndex, label: "layered screenshot edit", onDocChanged },
          (written) => {
            written.layeredScreenshot = structuredClone(next);
          },
        );
        useLayeredScreenshotEditStore.getState().setWriteError(null);
      } catch (e) {
        // The draft keeps the stack on screen even though the disk write failed; without a surface this would be silent data loss.
        console.warn("[ls-edit] sidecar write failed:", e);
        useLayeredScreenshotEditStore.getState().setWriteError(String(e));
      }
    },
    [slug, sceneFile, preview, onDocChanged, sceneIndex, project],
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
