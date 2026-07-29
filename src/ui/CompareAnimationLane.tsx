import { useCallback, useEffect } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import { type CompareTrackDoc, useCompareEditStore } from "../engine/compareEditStore";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { useCompareTrackDoc } from "./compareTrackDoc";
import { TrackLane } from "./TrackLane";

/** The comparison divider's timeline lane: a thin wrapper binding the generic `TrackLane` to the compare edit store and doc funnel (the AnimationLane pattern). No armed tools (the divider is one channel, the diamonds are the gesture surface), so bare keys pass through; the lane mounts (and opens) for every comparison scene, stacked above the camera or stack lane with its own label and colour. */

const getSelection = () => {
  const s = useCompareEditStore.getState();
  return { keyId: s.selectedKeyId, segment: s.selectedSegment };
};

const onEscape = () => useCompareEditStore.getState().select(null, null);

const select = (keyId: string | null, segment: number | null) => {
  useCompareEditStore.getState().select(keyId, segment);
  // Stacked lanes each bind window-level key handlers; only one selection may be live.
  if (keyId !== null || segment !== null) useCameraEditStore.getState().select(null, null);
};

const onToolKey = () => false;

export function CompareAnimationLane({
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
  const open = useCompareEditStore((s) => s.open);
  const selectedKeyId = useCompareEditStore((s) => s.selectedKeyId);
  const selectedSegment = useCompareEditStore((s) => s.selectedSegment);
  const writeError = useCompareEditStore((s) => s.writeError);
  const { track, preview, commit, appliedValueAt } = useCompareTrackDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  useEffect(() => {
    useCompareEditStore.getState().setOpen(true);
    return () => useCompareEditStore.getState().setOpen(false);
  }, []);
  const onDuration = useCallback(
    (ms: number) => onSceneDuration(sceneIndex, ms),
    [onSceneDuration, sceneIndex],
  );
  const slot = project.slots[sceneIndex];
  const nextSlot = project.slots[sceneIndex + 1];
  return (
    <TrackLane<{ value: number }, CompareTrackDoc>
      open={open}
      slotStartMs={slot.startMs}
      durationMs={slot.durationMs}
      windowStartMs={(slot.transitionIn?.durationMs ?? 0) / 2}
      windowEndMs={slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2}
      lastScene={!nextSlot}
      track={track}
      selectedKeyId={selectedKeyId}
      selectedSegment={selectedSegment}
      writeError={writeError}
      select={select}
      getSelection={getSelection}
      onToolKey={onToolKey}
      onEscape={onEscape}
      preview={(t) => preview(t, false)}
      commit={(t) => commit(t)}
      poseAt={(localT) => ({ value: appliedValueAt(localT) })}
      onSceneDuration={onDuration}
      addTitle="Add comparison animation"
      label="Comparison"
      laneClassName="lane-compare"
      writeErrorPrefix="Save failed — this divider edit isn’t on disk:"
    />
  );
}
