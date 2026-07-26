import { useCallback, useEffect, useState } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { type CameraPose, sampleCameraTrack } from "../engine/cameraTrack";
import { pushHistory } from "../engine/history";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "../engine/project";
import {
  defaultOrbitPose,
  normalizeSceneCamera,
  orbitFromView,
  orbitToView,
  sampleSceneCamera,
  sceneCameraTracks,
} from "../engine/sceneCamera";
import type { CameraDoc, RigDoc } from "../engine/sceneCameraEdit";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc, SceneDocCameraPose, SceneDocRigPose } from "../engine/sceneDocSchema";
import { normalizeSceneRig, sampleSceneRig } from "../engine/sceneRig";

/** Shared camera-doc plumbing used by the animation lane, camera pill, stage tool overlay, path overlay and inspector: the in-flight draft, live preview via the camera-edit store, sidecar commit with history + write-error surface, and the applied-pose samplers. `onDocChanged` receives the exact doc each commit wrote so the host patches the loaded project in memory instead of reloading, keeping selection and the armed tool intact. Both camera blocks funnel through ONE write, so a mode switch and a pose edit are one history entry each and never fight. */

const EMPTY_CAMERA: CameraDoc = { keys: [], segments: [] };
const EMPTY_RIG: RigDoc = { keys: [], segments: [] };

export type CameraMode = "orbit" | "rig";

export function useCameraDoc(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
) {
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const slot = project.slots[sceneIndex];
  // The in-flight (or just-committed, pre-reload) camera slice; cleared when the reload lands.
  const [localDraft, setLocalDraft] = useState<{
    mode: CameraMode;
    camera: CameraDoc;
    rig: RigDoc;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity IS the reload signal
  useEffect(() => setLocalDraft(null), [project, sceneIndex]);

  const camera: CameraDoc =
    localDraft?.camera ?? (doc?.camera as CameraDoc | undefined) ?? EMPTY_CAMERA;
  const rig: RigDoc = localDraft?.rig ?? (doc?.cameraRig as RigDoc | undefined) ?? EMPTY_RIG;
  const mode: CameraMode = localDraft?.mode ?? doc?.cameraMode ?? "orbit";

  /** Push a live preview of the whole camera slice (the canvas re-renders through the store draft). */
  const previewSlice = useCallback(
    (next: { mode: CameraMode; camera: CameraDoc; rig: RigDoc }, committed: boolean) => {
      setLocalDraft(next);
      useCameraEditStore.getState().setDraft({
        projectId: project.id,
        sceneIndex,
        track: sceneCameraTracks(
          normalizeSceneCamera(next.camera, "camera-edit"),
          next.mode === "rig" ? normalizeSceneRig(next.rig, "camera-edit", doc) : null,
        ),
        committed,
      });
    },
    [project.id, sceneIndex, doc],
  );

  /** Write the camera slice to the sidecar (creating a minimal doc for doc-less scenes) and hand the written doc to the host for the in-memory patch. Empty blocks are omitted entirely (`camera` included, so a rig-only scene never grows an empty orbit stub), keeping legacy sidecars byte-identical. */
  const commitSlice = useCallback(
    async (next: { mode: CameraMode; camera: CameraDoc; rig: RigDoc }, label: string) => {
      if (!slug || !sceneFile) return;
      previewSlice(next, true); // hold the pose until the patched project lands
      const base: SceneDoc = doc ? structuredClone(doc) : { version: 1 };
      const written: SceneDoc = { ...base };
      if (next.camera.keys.length > 0) written.camera = next.camera;
      else delete written.camera;
      if (next.mode === "rig") written.cameraMode = "rig";
      else delete written.cameraMode;
      if (next.rig.keys.length > 0) written.cameraRig = next.rig;
      else delete written.cameraRig;
      try {
        await writeSceneDoc(slug, sceneFile, written);
        onDocChanged(sceneIndex, written);
        pushHistory({
          label,
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
        useCameraEditStore.getState().setWriteError(null);
      } catch (e) {
        // The draft keeps the pose on screen even though the disk write failed; without a surface this would be silent data loss.
        console.warn("[camera-edit] sidecar write failed:", e);
        useCameraEditStore.getState().setWriteError(String(e));
      }
    },
    [slug, sceneFile, doc, previewSlice, onDocChanged, sceneIndex],
  );

  const preview = useCallback(
    (cam: CameraDoc, committed: boolean) => previewSlice({ mode, camera: cam, rig }, committed),
    [previewSlice, mode, rig],
  );
  const previewRig = useCallback(
    (next: RigDoc, committed: boolean) => previewSlice({ mode, camera, rig: next }, committed),
    [previewSlice, mode, camera],
  );
  const commit = useCallback(
    (cam: CameraDoc) => commitSlice({ mode, camera: cam, rig }, "camera edit"),
    [commitSlice, mode, rig],
  );
  const commitRig = useCallback(
    (next: RigDoc) => commitSlice({ mode, camera, rig: next }, "camera edit"),
    [commitSlice, mode, camera],
  );

  /** The project-level track's fov at this instant: what a scene pose inherits unless a rig key authored its own. */
  const inheritedFov = useCallback(
    (localT: number) => sampleCameraTrack(project.cameraTrack ?? [], slot.startMs + localT).fov,
    [project.cameraTrack, slot.startMs],
  );

  /** The view the camera actually shows at scene-local `t`, resolved exactly as the render seam resolves it: rig, then orbit, then the project track, then base. */
  const appliedViewAt = useCallback(
    (localT: number): CameraPose => {
      if (mode === "rig" && rig.keys.length > 0) {
        const norm = normalizeSceneRig(rig, "camera-edit", doc);
        if (norm) {
          const s = sampleSceneRig(norm, localT);
          return {
            position: s.position,
            lookAt: s.lookAt,
            fov: s.fov ?? inheritedFov(localT),
            rollDeg: s.rollDeg,
          };
        }
      }
      if (camera.keys.length > 0) {
        const norm = normalizeSceneCamera(camera, "camera-edit");
        if (norm) {
          const view = orbitToView(sampleSceneCamera(norm, localT));
          return { position: view.position, lookAt: view.lookAt, fov: inheritedFov(localT) };
        }
      }
      return sampleCameraTrack(project.cameraTrack ?? [], slot.startMs + localT);
    },
    [mode, rig, camera, doc, inheritedFov, project.cameraTrack, slot.startMs],
  );

  /** The applied pose as an ORBIT pose: Add-animation and lone-key seeds sample this so an edit never visibly moves the camera until the user drags. */
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

  /** The applied pose as a FREE pose (a point aim at whatever the shot currently looks at): the seed for the first rig key, so switching to Free never jumps. */
  const appliedRigAt = useCallback(
    (localT: number): SceneDocRigPose => {
      const view = appliedViewAt(localT);
      const pose: SceneDocRigPose = {
        position: [...view.position],
        aim: { mode: "point", at: [...view.lookAt] },
      };
      if (view.rollDeg) pose.rollDeg = view.rollDeg;
      return pose;
    },
    [appliedViewAt],
  );

  /** Switch which block drives this scene. Never deletes the other block's keys; the first switch to Free seeds a key from the applied pose so the camera holds still. */
  const setMode = useCallback(
    (next: CameraMode, localT: number) => {
      if (next === mode) return;
      const seeded: RigDoc =
        next === "rig" && rig.keys.length === 0
          ? { keys: [{ id: "k1", tMs: 0, pose: appliedRigAt(localT) }], segments: [] }
          : rig;
      return commitSlice({ mode: next, camera, rig: seeded }, "camera mode");
    },
    [mode, rig, camera, appliedRigAt, commitSlice],
  );

  return {
    slug,
    doc,
    slot,
    mode,
    camera,
    rig,
    preview,
    previewRig,
    commit,
    commitRig,
    setMode,
    appliedPoseAt,
    appliedRigAt,
    appliedViewAt,
    inheritedFov,
  };
}
