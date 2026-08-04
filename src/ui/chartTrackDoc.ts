import { useCallback, useEffect, useState } from "react";
import { type ChartTrackDoc, useChartTrackEditStore } from "../engine/chartTrackEditStore";
import { pushHistory } from "../engine/history";
import { isWorkspaceProjectId, type LoadedProject, workspaceSlug } from "../engine/project";
import { chartValuesAt, resolveChart } from "../engine/sceneChart";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc } from "../engine/sceneDocSchema";
import type { ChartValuesPose } from "../toolkit/chart/types";

/** Chart data-track doc plumbing (the useCompareTrackDoc pattern): the in-flight draft the lane draws while a pointer is down, the sidecar commit with history + write-error surface, and the applied-values sampler that seeds Add-keyframe so adding never visibly moves the chart. */
export function useChartTrackDoc(
  project: LoadedProject,
  sceneIndex: number,
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void,
) {
  const slug = isWorkspaceProjectId(project.id) ? workspaceSlug(project.id) : null;
  const doc = project.sceneDocs[sceneIndex];
  const sceneFile = project.sceneFiles[sceneIndex];
  const [localDraft, setLocalDraft] = useState<ChartTrackDoc | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project identity IS the reload signal
  useEffect(() => setLocalDraft(null), [project, sceneIndex]);

  const track: ChartTrackDoc = localDraft ?? {
    keys: doc?.chart?.track?.keys ?? [],
    segments: doc?.chart?.track?.segments ?? [],
  };

  const preview = useCallback((next: ChartTrackDoc) => setLocalDraft(next), []);

  /** Write `next` to the sidecar and hand the written doc to the host for the in-memory patch; a scene with no chart block has no lane, so there is nothing to create here. */
  const commit = useCallback(
    async (next: ChartTrackDoc) => {
      if (!slug || !sceneFile || !doc?.chart) return;
      preview(next);
      const written: SceneDoc = {
        ...structuredClone(doc),
        chart: { ...structuredClone(doc.chart), track: next },
      };
      try {
        await writeSceneDoc(slug, sceneFile, written);
        onDocChanged(sceneIndex, written);
        pushHistory({
          label: "chart animation",
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
        useChartTrackEditStore.getState().setWriteError(null);
      } catch (e) {
        console.warn("[chart-edit] sidecar write failed:", e);
        useChartTrackEditStore.getState().setWriteError(String(e));
      }
    },
    [slug, sceneFile, doc, preview, onDocChanged, sceneIndex],
  );

  /** The value matrix the chart actually shows at scene-local `t` under the current track, as a key pose. */
  const appliedPoseAt = useCallback(
    (localT: number): ChartValuesPose => {
      const base = doc?.chart;
      if (!base) return { values: [] };
      const chart = resolveChart({ ...doc, chart: { ...base, track } } as SceneDoc);
      return { values: chart ? chartValuesAt(chart, localT) : [] };
    },
    [doc, track],
  );

  return { slug, doc, track, preview, commit, appliedPoseAt };
}
