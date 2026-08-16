import { useCallback, useEffect } from "react";
import {
  type LightingTarget,
  type LightingTrackDoc,
  useLightingEditStore,
} from "../engine/lightingEditStore";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc } from "../engine/sceneDocSchema";
import type { LightingPose } from "../theme/tokens";
import { clearOtherLaneSelections } from "./laneSelection";
import { useLightingTrackDoc } from "./lightingTrackDoc";
import { TrackLane } from "./TrackLane";

const getSelection = () => {
  const state = useLightingEditStore.getState();
  return { keyId: state.selectedKeyId, segment: state.selectedSegment };
};

const select = (keyId: string | null, segment: number | null) => {
  useLightingEditStore.getState().select(keyId, segment);
  if (keyId !== null || segment !== null) clearOtherLaneSelections("lighting");
};

export function LightingAnimationLane({
  project,
  sceneIndex,
  target,
  onDocChanged,
  onSceneDuration,
}: {
  project: LoadedProject;
  sceneIndex: number;
  target?: LightingTarget;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onSceneDuration: (sceneIndex: number, ms: number) => void;
}) {
  const storedTarget = useLightingEditStore((state) => state.target);
  const activeTarget = target ?? storedTarget;
  const selectedKeyId = useLightingEditStore((state) => state.selectedKeyId);
  const selectedSegment = useLightingEditStore((state) => state.selectedSegment);
  const writeError = useLightingEditStore((state) => state.writeError);
  const { track, preview, commit, appliedPoseAt } = useLightingTrackDoc(
    project,
    sceneIndex,
    activeTarget,
    onDocChanged,
  );
  useEffect(() => {
    if (target) useLightingEditStore.getState().setTarget(target);
  }, [target]);
  const onDuration = useCallback(
    (ms: number) => onSceneDuration(sceneIndex, ms),
    [onSceneDuration, sceneIndex],
  );
  const slot = project.slots[sceneIndex];
  const nextSlot = project.slots[sceneIndex + 1];
  const windowStartMs = (slot.transitionIn?.durationMs ?? 0) / 2;
  const windowEndMs = slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2;

  return (
    <TrackLane<LightingPose, LightingTrackDoc>
      open
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
      onToolKey={() => false}
      onEscape={() => select(null, null)}
      preview={(next) => preview(next, false)}
      commit={commit}
      poseAt={appliedPoseAt}
      onSceneDuration={onDuration}
      addTitle="Add a whole-rig lighting animation at the playhead"
      writeErrorPrefix="Save failed, this lighting edit is not on disk:"
      label="Lighting"
      laneClassName="lane-lighting"
    />
  );
}
