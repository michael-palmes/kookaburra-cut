import { useCallback } from "react";
import {
  type ComparePose,
  type CompareTrackDoc,
  useCompareEditStore,
} from "../engine/compareEditStore";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import { useCompareTrackDoc } from "./compareTrackDoc";
import { clearOtherLaneSelections } from "./laneSelection";
import { TrackLane } from "./TrackLane";

/** The comparison divider's timeline lane: a thin wrapper binding the generic `TrackLane` to the compare edit store and doc funnel (the AnimationLane pattern). No armed tools (the divider is one channel, the diamonds are the gesture surface), so bare keys pass through; the lane follows the scene's master animation visibility, stacked above the camera or stack lane with its own label and colour. */

const getSelection = () => {
  const s = useCompareEditStore.getState();
  return { keyId: s.selectedKeyId, segment: s.selectedSegment };
};

const onEscape = () => useCompareEditStore.getState().select(null, null);

const select = (keyId: string | null, segment: number | null) => {
  useCompareEditStore.getState().select(keyId, segment);
  if (keyId !== null || segment !== null) clearOtherLaneSelections("compare");
};

const onToolKey = () => false;

export function CompareAnimationLane({
  project,
  sceneIndex,
  open,
  onDocChanged,
  onSceneDuration,
}: {
  project: LoadedProject;
  sceneIndex: number;
  open: boolean;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onSceneDuration: (sceneIndex: number, ms: number) => void;
}) {
  const selectedKeyId = useCompareEditStore((s) => s.selectedKeyId);
  const selectedSegment = useCompareEditStore((s) => s.selectedSegment);
  const writeError = useCompareEditStore((s) => s.writeError);
  const { track, preview, commit, appliedPoseAt } = useCompareTrackDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  const onDuration = useCallback(
    (ms: number) => onSceneDuration(sceneIndex, ms),
    [onSceneDuration, sceneIndex],
  );
  const slot = project.slots[sceneIndex];
  const nextSlot = project.slots[sceneIndex + 1];
  // No transition stance of its own (the divider is one channel), so auto-placement works to the window edges.
  const windowStartMs = (slot.transitionIn?.durationMs ?? 0) / 2;
  const windowEndMs = slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2;
  return (
    <TrackLane<ComparePose, CompareTrackDoc>
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
      preview={(t) => preview(t, false)}
      commit={(t) => commit(t)}
      poseAt={appliedPoseAt}
      onSceneDuration={onDuration}
      addTitle="Add a divider animation after the last one, or ending at the playhead when it is past it"
      label="Comparison"
      laneClassName="lane-compare"
      writeErrorPrefix="Save failed — this divider edit isn’t on disk:"
    />
  );
}
