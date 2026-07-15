import { useCallback, useEffect, useState } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { sampleCameraTrack } from "../engine/cameraTrack";
import { pushHistory } from "../engine/history";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "../engine/project";
import {
  defaultOrbitPose,
  normalizeSceneCamera,
  orbitFromView,
  sampleSceneCamera,
} from "../engine/sceneCamera";
import type { CameraDoc } from "../engine/sceneCameraEdit";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc, SceneDocCameraPose } from "../engine/sceneDocSchema";

/** Shared camera-doc plumbing used by the animation lane, camera pill, stage tool overlay and inspector: the in-flight draft, live preview via the camera-edit store, sidecar commit with history + write-error surface, and the applied-pose sampler. `onDocChanged` receives the exact doc each commit wrote so the host patches the loaded project in memory instead of reloading, keeping selection and the armed tool intact. */

const EMPTY_CAMERA: CameraDoc = { keys: [], segments: [] };

export function useCameraDoc(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
) {
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const slot = project.slots[sceneIndex];
  // The in-flight (or just-committed, pre-reload) camera; cleared when the reload lands.
  const [localDraft, setLocalDraft] = useState<CameraDoc | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity IS the reload signal
  useEffect(() => setLocalDraft(null), [project, sceneIndex]);

  const camera: CameraDoc = localDraft ?? (doc?.camera as CameraDoc | undefined) ?? EMPTY_CAMERA;

  /** Push a live preview of `cam` (the canvas re-renders through the store draft). */
  const preview = useCallback(
    (cam: CameraDoc, committed: boolean) => {
      setLocalDraft(cam);
      useCameraEditStore.getState().setDraft({
        projectId: project.id,
        sceneIndex,
        track: normalizeSceneCamera(cam, "camera-edit"),
        committed,
      });
    },
    [project.id, sceneIndex],
  );

  /** Write `cam` to the sidecar (creating a minimal doc for doc-less scenes) and hand the written doc to the host for the in-memory patch. */
  const commit = useCallback(
    async (cam: CameraDoc) => {
      if (!slug || !sceneFile) return;
      preview(cam, true); // hold the pose until the patched project lands
      const next: SceneDoc = doc
        ? { ...structuredClone(doc), camera: cam }
        : { version: 1, camera: cam };
      try {
        await writeSceneDoc(slug, sceneFile, next);
        onDocChanged(sceneIndex, next);
        pushHistory({
          label: "camera edit",
          changes: [
            {
              kind: "sceneDoc",
              slug,
              file: sceneFile,
              sceneIndex,
              before: doc ? structuredClone(doc) : null,
              after: structuredClone(next),
            },
          ],
        });
        useCameraEditStore.getState().setWriteError(null);
      } catch (e) {
        // The draft keeps the pose on screen even though the disk write failed; without a surface this would be silent data loss.
        console.warn("[camera-edit] sidecar write failed:", e);
        useCameraEditStore.getState().setWriteError(String(e));
      }
    },
    [slug, sceneFile, doc, preview, onDocChanged, sceneIndex],
  );

  /** The pose the camera actually shows at scene-local `t` under the current track: scene track, then project track, then base. Add-animation/lone-key seeds sample this so an edit never visibly moves the camera until the user drags. */
  const appliedPoseAt = useCallback(
    (localT: number): SceneDocCameraPose => {
      const norm = camera.keys.length ? normalizeSceneCamera(camera, "camera-edit") : null;
      if (norm) return sampleSceneCamera(norm, localT);
      if (project.cameraTrack?.length) {
        const p = sampleCameraTrack(project.cameraTrack, slot.startMs + localT);
        return orbitFromView(p.position, p.lookAt);
      }
      return defaultOrbitPose();
    },
    [camera, project.cameraTrack, slot.startMs],
  );

  return { slug, doc, slot, camera, preview, commit, appliedPoseAt };
}
