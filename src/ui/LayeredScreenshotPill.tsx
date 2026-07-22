import { useClockStore } from "../engine/clock";
import {
  type LayeredScreenshotAnimationDoc,
  nearestKey,
  setKeyPose,
} from "../engine/layeredScreenshotAnimationEdit";
import {
  type LayeredScreenshotTool,
  useLayeredScreenshotEditStore,
} from "../engine/layeredScreenshotEditStore";
import type { LoadedProject } from "../engine/project";
import type { LayeredScreenshotPose, SceneDoc } from "../engine/sceneDocSchema";
import { blockWithAnimation } from "./LayeredScreenshotAnimationLane";
import { useLayeredScreenshotDoc } from "./layeredScreenshotDoc";

/** Floating stack control pill (the CameraPill pattern for scenes whose animated track is the layered screenshot): idle "Animate stack" opens the lane; active state offers Orbit/Pan/Zoom/Spread with a zoom stepper or spread stepper as the contextual control, editing the selected-else-nearest key (or the rest pose when the scene isn't animated). */

const ZOOM_STEP_PCT = 10;
const SPREAD_STEP = 0.1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function LayeredScreenshotPill({
  project,
  sceneIndex,
  onDocChanged,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
}) {
  const open = useLayeredScreenshotEditStore((s) => s.laneOpen);
  const armedTool = useLayeredScreenshotEditStore((s) => s.armedTool);
  const { doc, block, commit, appliedPoseAt } = useLayeredScreenshotDoc(
    project,
    sceneIndex,
    onDocChanged,
  );
  const slot = project.slots[sceneIndex];
  const animated = doc?.animatedTrack === "layeredScreenshot";
  const track: LayeredScreenshotAnimationDoc = block.animation ?? { keys: [], segments: [] };

  // The stepper target: the selected-else-nearest key (re-render on the target key, coarse buckets otherwise).
  const selectedKeyId = useLayeredScreenshotEditStore((s) => s.selectedKeyId);
  const targetKeyId = useClockStore((s) => {
    if (!animated || track.keys.length === 0) return null;
    const local = Math.min(slot.durationMs, Math.max(0, s.currentMs - slot.startMs));
    return (track.keys.find((k) => k.id === selectedKeyId) ?? nearestKey(track, local))?.id ?? null;
  });
  const coarseLocal = useClockStore((s) =>
    animated && track.keys.length > 0
      ? 0
      : Math.round(Math.min(slot.durationMs, Math.max(0, s.currentMs - slot.startMs)) / 250) * 250,
  );
  const targetKey = track.keys.find((k) => k.id === targetKeyId) ?? null;
  const pose: LayeredScreenshotPose =
    targetKey?.pose ?? (animated ? appliedPoseAt(coarseLocal) : block.pose);

  /** Commit `next` through the pill's target: the key when animated, else the rest pose. */
  const commitPose = (next: LayeredScreenshotPose) => {
    if (animated) {
      if (targetKey) {
        const t = setKeyPose(track, targetKey.id, next);
        if (t) void commit(blockWithAnimation(block, t));
      } else {
        // Empty track: a lone key at 0 = static reframe (the overlay's seed).
        void commit(
          blockWithAnimation(block, { keys: [{ id: "k1", tMs: 0, pose: next }], segments: [] }),
        );
        useLayeredScreenshotEditStore.getState().selectKey("k1", null);
      }
    } else {
      void commit({ ...block, pose: next });
    }
  };

  const zoomPct = Math.round(pose.zoom * 100);
  const stepZoom = (direction: 1 | -1) => {
    const nextPct = clamp(zoomPct + direction * ZOOM_STEP_PCT, 20, 400);
    if (nextPct === zoomPct) return;
    commitPose({ ...pose, pan: [...pose.pan], zoom: nextPct / 100 });
  };
  const stepSpread = (direction: 1 | -1) => {
    const next = clamp(Math.round((pose.spread + direction * SPREAD_STEP) * 10) / 10, 0, 1);
    if (next === pose.spread) return;
    commitPose({ ...pose, pan: [...pose.pan], spread: next });
  };

  const armTool = useLayeredScreenshotEditStore.getState().armTool;
  const modeButton = (tool: LayeredScreenshotTool, label: string, glyph: React.ReactNode) => (
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
    value: string,
    onStep: (direction: 1 | -1) => void,
    outLabel: string,
    inLabel: string,
  ) => (
    <span className="camera-pill-zoom">
      <button
        type="button"
        className="camera-pill-step"
        aria-label={outLabel}
        onClick={() => onStep(-1)}
      >
        −
      </button>
      <span className="camera-pill-readout">{value}</span>
      <button
        type="button"
        className="camera-pill-step"
        aria-label={inLabel}
        onClick={() => onStep(1)}
      >
        +
      </button>
    </span>
  );

  const contextual =
    armedTool === "zoom" ? (
      stepper(`${zoomPct}%`, stepZoom, "Zoom out", "Zoom in")
    ) : armedTool === "spread" ? (
      stepper(`${Math.round(pose.spread * 100)}%`, stepSpread, "Flatten", "Fan out")
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
            const state = useLayeredScreenshotEditStore.getState();
            state.setLaneOpen(true);
            state.armTool("rotate");
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
            <path d="M10 2.5l7 3.5-7 3.5-7-3.5 7-3.5z" />
            <path d="M3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5" />
          </svg>
          Animate stack
        </button>

        <div className="camera-pill-active" aria-hidden={!open}>
          {modeButton(
            "rotate",
            "Orbit (O): drag in the preview to tilt the stack (or hold ⌥ while dragging)",
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
            "Pan (P): drag in the preview to slide the stack (or hold ⌘ while dragging)",
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
            "Zoom (Z): drag vertically in the preview to zoom the stack (or hold ⌃ while dragging)",
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
          {modeButton(
            "spread",
            "Spread (S): drag vertically in the preview to fan the layers out",
            <svg
              width="16"
              height="16"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M4 6.5h12M4 10h12M4 13.5h12" />
              <path d="M10 2.5v2M10 15.5v2M10 2.5l-1.5 1.5M10 2.5L11.5 4M10 17.5L8.5 16M10 17.5l1.5-1.5" />
            </svg>,
          )}
          <span className="camera-pill-divider" />
          {contextual}
          <button
            type="button"
            className="camera-pill-close"
            title="Done animating (closes the lane)"
            aria-label="Close animation mode"
            onClick={() => useLayeredScreenshotEditStore.getState().setLaneOpen(false)}
          >
            ×
          </button>
        </div>
      </div>
      <div className={`camera-pill-hint${open ? " visible" : ""}`} aria-hidden={!open}>
        O · P · Z · S switch tools · hold ⌘ pan · ⌃ zoom · ⌥ orbit
      </div>
    </div>
  );
}
