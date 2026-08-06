import { useCallback, useEffect } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { type ChartTrackDoc, useChartTrackEditStore } from "../engine/chartTrackEditStore";
import { useCompareEditStore } from "../engine/compareEditStore";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import type { ChartValuesPose } from "../toolkit/chart/types";
import { openChartDataModal } from "./chartDataModalStore";
import { useChartTrackDoc } from "./chartTrackDoc";
import { TrackLane } from "./TrackLane";

/** The chart's data lane: a thin wrapper binding the generic `TrackLane` to the chart edit store and doc funnel (the CompareAnimationLane pattern). No armed tools (a key IS a data snapshot, edited in the modal), so bare keys pass through; the lane mounts for every scene with a chart block, stacked above the camera or stack lane, and double-clicking a diamond opens the data modal on that key. */

const getSelection = () => {
  const s = useChartTrackEditStore.getState();
  return { keyId: s.selectedKeyId, segment: s.selectedSegment };
};

const onEscape = () => useChartTrackEditStore.getState().select(null, null);

const select = (keyId: string | null, segment: number | null) => {
  useChartTrackEditStore.getState().select(keyId, segment);
  // Stacked lanes each bind window-level key handlers; only one selection may be live.
  if (keyId !== null || segment !== null) {
    useCameraEditStore.getState().select(null, null);
    useCompareEditStore.getState().select(null, null);
    useLayeredScreenshotEditStore.getState().selectKey(null, null);
  }
};

const onToolKey = () => false;

export function ChartAnimationLane({
  project,
  sceneIndex,
  onDocChanged,
  onSceneDuration,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onSceneDuration: (sceneIndex: number, ms: number) => void;
}) {
  const open = useChartTrackEditStore((s) => s.open);
  const selectedKeyId = useChartTrackEditStore((s) => s.selectedKeyId);
  const selectedSegment = useChartTrackEditStore((s) => s.selectedSegment);
  const writeError = useChartTrackEditStore((s) => s.writeError);
  const { track, preview, commit, appliedPoseAt } = useChartTrackDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  useEffect(() => {
    useChartTrackEditStore.getState().setOpen(true);
    return () => useChartTrackEditStore.getState().setOpen(false);
  }, []);
  const onDuration = useCallback(
    (ms: number) => onSceneDuration(sceneIndex, ms),
    [onSceneDuration, sceneIndex],
  );
  const slot = project.slots[sceneIndex];
  const nextSlot = project.slots[sceneIndex + 1];
  // No transition stance of its own (the data is one snapshot per key), so auto-placement works to the window edges.
  const windowStartMs = (slot.transitionIn?.durationMs ?? 0) / 2;
  const windowEndMs = slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2;
  return (
    <TrackLane<ChartValuesPose, ChartTrackDoc>
      open={open}
      slotStartMs={slot.startMs}
      durationMs={slot.durationMs}
      windowStartMs={windowStartMs}
      windowEndMs={windowEndMs}
      transitionInMs={windowStartMs}
      transitionOutStartMs={windowEndMs}
      lastScene={!nextSlot}
      track={track}
      selectedKeyId={selectedKeyId}
      selectedSegment={selectedSegment}
      writeError={writeError}
      select={select}
      getSelection={getSelection}
      onToolKey={onToolKey}
      onEscape={onEscape}
      preview={(t) => preview(t)}
      commit={(t) => commit(t)}
      poseAt={(localT) => appliedPoseAt(localT)}
      onKeyActivate={(keyId) => openChartDataModal(keyId)}
      onSceneDuration={onDuration}
      addTitle="Add a data animation after the last one, or ending at the playhead when it is past it"
      label="Chart"
      laneClassName="lane-chart"
      writeErrorPrefix="Save failed, this chart edit isn’t on disk:"
    />
  );
}
