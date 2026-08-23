import { useCallback } from "react";
import { type HistoryChange, pushHistory } from "../../engine/history";
import { type LoadedProject, nativeProjectSlug } from "../../engine/project";
import { writeSceneDoc } from "../../engine/sceneDoc";
import type { SceneDoc } from "../../engine/sceneDocSchema";

/** The sidecar write path every 2D gizmo host shares: a live drag previews in memory (no disk, no history) so the item tracks the pointer, and pointer-up lands exactly one file write and one history entry. `base` is the doc the drag started from, so undo returns to the pose before the drag, not to the last preview tick. */
export function useGizmoDocWrite(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
) {
  const slug = nativeProjectSlug(project.id);
  const sceneFile = project.sceneFiles[sceneIndex];

  const build = useCallback((base: SceneDoc | null, mutate: (next: SceneDoc) => void): SceneDoc => {
    const next = base ? structuredClone(base) : ({ version: 1 } as SceneDoc);
    mutate(next);
    return next;
  }, []);

  const preview = useCallback(
    (base: SceneDoc | null, mutate: (next: SceneDoc) => void): SceneDoc => {
      const next = build(base, mutate);
      onDocChanged(sceneIndex, next);
      return next;
    },
    [build, onDocChanged, sceneIndex],
  );

  const commit = useCallback(
    async (base: SceneDoc | null, mutate: (next: SceneDoc) => void, label: string) => {
      if (!sceneFile) return;
      const next = build(base, mutate);
      try {
        await writeSceneDoc(slug, sceneFile, next);
        onDocChanged(sceneIndex, next);
        const change: HistoryChange = {
          kind: "sceneDoc",
          slug,
          file: sceneFile,
          sceneIndex,
          before: base ? structuredClone(base) : null,
          after: structuredClone(next),
        };
        pushHistory({ label, changes: [change] });
      } catch (e) {
        console.warn("[gizmo-edit] sidecar write failed:", e);
      }
    },
    [build, slug, sceneFile, sceneIndex, onDocChanged],
  );

  return { build, preview, commit };
}
