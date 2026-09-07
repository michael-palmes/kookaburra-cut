import { useCallback, useEffect, useState } from "react";
import { compareSampleAt, compareSpecOf } from "../engine/content/sceneCompare";
import {
  type ComparePose,
  type CompareTrackDoc,
  useCompareEditStore,
} from "../engine/edit/compareEditStore";
import { isEditableProjectId, type LoadedProject, nativeProjectSlug } from "../engine/project";
import { commitSceneDocPatch, type DocChangedHandler } from "../engine/sceneDocPatchQueue";
import type { SceneDoc } from "../engine/sceneDocSchema";

/** Shared compare-track doc plumbing (the useLayeredScreenshotDoc pattern) for the divider lane: the in-flight draft, live preview via the edit store (the CompositorDriver merges it per frame), sidecar commit with history + write-error surface, and the applied-pose sampler that seeds Add-animation and splits so adding never visibly moves or rotates the divider. */
export function useCompareTrackDoc(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: DocChangedHandler,
) {
  const slug = isEditableProjectId(project.id) ? nativeProjectSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const [localDraft, setLocalDraft] = useState<CompareTrackDoc | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity IS the reload signal
  useEffect(() => setLocalDraft(null), [project, sceneIndex]);

  const track: CompareTrackDoc = localDraft ?? {
    keys: doc?.compare?.track?.keys ?? [],
    segments: doc?.compare?.track?.segments ?? [],
  };

  const preview = useCallback(
    (next: CompareTrackDoc, committed: boolean) => {
      setLocalDraft(next);
      useCompareEditStore
        .getState()
        .setDraft({ projectId: project.id, sceneIndex, track: next, committed });
    },
    [project.id, sceneIndex],
  );

  /** Write `next` to the sidecar (creating a minimal compare block for scenes without one) and hand the written doc to the host for the in-memory patch. */
  const commit = useCallback(
    async (next: CompareTrackDoc) => {
      if (!slug || !sceneFile) return;
      preview(next, true);
      try {
        await commitSceneDocPatch(
          { project, sceneIndex, label: "divider animation", onDocChanged },
          (written) => {
            written.compare = { ...(written.compare ?? {}), track: structuredClone(next) };
          },
        );
        useCompareEditStore.getState().setWriteError(null);
      } catch (e) {
        console.warn("[compare-edit] sidecar write failed:", e);
        useCompareEditStore.getState().setWriteError(String(e));
      }
    },
    [slug, sceneFile, preview, onDocChanged, sceneIndex, project],
  );

  /** The divider pose the scene actually shows at scene-local `t` under the current track. The angle rides along ONLY on tracks that already animate it, so seeding a key on a plain divider still writes an angle-free pose and existing docs stay byte-identical. */
  const appliedPoseAt = useCallback(
    (localT: number): ComparePose => {
      const spec = compareSpecOf(
        doc
          ? { ...doc, compare: { ...(doc.compare ?? {}), track } }
          : ({ version: 1, compare: { track } } as SceneDoc),
      );
      if (!spec) return { value: 0.5 };
      const sample = compareSampleAt(spec, localT);
      return track.keys.some((k) => k.pose.angleDeg !== undefined)
        ? { value: sample.value, angleDeg: sample.angleDeg }
        : { value: sample.value };
    },
    [doc, track],
  );

  return { slug, doc, track, preview, commit, appliedPoseAt };
}
