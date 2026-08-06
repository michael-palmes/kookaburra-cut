import { useCallback } from "react";
import type { LayeredScreenshotAnimationDoc } from "../engine/layeredScreenshotAnimationEdit";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import type { LoadedProject } from "../engine/project";
import type {
  LayeredScreenshotPose,
  SceneDoc,
  SceneDocLayeredScreenshot,
} from "../engine/sceneDocSchema";
import { clearOtherLaneSelections } from "./laneSelection";
import { useLayeredScreenshotDoc } from "./layeredScreenshotDoc";
import { TrackLane } from "./TrackLane";

/** The layered-screenshot animation lane: the generic `TrackLane` bound to the LS edit store, the block's `animation` track and the O/P/Z/S tool keys (the AnimationLane pattern). */

const EMPTY_TRACK: LayeredScreenshotAnimationDoc = { keys: [], segments: [] };

const TOOL_KEYS: Record<string, "rotate" | "pan" | "zoom" | "spread"> = {
  o: "rotate",
  p: "pan",
  z: "zoom",
  s: "spread",
};

const getSelection = () => {
  const s = useLayeredScreenshotEditStore.getState();
  return { keyId: s.selectedKeyId, segment: s.selectedSegment };
};

const onToolKey = (key: string): boolean => {
  const tool = TOOL_KEYS[key];
  if (!tool) return false;
  useLayeredScreenshotEditStore.getState().armTool(tool);
  return true;
};

const onEscape = () => {
  const s = useLayeredScreenshotEditStore.getState();
  if (s.armedTool) s.armTool(null);
  else s.selectKey(null, null);
};

const selectKey = (keyId: string | null, segment: number | null) => {
  useLayeredScreenshotEditStore.getState().selectKey(keyId, segment);
  if (keyId !== null || segment !== null) clearOtherLaneSelections("layeredScreenshot");
};

/** The block with `track` as its animation; an emptied track drops the field so the sidecar stays clean. */
export function blockWithAnimation(
  block: SceneDocLayeredScreenshot,
  track: LayeredScreenshotAnimationDoc,
): SceneDocLayeredScreenshot {
  if (track.keys.length === 0) {
    const { animation: _dropped, ...rest } = block;
    return rest;
  }
  return { ...block, animation: { keys: track.keys, segments: track.segments } };
}

export function LayeredScreenshotAnimationLane({
  project,
  sceneIndex,
  onDocChanged,
  onSceneDuration,
  label,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  /** Set when lanes stack (a comparison scene), naming this track. */
  label?: string;
  onSceneDuration: (sceneIndex: number, ms: number) => void;
}) {
  const open = useLayeredScreenshotEditStore((s) => s.laneOpen);
  const selectedKeyId = useLayeredScreenshotEditStore((s) => s.selectedKeyId);
  const selectedSegment = useLayeredScreenshotEditStore((s) => s.selectedSegment);
  const writeError = useLayeredScreenshotEditStore((s) => s.writeError);
  const { block, preview, commit, appliedPoseAt } = useLayeredScreenshotDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  const slot = project.slots[sceneIndex];
  const track: LayeredScreenshotAnimationDoc = block.animation ?? EMPTY_TRACK;

  const previewTrack = useCallback(
    (next: LayeredScreenshotAnimationDoc, committed: boolean) =>
      preview(blockWithAnimation(block, next), committed),
    [preview, block],
  );
  const commitTrack = useCallback(
    (next: LayeredScreenshotAnimationDoc) => commit(blockWithAnimation(block, next)),
    [commit, block],
  );
  const onDuration = useCallback(
    (ms: number) => onSceneDuration(sceneIndex, ms),
    [onSceneDuration, sceneIndex],
  );

  // The lane's visible window: mid incoming transition to mid outgoing transition (project ends excepted), matching the chrome's attribution boundaries. The stack lane has no transition stance of its own, so auto-placement works to the window edges.
  const nextSlot = project.slots[sceneIndex + 1];
  const windowStartMs = (slot.transitionIn?.durationMs ?? 0) / 2;
  const windowEndMs = slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2;
  return (
    <TrackLane<LayeredScreenshotPose, LayeredScreenshotAnimationDoc>
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
      select={selectKey}
      getSelection={getSelection}
      onToolKey={onToolKey}
      onEscape={onEscape}
      preview={previewTrack}
      commit={commitTrack}
      poseAt={appliedPoseAt}
      onSceneDuration={onDuration}
      addTitle="Add a stack animation after the last one, or ending at the playhead when it is past it"
      label={label}
      writeErrorPrefix="Save failed, this stack edit isn’t on disk:"
    />
  );
}
