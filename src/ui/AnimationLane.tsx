import { useCallback } from "react";
import { useCameraEditStore } from "../engine/cameraEditStore";
import type { LoadedProject } from "../engine/project";
import type { CameraDoc } from "../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocCameraPose } from "../engine/sceneDocSchema";
import { useCameraDoc } from "./cameraDoc";
import { TrackLane } from "./TrackLane";

/** The per-scene camera timeline lane: a thin wrapper binding the generic `TrackLane` to the camera edit store, doc funnel and O/P/Z tool keys (the lane body itself was extracted verbatim to TrackLane.tsx for the layered-screenshot lane). */

const TOOL_KEYS: Record<string, "rotate" | "pan" | "zoom"> = {
  o: "rotate",
  p: "pan",
  z: "zoom",
};

const getSelection = () => {
  const s = useCameraEditStore.getState();
  return { keyId: s.selectedKeyId, segment: s.selectedSegment };
};

const onToolKey = (key: string): boolean => {
  const tool = TOOL_KEYS[key];
  if (!tool) return false;
  useCameraEditStore.getState().armTool(tool);
  return true;
};

const onEscape = () => {
  const s = useCameraEditStore.getState();
  if (s.armedTool) s.armTool(null);
  else s.select(null, null);
};

const select = (keyId: string | null, segment: number | null) =>
  useCameraEditStore.getState().select(keyId, segment);

export function AnimationLane({
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
  const open = useCameraEditStore((s) => s.open);
  const selectedKeyId = useCameraEditStore((s) => s.selectedKeyId);
  const selectedSegment = useCameraEditStore((s) => s.selectedSegment);
  const writeError = useCameraEditStore((s) => s.writeError);
  const { slot, camera, preview, commit, appliedPoseAt } = useCameraDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  const onDuration = useCallback(
    (ms: number) => onSceneDuration(sceneIndex, ms),
    [onSceneDuration, sceneIndex],
  );

  return (
    <TrackLane<SceneDocCameraPose, CameraDoc>
      open={open}
      slotStartMs={slot.startMs}
      durationMs={slot.durationMs}
      track={camera}
      selectedKeyId={selectedKeyId}
      selectedSegment={selectedSegment}
      writeError={writeError}
      select={select}
      getSelection={getSelection}
      onToolKey={onToolKey}
      onEscape={onEscape}
      preview={preview}
      commit={commit}
      poseAt={appliedPoseAt}
      onSceneDuration={onDuration}
      addTitle="Insert a 1s camera animation at the playhead (it starts from the current pose)"
      writeErrorPrefix="Save failed — this camera edit isn’t on disk:"
    />
  );
}
