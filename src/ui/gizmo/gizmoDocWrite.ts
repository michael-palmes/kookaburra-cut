import { useCallback } from "react";
import type { LoadedProject } from "../../engine/project";
import { commitSceneDocPatch, type DocChangedHandler } from "../../engine/sceneDocPatchQueue";
import type { SceneDoc } from "../../engine/sceneDocSchema";

/** The sidecar write path every 2D gizmo host shares: a live drag previews in memory (no disk, no history) so the item tracks the pointer, and pointer-up lands exactly one queued file write and one history entry. `base` is the doc the drag started from, so undo returns to the pose before the drag, not to the last preview tick; the write itself applies to the latest document, so a neighbouring edit that landed mid-drag survives. */
export function useGizmoDocWrite(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: DocChangedHandler,
) {
  const sceneFile = project.sceneFiles[sceneIndex];

  const build = useCallback((base: SceneDoc | null, mutate: (next: SceneDoc) => void): SceneDoc => {
    const next = base ? structuredClone(base) : ({ version: 1 } as SceneDoc);
    mutate(next);
    return next;
  }, []);

  const preview = useCallback(
    (base: SceneDoc | null, mutate: (next: SceneDoc) => void): SceneDoc => {
      const next = build(base, mutate);
      onDocChanged(sceneIndex, next, sceneFile, project.id);
      return next;
    },
    [build, onDocChanged, sceneIndex, sceneFile, project.id],
  );

  const commit = useCallback(
    async (base: SceneDoc | null, mutate: (next: SceneDoc) => void, label: string) => {
      if (!sceneFile) return;
      try {
        await commitSceneDocPatch(
          { project, sceneIndex, label, onDocChanged, baseline: base },
          mutate,
        );
      } catch (e) {
        console.warn("[gizmo-edit] sidecar write failed:", e);
      }
    },
    [project, sceneIndex, sceneFile, onDocChanged],
  );

  return { build, preview, commit };
}
