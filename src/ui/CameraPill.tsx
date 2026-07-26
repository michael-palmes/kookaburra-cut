import { type CameraTool, isFreeTool, useCameraEditStore } from "../engine/cameraEditStore";
import { useClockStore } from "../engine/clock";
import type { LoadedProject } from "../engine/project";
import { defaultOrbitPose } from "../engine/sceneCamera";
import { nearestKey, setKeyPose } from "../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocCameraPose, SceneDocRigPose } from "../engine/sceneDocSchema";
import { defaultRigPose, RIG_FOV_MAX, RIG_FOV_MIN } from "../engine/sceneRig";
import { useCameraDoc } from "./cameraDoc";
import { SegmentedRow } from "./inspector/rows";

/** Floating camera control pill: idle "Animate scene" opens animation mode via `cameraEditStore.open`; active state offers an Orbit/Free switch, that mode's drag tools, and a contextual stepper (orbit's zoom percent, free's field of view). Every stepper edits the selected-else-nearest key through the same `useCameraDoc` commit as other camera edits; 100% zoom is the scene-default pose's distance. */

const ZOOM_STEP_PCT = 10;
const FOV_STEP_DEG = 5;

const MODE_OPTIONS = [
  { value: "orbit" as const, label: "Orbit", title: "Poses orbit a target: the classic camera" },
  {
    value: "free" as const,
    label: "Free",
    title: "Free-flight poses: a position plus an aim, for fly-throughs and cranes",
  },
];

export function CameraPill({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const open = useCameraEditStore((s) => s.open);
  const armedTool = useCameraEditStore((s) => s.armedTool);
  const { slot, mode, camera, rig, commit, commitRig, setMode, appliedPoseAt, appliedRigAt } =
    useCameraDoc(project, sceneIndex, onDocChanged);
  const free = mode === "rig";
  const keyCount = free ? rig.keys.length : camera.keys.length;

  // The stepper target: the selected-else-nearest key (the inspector's derive-don't-subscribe pattern; re-render on the target key, coarse buckets when trackless).
  const selectedKeyId = useCameraEditStore((s) => s.selectedKeyId);
  const targetKeyId = useClockStore((s) => {
    if (keyCount === 0) return null;
    const local = Math.min(slot.durationMs, Math.max(0, s.currentMs - slot.startMs));
    const found = free
      ? (rig.keys.find((k) => k.id === selectedKeyId) ?? nearestKey(rig, local))
      : (camera.keys.find((k) => k.id === selectedKeyId) ?? nearestKey(camera, local));
    return found?.id ?? null;
  });
  const coarseLocal = useClockStore((s) =>
    keyCount === 0
      ? Math.round(Math.min(slot.durationMs, Math.max(0, s.currentMs - slot.startMs)) / 250) * 250
      : 0,
  );

  const orbitKey = camera.keys.find((k) => k.id === targetKeyId) ?? null;
  const rigKey = rig.keys.find((k) => k.id === targetKeyId) ?? null;
  const targetKey = free ? rigKey : orbitKey;
  const orbitPose: SceneDocCameraPose = orbitKey?.pose ?? appliedPoseAt(coarseLocal);
  const rigPose: SceneDocRigPose = rigKey?.pose ?? appliedRigAt(coarseLocal);

  const baseDistance = defaultOrbitPose().distance;
  const zoomPct = Math.round((baseDistance / Math.max(0.001, orbitPose.distance)) * 100);
  const fovDeg = Math.round(rigPose.fov ?? 45);

  const stepZoom = (direction: 1 | -1) => {
    const nextPct = Math.max(20, Math.min(400, zoomPct + direction * ZOOM_STEP_PCT));
    if (nextPct === zoomPct) return;
    const distance = Math.min(50, Math.max(0.5, (baseDistance * 100) / nextPct));
    const next: SceneDocCameraPose = { ...orbitPose, target: [...orbitPose.target], distance };
    if (orbitKey) {
      const cam = setKeyPose(camera, orbitKey.id, next);
      if (cam) void commit(cam);
    } else {
      // Empty track: a lone key at 0 = static reframe (the overlay's seed).
      void commit({ keys: [{ id: "k1", tMs: 0, pose: next }], segments: [] });
      useCameraEditStore.getState().select("k1", null);
    }
  };

  const stepFov = (direction: 1 | -1) => {
    const next = Math.max(RIG_FOV_MIN, Math.min(RIG_FOV_MAX, fovDeg + direction * FOV_STEP_DEG));
    if (next === fovDeg) return;
    const pose: SceneDocRigPose = { ...rigPose, aim: { ...rigPose.aim }, fov: next };
    if (rigKey) {
      const track = setKeyPose(rig, rigKey.id, pose);
      if (track) void commitRig(track);
    } else {
      void commitRig({ keys: [{ id: "k1", tMs: 0, pose }], segments: [] });
      useCameraEditStore.getState().select("k1", null);
    }
  };

  const armTool = useCameraEditStore.getState().armTool;
  const modeButton = (tool: CameraTool, label: string, glyph: React.ReactNode) => (
    <button
      type="button"
      className={`camera-pill-mode${armedTool === tool ? " active" : ""}`}
      aria-pressed={armedTool === tool}
      title={label}
      onClick={() => armTool(tool)}
    >
      {glyph}
    </button>
  );

  const stepper = (
    label: string,
    readout: string,
    outLabel: string,
    inLabel: string,
    step: (d: 1 | -1) => void,
  ) => (
    <span className="camera-pill-zoom" title={label}>
      <button
        type="button"
        className="camera-pill-step"
        aria-label={outLabel}
        onClick={() => step(-1)}
      >
        −
      </button>
      <span className="camera-pill-readout">{readout}</span>
      <button
        type="button"
        className="camera-pill-step"
        aria-label={inLabel}
        onClick={() => step(1)}
      >
        +
      </button>
    </span>
  );

  const FREE_BLURBS: Partial<Record<CameraTool, string>> = {
    move: "Drag to move",
    forward: "Drag to fly",
    look: "Drag to look",
    tilt: "Drag to bank",
  };

  let contextual: React.ReactNode;
  if (free && armedTool === "forward") {
    contextual = stepper(
      "Field of view",
      `${fovDeg}°`,
      "Narrower field of view",
      "Wider field of view",
      stepFov,
    );
  } else if (!free && armedTool === "zoom") {
    contextual = stepper("Zoom", `${zoomPct}%`, "Zoom out", "Zoom in", stepZoom);
  } else {
    contextual = (
      <span className="camera-pill-blurb">
        {free
          ? (FREE_BLURBS[armedTool ?? "move"] ?? "Drag to move")
          : armedTool === "pan"
            ? "Drag to pan"
            : "Drag to orbit"}
      </span>
    );
  }

  return (
    <div className="camera-pill-wrap">
      <div className={`camera-pill${open ? " active" : ""}`}>
        <button
          type="button"
          className="camera-pill-idle"
          aria-hidden={open}
          tabIndex={open ? -1 : 0}
          onClick={() => {
            const state = useCameraEditStore.getState();
            state.setOpen(true);
            state.armTool(free ? "move" : "rotate"); // the design's "cameraMode resets to the mode's first tool"
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="2.5" y="6" width="10" height="8" rx="1.5" />
            <path d="M12.5 9l4.5-2.5v7L12.5 11" />
          </svg>
          Animate scene
        </button>

        <div className="camera-pill-active" aria-hidden={!open}>
          <SegmentedRow
            className="camera-pill-modes"
            options={MODE_OPTIONS}
            value={free ? "free" : "orbit"}
            onChange={(next) => {
              const local = Math.min(
                slot.durationMs,
                Math.max(0, useClockStore.getState().currentMs - slot.startMs),
              );
              void setMode(next === "free" ? "rig" : "orbit", local);
              useCameraEditStore.getState().armTool(next === "free" ? "move" : "rotate");
            }}
          />
          <span className="camera-pill-divider" />
          {free ? (
            <>
              {modeButton(
                "move",
                "Move (M) — drag in the preview to slide the camera (or hold ⌘ while dragging)",
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M10 3v14M3 10h14M10 3l-2 2m2-2l2 2M10 17l-2-2m2 2l2-2M3 10l2-2m-2 2l2 2M17 10l-2-2m2 2l-2 2" />
                </svg>,
              )}
              {modeButton(
                "forward",
                "Forward (F) — drag vertically to fly along the view axis (or hold ⌃ while dragging)",
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M10 16.5V4M10 4L6 8M10 4l4 4" />
                  <path d="M4 18h12" />
                </svg>,
              )}
              {modeButton(
                "look",
                "Look (L) — drag to swing the aim about the camera (or hold ⌥ while dragging)",
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M1.8 10S5 4.8 10 4.8 18.2 10 18.2 10 15 15.2 10 15.2 1.8 10 1.8 10z" />
                  <circle cx="10" cy="10" r="2.4" />
                </svg>,
              )}
              {modeButton(
                "tilt",
                "Tilt (T) — drag horizontally to bank the frame",
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M3.4 13.2l9.4-9.4a1.4 1.4 0 012 0l1.4 1.4a1.4 1.4 0 010 2l-9.4 9.4z" />
                  <path d="M2 17.6h6" />
                </svg>,
              )}
            </>
          ) : (
            <>
              {modeButton(
                "rotate",
                "Orbit (O) — drag in the preview to orbit around the target (or hold ⌥ while dragging)",
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <circle cx="10" cy="10" r="3.2" />
                  <path d="M10 2.8a7.2 7.2 0 017.2 7.2M10 17.2A7.2 7.2 0 012.8 10" />
                  <path d="M15.6 8.4L17.2 10l1.4-1.7M4.4 11.6L2.8 10l-1.4 1.7" />
                </svg>,
              )}
              {modeButton(
                "pan",
                "Pan (P) — drag in the preview to slide the camera target (or hold ⌘ while dragging)",
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M10 3v14M3 10h14M10 3l-2 2m2-2l2 2M10 17l-2-2m2 2l2-2M3 10l2-2m-2 2l2 2M17 10l-2-2m2 2l-2 2" />
                </svg>,
              )}
              {modeButton(
                "zoom",
                "Zoom (Z) — drag vertically in the preview to dolly (or hold ⌃ while dragging)",
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <circle cx="9" cy="9" r="5.2" />
                  <path d="M13 13l4 4M9 6.8v4.4M6.8 9h4.4" />
                </svg>,
              )}
            </>
          )}
          <span className="camera-pill-divider" />
          {contextual}
          <button
            type="button"
            className="camera-pill-mode"
            title="Reset this key to the scene-default pose"
            aria-label="Reset camera pose"
            disabled={!targetKey}
            onClick={() => {
              // Trackless: nothing to reset, never seed a key.
              if (!targetKey) return;
              if (free) {
                const next = setKeyPose(rig, targetKey.id, defaultRigPose());
                if (next) void commitRig(next);
              } else {
                const cam = setKeyPose(camera, targetKey.id, defaultOrbitPose());
                if (cam) void commit(cam);
              }
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4.5 8.5A6.2 6.2 0 0110.4 4a6 6 0 11-5.7 8" />
              <path d="M4.2 4.5v4h4" />
            </svg>
          </button>
          <button
            type="button"
            className="camera-pill-close"
            title="Done animating (closes the lane)"
            aria-label="Close animation mode"
            onClick={() => useCameraEditStore.getState().setOpen(false)}
          >
            ×
          </button>
        </div>
      </div>
      <div className={`camera-pill-hint${open ? " visible" : ""}`} aria-hidden={!open}>
        {free
          ? "M · F · L · T switch tools · hold ⌘ move · ⌃ forward · ⌥ look"
          : "O · P · Z switch tools · hold ⌘ pan · ⌃ zoom · ⌥ orbit"}
      </div>
    </div>
  );
}

/** Whether the armed tool belongs to the doc's mode; the overlay stands down otherwise rather than applying an orbit drag to a free pose. */
export function toolMatchesMode(tool: CameraTool | null, mode: "orbit" | "rig"): boolean {
  if (!tool) return false;
  return isFreeTool(tool) === (mode === "rig");
}
