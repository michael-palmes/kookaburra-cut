import { useCallback, useMemo } from "react";
import { type CameraTool, useCameraEditStore } from "../engine/cameraEditStore";
import { useCompareEditStore } from "../engine/compareEditStore";
import type { LoadedProject } from "../engine/project";
import type { CameraDoc, RigDoc } from "../engine/sceneCameraEdit";
import {
  type SegmentEaseChannel,
  setSegmentChannelEase,
  setSegmentSmooth,
} from "../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocCameraPose, SceneDocRigPose } from "../engine/sceneDocSchema";
import { useCameraDoc } from "./cameraDoc";
import { type SegmentExtras, TrackLane } from "./TrackLane";

/** The per-scene camera timeline lane: a thin wrapper binding the generic `TrackLane` to the camera edit store, doc funnel and the mode's tool keys, O/P/Z in Orbit and M/F/L/T in Free (the lane body itself was extracted verbatim to TrackLane.tsx for the layered-screenshot lane). Neither set collides: the studio window binds no other bare letters, and the video editor's S/F/T live in a separate window. Free mode drives the RIG track and opts the popover into the rig's smoothing and channel-ease rows; the layered-screenshot lane passes neither, so it is unchanged. */

const ORBIT_TOOL_KEYS: Record<string, CameraTool> = { o: "rotate", p: "pan", z: "zoom" };
const FREE_TOOL_KEYS: Record<string, CameraTool> = {
  m: "move",
  f: "forward",
  l: "look",
  t: "tilt",
};

const getSelection = () => {
  const s = useCameraEditStore.getState();
  return { keyId: s.selectedKeyId, segment: s.selectedSegment };
};

const onEscape = () => {
  const s = useCameraEditStore.getState();
  if (s.armedTool) s.armTool(null);
  else s.select(null, null);
};

const select = (keyId: string | null, segment: number | null) => {
  useCameraEditStore.getState().select(keyId, segment);
  // Stacked lanes each bind window-level key handlers; only one selection may be live.
  if (keyId !== null || segment !== null) useCompareEditStore.getState().select(null, null);
};

export function AnimationLane({
  project,
  sceneIndex,
  onDocChanged,
  onSceneDuration,
  label,
  alwaysOpen = false,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onSceneDuration: (sceneIndex: number, ms: number) => void;
  /** Set when lanes stack (a comparison scene), naming this track. */
  label?: string;
  /** Stacked lanes stay visible regardless of the Animate-scene toggle. */
  alwaysOpen?: boolean;
}) {
  const open = useCameraEditStore((s) => s.open) || alwaysOpen;
  const selectedKeyId = useCameraEditStore((s) => s.selectedKeyId);
  const selectedSegment = useCameraEditStore((s) => s.selectedSegment);
  const writeError = useCameraEditStore((s) => s.writeError);
  const {
    slot,
    mode,
    camera,
    rig,
    preview,
    previewRig,
    commit,
    commitRig,
    appliedPoseAt,
    appliedRigAt,
  } = useCameraDoc(project, sceneIndex, onDocChanged);
  const onDuration = useCallback(
    (ms: number) => onSceneDuration(sceneIndex, ms),
    [onSceneDuration, sceneIndex],
  );
  const onToolKey = useCallback(
    (key: string): boolean => {
      const tool = (mode === "rig" ? FREE_TOOL_KEYS : ORBIT_TOOL_KEYS)[key];
      if (!tool) return false;
      useCameraEditStore.getState().armTool(tool);
      return true;
    },
    [mode],
  );

  const segmentExtras: SegmentExtras = useMemo(
    () => ({
      // Absent in the sidecar means smooth, so the toggle reads on until someone turns it off.
      smooth: (i) => rig.segments[i]?.smooth !== false,
      onSmooth: (i, on) => {
        const next = setSegmentSmooth(rig, i, on);
        if (next) void commitRig(next as RigDoc);
      },
      channelEase: (i, channel: SegmentEaseChannel) => rig.segments[i]?.[channel],
      onChannelEase: (i, channel, ease) => {
        const next = setSegmentChannelEase(rig, i, channel, ease);
        if (next) void commitRig(next as RigDoc);
      },
    }),
    [rig, commitRig],
  );

  // The lane's visible window: mid incoming transition to mid outgoing transition (project ends excepted), matching the chrome's attribution boundaries.
  const nextSlot = project.slots[sceneIndex + 1];
  const shared = {
    open,
    label,
    slotStartMs: slot.startMs,
    durationMs: slot.durationMs,
    windowStartMs: (slot.transitionIn?.durationMs ?? 0) / 2,
    windowEndMs: slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2,
    lastScene: !nextSlot,
    selectedKeyId,
    selectedSegment,
    writeError,
    select,
    getSelection,
    onToolKey,
    onEscape,
    onSceneDuration: onDuration,
    writeErrorPrefix: "Save failed — this camera edit isn’t on disk:",
  };

  if (mode === "rig") {
    return (
      <TrackLane<SceneDocRigPose, RigDoc>
        {...shared}
        track={rig}
        preview={previewRig}
        commit={commitRig}
        poseAt={appliedRigAt}
        segmentExtras={segmentExtras}
        addTitle="Insert a 1s camera flight at the playhead (it starts from the current pose)"
      />
    );
  }
  return (
    <TrackLane<SceneDocCameraPose, CameraDoc>
      {...shared}
      track={camera}
      preview={preview}
      commit={commit}
      poseAt={appliedPoseAt}
      addTitle="Insert a 1s camera animation at the playhead (it starts from the current pose)"
    />
  );
}
