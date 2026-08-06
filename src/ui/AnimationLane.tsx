import { useCallback, useMemo } from "react";
import { effectiveKeyMoments, projectBeatGrid, useBeatStore } from "../engine/beatState";
import { type CameraTool, useCameraEditStore } from "../engine/cameraEditStore";
import type { LoadedProject } from "../engine/project";
import type { CameraDoc, RigDoc } from "../engine/sceneCameraEdit";
import {
  type SegmentEaseChannel,
  setSegmentChannelEase,
  setSegmentSmooth,
} from "../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocCameraPose, SceneDocRigPose } from "../engine/sceneDocSchema";
import { useCameraDoc } from "./cameraDoc";
import { clearOtherLaneSelections } from "./laneSelection";
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
  if (keyId !== null || segment !== null) clearOtherLaneSelections("camera");
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

  // The lane's visible window: mid incoming transition to mid outgoing transition (project ends excepted), matching the chrome's attribution boundaries. The transition bounds inside it are where auto-placed animations start and stop.
  const nextSlot = project.slots[sceneIndex + 1];
  const windowStartMs = (slot.transitionIn?.durationMs ?? 0) / 2;
  const windowEndMs = slot.durationMs - (nextSlot?.transitionIn?.durationMs ?? 0) / 2;

  // Soundtrack guidance mirrored into this scene's window (project time -> scene-local); absent without audio/analysis, keeping the lane unchanged.
  const analysis = useBeatStore((s) => s.analysis);
  const beatMarkers = useMemo(() => {
    const audio = project.audio;
    if (!audio || (!analysis && !audio.markers)) return undefined;
    const offset = audio.startOffsetMs ?? 0;
    const inWindow = (t: number) => t >= windowStartMs && t <= windowEndMs;
    const beats = projectBeatGrid(analysis, offset, project.totalMs)
      .map((t) => t - slot.startMs)
      .filter(inWindow);
    const keyMoments = effectiveKeyMoments(analysis, audio.markers, offset, project.totalMs)
      .map((m) => m.tMs - slot.startMs)
      .filter(inWindow);
    return beats.length || keyMoments.length ? { beats, keyMoments } : undefined;
  }, [analysis, project, slot, windowStartMs, windowEndMs]);

  const shared = {
    open,
    label,
    slotStartMs: slot.startMs,
    durationMs: slot.durationMs,
    windowStartMs,
    windowEndMs,
    beatMarkers,
    transitionInMs: slot.transitionIn?.durationMs ?? 0,
    transitionOutStartMs: nextSlot?.transitionIn
      ? slot.durationMs - nextSlot.transitionIn.durationMs
      : windowEndMs,
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
        addTitle="Add a camera flight after the last one, or ending at the playhead when it is past it"
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
      addTitle="Add a camera animation after the last one, or ending at the playhead when it is past it"
    />
  );
}
