import { useCallback, useEffect, useState } from "react";
import { type DeviceTrackDoc, useDeviceTrackEditStore } from "../engine/deviceTrackEditStore";
import { pushHistory } from "../engine/history";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "../engine/project";
import { deviceTrackSnapshotAt, resolveDeviceTrack } from "../engine/sceneDeviceTrack";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc, SceneDocDevicePose } from "../engine/sceneDocSchema";

/** Device-track doc plumbing (the useChartTrackDoc pattern): the in-flight draft the lane draws while a pointer is down, the sidecar commit with history + write-error surface, and the applied-pose sampler that seeds Add-keyframe so adding never visibly moves a device. Writing an empty track DELETES the block, so turning the animation off leaves the document exactly as it was before. */
export function useDeviceTrackDoc(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
) {
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const [localDraft, setLocalDraft] = useState<DeviceTrackDoc | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity IS the reload signal
  useEffect(() => setLocalDraft(null), [project, sceneIndex]);

  const track: DeviceTrackDoc = localDraft ?? {
    keys: doc?.deviceTrack?.keys ?? [],
    segments: doc?.deviceTrack?.segments ?? [],
  };

  const preview = useCallback((next: DeviceTrackDoc) => setLocalDraft(next), []);

  const commit = useCallback(
    async (next: DeviceTrackDoc) => {
      if (!slug || !sceneFile || !doc) return;
      preview(next);
      const written: SceneDoc = structuredClone(doc);
      if (next.keys.length === 0) delete written.deviceTrack;
      else written.deviceTrack = structuredClone(next);
      try {
        await writeSceneDoc(slug, sceneFile, written);
        onDocChanged(sceneIndex, written);
        pushHistory({
          label: "device animation",
          changes: [
            {
              kind: "sceneDoc",
              slug,
              file: sceneFile,
              sceneIndex,
              before: structuredClone(doc),
              after: structuredClone(written),
            },
          ],
        });
        useDeviceTrackEditStore.getState().setWriteError(null);
      } catch (e) {
        console.warn("[device-edit] sidecar write failed:", e);
        useDeviceTrackEditStore.getState().setWriteError(String(e));
      }
    },
    [slug, sceneFile, doc, preview, onDocChanged, sceneIndex],
  );

  /** The pose every device shows at scene-local `t` under the current track, as a key pose. */
  const appliedPoseAt = useCallback(
    (localT: number): Record<string, SceneDocDevicePose> =>
      deviceTrackSnapshotAt(
        resolveDeviceTrack({ ...doc, version: doc?.version ?? 1, deviceTrack: track }),
        doc?.devices ?? [],
        localT,
      ),
    [doc, track],
  );

  return { slug, doc, track, preview, commit, appliedPoseAt };
}
