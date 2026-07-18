import { type CameraTool, useCameraEditStore } from "../engine/cameraEditStore";
import { useClockStore } from "../engine/clock";
import type { LoadedProject } from "../engine/project";
import { defaultOrbitPose } from "../engine/sceneCamera";
import { nearestKey, setKeyPose } from "../engine/sceneCameraEdit";
import type { SceneDoc, SceneDocCameraPose } from "../engine/sceneDocSchema";
import { useCameraDoc } from "./cameraDoc";

/** Floating camera control pill: idle "Animate scene" opens animation mode via `cameraEditStore.open`; active state offers Orbit/Pan/Zoom tools with a contextual hint or the zoom stepper. The zoom stepper edits the selected-else-nearest key's `distance` through the same `useCameraDoc.commit` as other camera edits; 100% is the scene-default pose's distance. */

const ZOOM_STEP_PCT = 10;

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
  const { slot, camera, commit, appliedPoseAt } = useCameraDoc(project, sceneIndex, onDocChanged);

  // The zoom target: the selected-else-nearest key (the inspector's derive-don't-subscribe pattern; re-render on the target key, coarse buckets when trackless).
  const selectedKeyId = useCameraEditStore((s) => s.selectedKeyId);
  const targetKeyId = useClockStore((s) => {
    if (camera.keys.length === 0) return null;
    const local = Math.min(slot.durationMs, Math.max(0, s.currentMs - slot.startMs));
    return (
      (camera.keys.find((k) => k.id === selectedKeyId) ?? nearestKey(camera, local))?.id ?? null
    );
  });
  const coarseLocal = useClockStore((s) =>
    camera.keys.length === 0
      ? Math.round(Math.min(slot.durationMs, Math.max(0, s.currentMs - slot.startMs)) / 250) * 250
      : 0,
  );
  const targetKey = camera.keys.find((k) => k.id === targetKeyId) ?? null;
  const pose: SceneDocCameraPose = targetKey?.pose ?? appliedPoseAt(coarseLocal);

  const baseDistance = defaultOrbitPose().distance;
  const zoomPct = Math.round((baseDistance / Math.max(0.001, pose.distance)) * 100);

  const stepZoom = (direction: 1 | -1) => {
    const nextPct = Math.max(20, Math.min(400, zoomPct + direction * ZOOM_STEP_PCT));
    if (nextPct === zoomPct) return;
    const distance = Math.min(50, Math.max(0.5, (baseDistance * 100) / nextPct));
    const next: SceneDocCameraPose = { ...pose, target: [...pose.target], distance };
    if (targetKey) {
      const cam = setKeyPose(camera, targetKey.id, next);
      if (cam) void commit(cam);
    } else {
      // Empty track: a lone key at 0 = static reframe (the overlay's seed).
      void commit({ keys: [{ id: "k1", tMs: 0, pose: next }], segments: [] });
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

  const contextual =
    armedTool === "zoom" ? (
      <span className="camera-pill-zoom">
        <button
          type="button"
          className="camera-pill-step"
          aria-label="Zoom out"
          onClick={() => stepZoom(-1)}
        >
          −
        </button>
        <span className="camera-pill-readout">{zoomPct}%</span>
        <button
          type="button"
          className="camera-pill-step"
          aria-label="Zoom in"
          onClick={() => stepZoom(1)}
        >
          +
        </button>
      </span>
    ) : (
      <span className="camera-pill-blurb">
        {armedTool === "pan" ? "Drag to pan" : "Drag to orbit"}
      </span>
    );

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
            state.armTool("rotate"); // the design's "cameraMode resets to orbit"
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
          <span className="camera-pill-divider" />
          {contextual}
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
        O · P · Z switch tools · hold ⌘ pan · ⌃ zoom · ⌥ orbit
      </div>
    </div>
  );
}
