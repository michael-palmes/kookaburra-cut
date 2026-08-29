import { useCallback } from "react";
import { type DeviceTrackDoc, useDeviceTrackEditStore } from "../engine/deviceTrackEditStore";
import type { LoadedProject } from "../engine/project";
import type { SceneDoc, SceneDocDevicePose } from "../engine/sceneDocSchema";
import { useDeviceTrackDoc } from "./deviceTrackDoc";
import { clearOtherLaneSelections } from "./laneSelection";
import { TrackLane } from "./TrackLane";

/** The scene's device lane: a thin wrapper binding the generic `TrackLane` to the device track store and doc funnel (the ChartAnimationLane pattern). One lane for the whole scene, each key carrying a pose per device, so a multi-device scene moves in concert. No armed tools: a key IS the devices' pose, shaped with the gizmo, so bare keys pass through. */

const getSelection = () => {
  const s = useDeviceTrackEditStore.getState();
  return { keyId: s.selectedKeyId, segment: s.selectedSegment };
};

const onEscape = () => useDeviceTrackEditStore.getState().select(null, null);

const select = (keyId: string | null, segment: number | null) => {
  useDeviceTrackEditStore.getState().select(keyId, segment);
  if (keyId !== null || segment !== null) clearOtherLaneSelections("device");
};

const onToolKey = () => false;

export function DeviceAnimationLane({
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
  const selectedKeyId = useDeviceTrackEditStore((s) => s.selectedKeyId);
  const selectedSegment = useDeviceTrackEditStore((s) => s.selectedSegment);
  const writeError = useDeviceTrackEditStore((s) => s.writeError);
  const { track, preview, commit, appliedPoseAt } = useDeviceTrackDoc(
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
  // No transition stance of its own (a key is one pose), so auto-placement works to the window edges.
  const windowStartMs = (slot.transitionIn?.durationMs ?? 0) / 2;
  const windowEndMs = slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2;
  return (
    <TrackLane<Record<string, SceneDocDevicePose>, DeviceTrackDoc>
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
      onSceneDuration={onDuration}
      addTitle="Add a device animation after the last one, or ending at the playhead when it is past it"
      label="Devices"
      laneClassName="lane-device"
      writeErrorPrefix="Save failed, this device edit isn’t on disk:"
    />
  );
}
