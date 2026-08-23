import { useCallback, useEffect, useState } from "react";
import { pushHistory } from "../engine/history";
import {
  type LightingTarget,
  type LightingTrackDoc,
  useLightingEditStore,
} from "../engine/lightingEditStore";
import { isEditableProjectId, type LoadedProject, nativeProjectSlug } from "../engine/project";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { sampleLightingPose } from "../engine/sceneLighting";
import type { LightingPose } from "../theme/tokens";

export function lightingTrackForTarget(
  doc: SceneDoc | undefined,
  target: LightingTarget,
): LightingTrackDoc {
  const lighting = target === "compareB" ? doc?.compare?.b?.lighting : doc?.lighting;
  return {
    keys: lighting?.keys ?? [],
    segments: lighting?.segments ?? [],
  };
}

export function writeLightingTrackForTarget(
  doc: SceneDoc | undefined,
  target: LightingTarget,
  track: LightingTrackDoc,
): SceneDoc {
  const written: SceneDoc = doc ? structuredClone(doc) : { version: 1 };
  if (target === "scene") {
    written.lighting = { ...structuredClone(written.lighting ?? {}), ...structuredClone(track) };
    return written;
  }
  written.compare = structuredClone(written.compare ?? {});
  written.compare.b = structuredClone(written.compare.b ?? {});
  written.compare.b.lighting = {
    ...structuredClone(written.compare.b.lighting ?? {}),
    ...structuredClone(track),
  };
  return written;
}

export function useLightingTrackDoc(
  project: LoadedProject,
  sceneIndex: number,
  target: LightingTarget,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
) {
  const slug = isEditableProjectId(project.id) ? nativeProjectSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const draftIdentity = `${project.id}\u0000${sceneIndex}\u0000${target}`;
  const [localDraft, setLocalDraft] = useState<{
    identity: string;
    track: LightingTrackDoc;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity is the reload signal
  useEffect(() => setLocalDraft(null), [project, sceneIndex, target]);

  const track: LightingTrackDoc =
    localDraft?.identity === draftIdentity ? localDraft.track : lightingTrackForTarget(doc, target);

  const preview = useCallback(
    (next: LightingTrackDoc, committed: boolean) => {
      setLocalDraft({ identity: draftIdentity, track: next });
      useLightingEditStore
        .getState()
        .setDraft({ projectId: project.id, sceneIndex, target, track: next, committed });
    },
    [project.id, sceneIndex, target, draftIdentity],
  );

  const commit = useCallback(
    async (next: LightingTrackDoc) => {
      if (!slug || !sceneFile) return;
      preview(next, true);
      const written = writeLightingTrackForTarget(doc, target, next);
      try {
        await writeSceneDoc(slug, sceneFile, written);
        onDocChanged(sceneIndex, written);
        pushHistory({
          label: target === "compareB" ? "comparison lighting animation" : "lighting animation",
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
        useLightingEditStore.getState().setWriteError(null);
      } catch (error) {
        console.warn("[lighting-edit] sidecar write failed:", error);
        useLightingEditStore.getState().setWriteError(String(error));
      }
    },
    [slug, sceneFile, doc, target, preview, onDocChanged, sceneIndex],
  );

  const appliedPoseAt = useCallback(
    (localMs: number): LightingPose =>
      track.keys.length > 0 ? sampleLightingPose(track, localMs) : {},
    [track],
  );

  return { track, preview, commit, appliedPoseAt };
}
