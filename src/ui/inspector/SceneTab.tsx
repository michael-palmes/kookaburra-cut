import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useCameraEditStore } from "../../engine/cameraEditStore";
import { useClockStore } from "../../engine/clock";
import { useDecorationEditStore } from "../../engine/decorationEditStore";
import { pushHistory } from "../../engine/history";
import { fsUrl, type MediaMeta } from "../../engine/media";
import { optionPreviewClip, optionPreviewStill } from "../../engine/optionPreviews";
import { type LoadedProject, sceneFileStem, workspaceProjectPath } from "../../engine/project";
import { readProjectManifestSnapshot, updateSceneTransition } from "../../engine/projectEdit";
import { defaultOrbitPose } from "../../engine/sceneCamera";
import { nearestKey, setKeyPose } from "../../engine/sceneCameraEdit";
import { applyBackgroundToAllScenes } from "../../engine/sceneDoc";
import type { SceneDoc, SceneDocCameraPose, SceneTextAlign } from "../../engine/sceneDocSchema";
import { useLargestSceneText, useSceneTextRegistry } from "../../engine/sceneTextRegistry";
import { listCachedSceneThumbs } from "../../engine/sceneThumbs";
import { captureCurrentFrame } from "../../engine/snapshots";
import { useSceneStageBackdrop } from "../../engine/stageRegistry";
import { ensureFontRefsPinned } from "../../engine/systemFonts";
import {
  textKeyColorDefaults,
  textKeyStyleCapable,
  textKeysConsumedBy,
} from "../../engine/textKeyRegistry";
import { useSceneHasCodedTextMotion } from "../../engine/textMotionRegistry";
import { DEFAULT_LOOP_BLEND_MS } from "../../present/cameraLoop";
import { useUiStore } from "../../store/uiStore";
import { formatFontString, parseFontString } from "../../theme/fontRef";
import { preloadAppFonts } from "../../theme/fonts";
import type { TextAnimationSpec, Theme, ThemeBackdrop, ThemeBackground } from "../../theme/tokens";
import { DEVICE_CATALOG, type DeviceId, isDeviceId } from "../../toolkit/device/catalog";
import type { DeviceShadowMode } from "../../toolkit/device/Device";
import { CHIP_ICON_IDS, type ChipIconId, resolveChipIconId } from "../../toolkit/frame/chipIcons";
import type {
  FrameChipSpec,
  FrameCutoutSpec,
  FrameDecorationLayer,
  FrameDecorationShape,
  FrameDecorationSpec,
  FrameShape,
  FrameSide,
} from "../../toolkit/frame/types";
import {
  SHADER_BACKGROUND_IDS,
  SHADER_BACKGROUND_PRESETS,
  SHADER_BACKGROUNDS,
  type ShaderBackgroundPreset,
} from "../../toolkit/stage/shaders";
import {
  emojiRasterVersion,
  subscribeEmojiRasters,
  unrenderableEmojiClusters,
} from "../../toolkit/text/emojiRaster";
import { prepareEmojiText } from "../../toolkit/text/emojiText";
import { findUnrenderableChars } from "../../toolkit/text/textCoverage";
import { useCameraDoc } from "../cameraDoc";
import { ColourPicker } from "../colour/ColourPicker";
import { FontPicker } from "../FontPicker";
import { GradientPickerModal } from "../GradientPicker";
import { sceneSections } from "../inspectorOptions";
import { AddMediaButton, MediaBrowser } from "../MediaBrowser";
import { mediaCardMenu } from "../mediaCardMenu";
import { OptionCard } from "../OptionCard";
import { TextFieldRow } from "../SceneTextFields";
import { SHADOW_OPTIONS } from "../SceneWizards";
import { backgroundOptions, toggleDrift } from "../stageOptions";
import { DebouncedRange, TextMotionPanel } from "../TextAnimationPicker";
import { listThemeChoices, type ThemeChoice, ThemeGrid } from "../ThemePicker";
import { TransitionModal } from "../TransitionPicker";
import { describeSpec } from "../textAnimationOptions";
import { useThemeCardMenu } from "../themeCardMenu";
import { useEscapeClose } from "../useEscapeClose";
import { useSceneDocPatch } from "../useSceneDocPatch";
import { DeviceDrillIn } from "./DeviceDrillIn";
import { RotationDrillIn } from "./RotationDrillIn";
import { ActionRow, DrillBack, NumericField, SectionHeader } from "./rows";

/** The inspector's Scene tab: collapsible sections over the playhead's dominant scene, every edit riding the same `useSceneDocPatch` funnel the EditBar uses. Section/row structure comes from the pinned `sceneSections` model. The header thumb is read from `listCachedSceneThumbs` only, never a capture, to avoid the clock-borrow playhead-blip class. */

const FRAME_SHAPES: FrameShape[] = ["rect", "rounded-rect", "squircle", "circle", "capsule"];
const FRAME_SHAPE_LABELS: Record<FrameShape, string> = {
  rect: "Rectangle",
  "rounded-rect": "Rounded",
  squircle: "Squircle",
  circle: "Circle",
  capsule: "Capsule",
};

/** Scene-row icons: same 20-viewBox stroke style as the Project tab. */
function SceneRowIcon({ id }: { id: string }) {
  switch (id) {
    case "text.edit":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M5 6h10M10 6v9" />
        </svg>
      );
    case "device.media":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <circle cx="8" cy="9" r="1.3" />
          <path d="M4 14l4-3 4 3 3-2" />
        </svg>
      );
    case "device.editVideo":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="14" height="10" rx="2" />
          <path d="M8 8l5 2-5 2z" fill="currentColor" stroke="none" />
        </svg>
      );
    case "device.change":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="6" y="3" width="8" height="14" rx="1.8" />
          <path d="M9 15.5h2" />
        </svg>
      );
    case "device.add":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="4" y="3" width="8" height="14" rx="1.8" />
          <path d="M15 12v5M12.5 14.5h5" />
        </svg>
      );
    case "text.add":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 6h8M8 6v9" />
          <path d="M15 12v5M12.5 14.5h5" />
        </svg>
      );
    case "device.rotation":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="7" y="5" width="6" height="11" rx="1.4" />
          <path d="M3 9a7.5 4.5 0 0114 0" opacity="0.7" />
          <path d="M15.5 7l1.5 2-2.4.3" />
        </svg>
      );
    case "device.lid":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M5 13V6.5A1.5 1.5 0 016.5 5h7A1.5 1.5 0 0115 6.5V13" />
          <path d="M3 15h14" />
        </svg>
      );
    case "device.remove":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 6h12M8 6V4.5A1.5 1.5 0 019.5 3h1A1.5 1.5 0 0112 4.5V6m2.5 0l-.7 9.2A1.5 1.5 0 0112.3 17H7.7a1.5 1.5 0 01-1.5-1.8L5.5 6" />
        </svg>
      );
    case "text.motion":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M8 6h9M8 10h9M8 14h9M3 6h1.5M4 10h1.5M5 14h1.5" />
        </svg>
      );
    case "style.theme":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M10 3s5 5.5 5 8.5a5 5 0 01-10 0C5 8.5 10 3 10 3z" />
        </svg>
      );
    case "style.background":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="M3 12l4-3.5 4 4 2.5-2 3.5 3" />
        </svg>
      );
    case "style.shadow":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="10" cy="8" r="4" />
          <ellipse cx="10" cy="15.5" rx="5.5" ry="1.5" opacity="0.55" />
        </svg>
      );
    case "motion.duration":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="6.5" />
          <path d="M10 6.5V10l2.5 2" />
        </svg>
      );
    case "camera.animate":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="6" width="10" height="8" rx="1.5" />
          <path d="M13 9l4-2.2v6.4L13 11" />
        </svg>
      );
    case "motion.transition":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="7" height="10" rx="1.2" />
          <rect x="10" y="5" width="7" height="10" rx="1.2" opacity="0.45" />
        </svg>
      );
    case "frame.enabled":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="3.5" width="14" height="13" rx="2" />
          <rect x="5.5" y="6" width="5" height="8" rx="1" opacity="0.5" />
        </svg>
      );
    case "frame.cutout":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="3.5" width="14" height="13" rx="2" />
          <rect x="5.5" y="6" width="5.5" height="8" rx="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "frame.panel":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="3.5" width="14" height="13" rx="2" />
          <circle cx="13" cy="10" r="2.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "frame.chip":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="2.5" y="6.5" width="15" height="7" rx="3.5" />
          <path d="M6 10l1.6 1.6L11 8.4" />
        </svg>
      );
    case "frame.decorations":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="6" width="10" height="10" rx="2" />
          <path d="M5 14l2.5-2.5 1.8 1.8" />
          <circle cx="14.5" cy="6" r="2.6" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

/** Inline seconds field (2 dp; committing flips the scene to manual), the EditBar's DurationField, restyled for the panel. */
function DurationRow({
  durationMs,
  mode,
  onCommit,
}: {
  durationMs: number;
  mode: string | null;
  onCommit: (ms: number) => void;
}) {
  const [text, setText] = useState((durationMs / 1000).toFixed(2));
  useEffect(() => setText((durationMs / 1000).toFixed(2)), [durationMs]);
  const commit = () => {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0.1) {
      setText((durationMs / 1000).toFixed(2));
      return;
    }
    const ms = Math.round(seconds * 1000);
    if (ms !== durationMs) onCommit(ms);
  };
  return (
    <div className="inspector-duration-row" title="Scene length in seconds (switches to manual)">
      <span className="action-row-icon">
        <SceneRowIcon id="motion.duration" />
      </span>
      <span className="action-row-label">Duration</span>
      {mode && <span className="action-row-value">{mode}</span>}
      <input
        className="modal-input inspector-num inspector-seconds"
        value={text}
        inputMode="decimal"
        aria-label="Scene duration in seconds"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText((durationMs / 1000).toFixed(2));
        }}
      />
      <span className="inspector-unit">s</span>
    </div>
  );
}

/** Inline lid-angle slider row (laptops only): live-drags locally, commits once on release. */
function LidRow({
  lidDeg,
  openDeg,
  onCommit,
}: {
  lidDeg: number;
  openDeg: number;
  onCommit: (deg: number) => void;
}) {
  const [v, setV] = useState(lidDeg);
  useEffect(() => setV(lidDeg), [lidDeg]);
  const commit = () => {
    if (v !== lidDeg) onCommit(v);
  };
  return (
    <div className="inspector-duration-row" title="Lid opening in degrees (0 closes the laptop)">
      <span className="action-row-icon">
        <SceneRowIcon id="device.lid" />
      </span>
      <span className="action-row-label">Lid angle</span>
      <input
        type="range"
        min={0}
        max={openDeg}
        step={1}
        value={v}
        aria-label="Lid angle in degrees"
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="inspector-unit">{`${Math.round(v)}°`}</span>
    </div>
  );
}

/** Inline toggle row for whether this scene shows the deck overlay: off writes `frame.enabled: false`, on clears it back to the deck default. */
function FrameEnabledRow({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <label className="inspector-duration-row" title="Show the deck's overlay panel on this scene">
      <span className="action-row-icon">
        <SceneRowIcon id="frame.enabled" />
      </span>
      <span className="action-row-label">Show on this scene</span>
      <input
        type="checkbox"
        checked={on}
        aria-label="Show the overlay on this scene"
        onChange={(e) => onToggle(e.target.checked)}
      />
    </label>
  );
}

/** Cutout-shape tiles, the `BgTypeIcon` sibling scoped to `FrameShape`. */
function FrameShapeIcon({ id }: { id: FrameShape }) {
  const shape = {
    rect: <rect x="4" y="4" width="12" height="12" />,
    "rounded-rect": <rect x="4" y="4" width="12" height="12" rx="3" />,
    squircle: <path d="M10 4c4.5 0 6 1.5 6 6s-1.5 6-6 6-6-1.5-6-6 1.5-6 6-6z" />,
    circle: <circle cx="10" cy="10" r="6.5" />,
    capsule: <rect x="3" y="6" width="14" height="8" rx="4" />,
  }[id];
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {shape}
    </svg>
  );
}

/** Small glyphs for the cutout sliders (size / corner radius / inset). */
function CutoutSliderIcon({ id }: { id: "size" | "radius" | "inset" }) {
  const glyph = {
    size: (
      <>
        <path d="M4 8V4h4" />
        <path d="M16 12v4h-4" />
      </>
    ),
    radius: <path d="M5 16V9a4 4 0 0 1 4-4h7" />,
    inset: (
      <>
        <rect x="3" y="3" width="14" height="14" rx="1.5" />
        <rect x="6.5" y="6.5" width="7" height="7" rx="1" opacity="0.55" />
      </>
    ),
  }[id];
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}

/** Inline SVG previews for the chip icon set (the same Lucide paths the render's PNGs were rasterised from), tinted via currentColor. */
const CHIP_ICON_GLYPHS: Record<ChipIconId, ReactNode> = {
  "circle-check": (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  "triangle-alert": (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  "circle-x": (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  star: (
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ),
};

function ChipIconPreview({ id }: { id: ChipIconId }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {CHIP_ICON_GLYPHS[id]}
    </svg>
  );
}

/** Quick status styles: each seeds the chip's label, colour and icon together. */
const CHIP_PRESETS: { id: string; label: string; colour: string; icon: ChipIconId }[] = [
  { id: "released", label: "Released", colour: "#2fb170", icon: "circle-check" },
  { id: "testing", label: "In testing", colour: "#3b82f6", icon: "circle-check" },
  { id: "warning", label: "Warning", colour: "#e0a020", icon: "triangle-alert" },
  { id: "error", label: "Error", colour: "#e05656", icon: "circle-x" },
];

/** A decoration's display name: its asset basename. */
function decorationLabel(src: string): string {
  return src.split("/").pop() || src;
}

/** A unique decoration id from a picked asset's stem, deduped against the existing ids. */
function nextDecorationId(src: string, taken: Set<string>): string {
  const stem = decorationLabel(src).replace(/\.[^.]+$/, "") || "decoration";
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/** The Camera section body: orbit-pose numerics (decision 5, the real model, not the mock's pos/rot) editing the selected-else-nearest key via `setKeyPose` → `useCameraDoc.commit` (history rides "camera edit" for free); an empty track commits a lone key at 0, the whole-scene static reframe, exactly the CameraToolOverlay's seed. */
function CameraSectionBody({
  project,
  sceneIndex,
  onDocChanged,
  collapsed,
  onToggle,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { slot, camera, commit, appliedPoseAt } = useCameraDoc(project, sceneIndex, onDocChanged);
  const selectedKeyId = useCameraEditStore((s) => s.selectedKeyId);
  const cameraOpen = useCameraEditStore((s) => s.open);
  // Re-render only when the target key changes, not per playhead tick; for a trackless scene, follow the playhead in coarse quarter-second buckets (display only, commits snapshot the live clock).
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

  const commitPose = (mutate: (p: SceneDocCameraPose) => void) => {
    const next: SceneDocCameraPose = { ...pose, target: [...pose.target] };
    mutate(next);
    if (targetKey) {
      const cam = setKeyPose(camera, targetKey.id, next);
      if (cam) void commit(cam);
    } else {
      // Empty track: a lone key at 0 = static reframe (the overlay's seed).
      void commit({ keys: [{ id: "k1", tMs: 0, pose: next }], segments: [] });
      useCameraEditStore.getState().select("k1", null);
    }
  };

  /** Per-key Reset (decision 6, moved here from the old strip's tools row): the selected-else-nearest key back to the scene-default pose. */
  const onResetKey = () => {
    if (!targetKey) return;
    const cam = setKeyPose(camera, targetKey.id, defaultOrbitPose());
    if (cam) void commit(cam);
  };

  return (
    <>
      <SectionHeader
        label="Camera"
        collapsed={collapsed}
        onToggle={onToggle}
        trailing={
          camera.keys.length > 0 ? (
            <button
              type="button"
              className="inspector-reset-btn"
              title="Reset this key to the scene-default pose"
              onClick={(e) => {
                e.stopPropagation();
                onResetKey();
              }}
            >
              Reset
            </button>
          ) : undefined
        }
      />
      {collapsed ? null : (
        <div className="inspector-section-body">
          <div className="inspector-pose-grid">
            <NumericField
              label="orbit °"
              value={pose.azimuthDeg}
              decimals={1}
              onCommit={(n) => commitPose((p) => (p.azimuthDeg = n))}
            />
            <NumericField
              label="tilt °"
              value={pose.elevationDeg}
              decimals={1}
              onCommit={(n) => commitPose((p) => (p.elevationDeg = n))}
            />
            <NumericField
              label="distance"
              value={pose.distance}
              decimals={2}
              onCommit={(n) => commitPose((p) => (p.distance = n))}
            />
          </div>
          <div className="inspector-pose-grid">
            <NumericField
              label="target x"
              value={pose.target[0]}
              decimals={2}
              onCommit={(n) => commitPose((p) => (p.target[0] = n))}
            />
            <NumericField
              label="target y"
              value={pose.target[1]}
              decimals={2}
              onCommit={(n) => commitPose((p) => (p.target[1] = n))}
            />
            <NumericField
              label="target z"
              value={pose.target[2]}
              decimals={2}
              onCommit={(n) => commitPose((p) => (p.target[2] = n))}
            />
          </div>
          <ActionRow
            icon={<SceneRowIcon id="camera.animate" />}
            label="Animate scene"
            value={
              camera.keys.length > 0
                ? `${camera.keys.length} key${camera.keys.length === 1 ? "" : "s"}`
                : undefined
            }
            selected={cameraOpen}
            onClick={() => useCameraEditStore.getState().setOpen(!cameraOpen)}
          />
          {camera.keys.length > 1 && (
            <>
              <div className="popover-row">
                <label
                  className="popover-inline"
                  title="While a slideshow holds, loop the camera back to its first key; video playback and export are untouched"
                >
                  <input
                    type="checkbox"
                    checked={camera.presentLoop !== undefined}
                    onChange={(e) => {
                      if (e.target.checked) {
                        void commit({
                          ...camera,
                          presentLoop: { mode: "smooth", blendMs: DEFAULT_LOOP_BLEND_MS },
                        });
                      } else {
                        const { presentLoop: _drop, ...rest } = camera;
                        void commit(rest);
                      }
                    }}
                  />
                  Loop in Present
                </label>
              </div>
              {camera.presentLoop && (
                <div className="popover-row">
                  <button
                    type="button"
                    className={`chip${camera.presentLoop.mode === "smooth" ? " selected" : ""}`}
                    title="Ease back to the first key, then replay"
                    onClick={() =>
                      void commit({
                        ...camera,
                        presentLoop: {
                          mode: "smooth",
                          blendMs: camera.presentLoop?.blendMs ?? DEFAULT_LOOP_BLEND_MS,
                        },
                      })
                    }
                  >
                    Smooth
                  </button>
                  <button
                    type="button"
                    className={`chip${camera.presentLoop.mode === "jump" ? " selected" : ""}`}
                    title="Jump cut back to the first key each cycle"
                    onClick={() => void commit({ ...camera, presentLoop: { mode: "jump" } })}
                  >
                    Jump
                  </button>
                  {camera.presentLoop.mode === "smooth" && (
                    <NumericField
                      label="blend s"
                      value={(camera.presentLoop.blendMs ?? DEFAULT_LOOP_BLEND_MS) / 1000}
                      decimals={1}
                      onCommit={(n) =>
                        void commit({
                          ...camera,
                          presentLoop: {
                            mode: "smooth",
                            blendMs: Math.max(100, Math.round(n * 1000)),
                          },
                        })
                      }
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Alignment chips for the text.edit drill-in; UI labels use Australian spelling, the stored value is always troika's "center". */
const ALIGN_OPTIONS: { id: SceneTextAlign; label: string }[] = [
  { id: "left", label: "Left" },
  { id: "center", label: "Centre" },
  { id: "right", label: "Right" },
];

/** Background fill-type icons for the drill-in's tile grid; same 20-viewBox stroke style as SceneRowIcon. */
function BgTypeIcon({ id }: { id: string }) {
  switch (id) {
    case "none":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="6.5" />
          <path d="M5.5 14.5l9-9" />
        </svg>
      );
    case "color":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="6.5" />
          <circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "gradient":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3.5" y="3.5" width="13" height="13" rx="2" />
          <path d="M3.5 13L13 3.5M7 16.5L16.5 7" />
        </svg>
      );
    case "shader":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M3 12.5c2.3-5 4.7-5 7 0s4.7 5 7 0" />
          <path d="M3 8c2.3-5 4.7-5 7 0s4.7 5 7 0" opacity="0.45" />
        </svg>
      );
    case "image":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <circle cx="8" cy="9" r="1.3" />
          <path d="M4 14l4-3 4 3 3-2" />
        </svg>
      );
    case "video":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="14" height="10" rx="2" />
          <path d="M8.5 8l4 2-4 2z" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

export function SceneTab({
  project,
  sceneIndex,
  sceneTheme,
  onOpenEditVideo,
  onDocChanged,
  onTimingChanged,
  onReplayScene,
  onReplaySessionEnd,
  onOpenTheme,
  onEditThemeInClaude,
  onThemeEdited,
  themesRefreshKey,
  onDeleteScene,
}: {
  project: LoadedProject;
  sceneIndex: number;
  sceneTheme: Theme | undefined;
  onOpenEditVideo: (sceneIndex: number, mediaRel: string, slot?: "device" | "background") => void;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onTimingChanged: () => void;
  /** Play [startMs, endMs) once, then pause; the text-motion panel's live preview. */
  onReplayScene: (startMs: number, endMs: number) => void;
  /** The text-motion panel closed (any path); App returns the playhead. */
  onReplaySessionEnd: () => void;
  /** Open ThemeMode, optionally on a pane (the theme context menu). */
  onOpenTheme: (manage?: { view: "fonts" | "duplicate"; themeId: string }) => void;
  onEditThemeInClaude: (choice: { id: string; name: string }) => void;
  onThemeEdited: (wsId: string, json: string) => Promise<void>;
  themesRefreshKey: number;
  /** Trash-recoverable scene removal (the bottom Delete row; Rust guards the last scene). */
  onDeleteScene: (sceneIndex: number) => void;
}) {
  const { slug, doc, scene, error, setError, patchDoc, commitDuration } = useSceneDocPatch(
    project,
    sceneIndex,
    onDocChanged,
    onTimingChanged,
  );
  const drillIn = useUiStore((s) => s.inspector.drillIn);
  const setDrillIn = useUiStore((s) => s.setInspectorDrillIn);
  const selectedDecoId = useDecorationEditStore((s) => s.selectedId);
  const selectDeco = useDecorationEditStore((s) => s.select);
  const decoMediaRequestId = useDecorationEditStore((s) => s.mediaRequestId);
  const requestDecoMedia = useDecorationEditStore((s) => s.requestMedia);
  // The gizmo's "Change media" action routes through here to reuse the scene media picker.
  useEffect(() => {
    if (!decoMediaRequestId) return;
    setMediaTarget({ kind: "decoration", replaceId: decoMediaRequestId });
    setModal("media");
    requestDecoMedia(null);
  }, [decoMediaRequestId, requestDecoMedia]);
  const collapsed = useUiStore((s) => s.inspector.collapsed);
  const toggleSection = useUiStore((s) => s.toggleInspectorSection);

  const [modal, setModal] = useState<"media" | null>(null);
  // What a media pick targets: the scene device, or a decoration (append, or replace one by id).
  const [mediaTarget, setMediaTarget] = useState<
    { kind: "device" } | { kind: "decoration"; replaceId?: string }
  >({ kind: "device" });
  const [thumbs, setThumbs] = useState<Record<string, string> | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The bottom Delete-scene row's two-step confirm (the house self-disarming pattern).
  const [confirmDeleteScene, setConfirmDeleteScene] = useState(false);
  const [confirmApplyAll, setConfirmApplyAll] = useState(false);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  /** Header preview fallback: a current-frame capture when no cached thumb exists. An object URL, revoked on replacement/unmount. */
  const [liveThumb, setLiveThumb] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  /** Background drill: viewing the Gradient/Image/Video tab before anything is committed; every other tab derives from the doc itself. */
  const [bgTabOverride, setBgTabOverride] = useState<
    "gradient" | "image" | "video" | "shader" | null
  >(null);
  /** Which animated-fill card is hovered (its clip preview plays). */
  const [bgHover, setBgHover] = useState<string | null>(null);
  /** The spec + force flag captured when the text-motion drill-in opened; Cancel restores both, back/Esc = Done semantics. */
  const textAnimOriginal = useRef<{ spec: TextAnimationSpec | undefined; force: boolean }>({
    spec: undefined,
    force: false,
  });
  const codedMotion = useSceneHasCodedTextMotion(sceneIndex);
  /** The mounted stage's resolved backdrop type; null when the scene mounts no SceneStage. */
  const stagedBackdrop = useSceneStageBackdrop(sceneIndex);
  const [themeChoices, setThemeChoices] = useState<ThemeChoice[]>([]);
  const [themeDraft, setThemeDraft] = useState<string>("");

  const device = doc?.devices?.[0];
  const sceneFile = project.sceneFiles[sceneIndex];
  const stem = sceneFile ? sceneFileStem(sceneFile) : null;
  // Default scene name: the sidecar name, else the scene's largest mounted text (the live registry), else the file stem.
  const derivedName = useLargestSceneText(sceneIndex);
  const sceneTitle = doc?.name ?? derivedName ?? stem ?? `Scene ${sceneIndex + 1}`;

  // Unrenderable characters in this scene's mounted text: coverage misses against the theme faces + symbols fallback, plus emoji the system font could not raster. Editor-only; the export path never reads this.
  const sceneTexts = useSceneTextRegistry((s) => s.texts[sceneIndex]);
  useSyncExternalStore(subscribeEmojiRasters, emojiRasterVersion);
  const badgeTheme = sceneTheme ?? project.theme;
  const unrenderableChars = new Set<string>();
  for (const entry of Object.values(sceneTexts ?? {})) {
    const families = [badgeTheme.typography.headline.family, badgeTheme.typography.body.family];
    for (const ch of findUnrenderableChars(entry.text, families)) unrenderableChars.add(ch);
    for (const cluster of prepareEmojiText(entry.text).clusters) {
      if (unrenderableEmojiClusters().has(cluster.key)) unrenderableChars.add(cluster.cluster);
    }
  }

  // Header thumb: read-only cache, keyed by scene file stem; missing = swatch.
  useEffect(() => {
    let cancelled = false;
    void listCachedSceneThumbs(project).then((t) => {
      if (!cancelled) setThumbs(t);
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  // No cached thumb → grab the current frame (no seek, no clock borrow, the blip class can't occur); one capture per scene visit, once the cache listing is in.
  const cachedThumb = thumbs && stem ? thumbs[stem] : undefined;
  useEffect(() => {
    void sceneIndex; // one fresh capture per scene visit
    if (thumbs === null || cachedThumb) return;
    let cancelled = false;
    void captureCurrentFrame(640).then((bytes) => {
      if (cancelled || !bytes) return;
      const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "image/jpeg" }));
      setLiveThumb((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [thumbs, cachedThumb, sceneIndex]);
  useEffect(
    () => () => {
      setLiveThumb((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    },
    [],
  );

  // Collapse transient state when the playhead moves to another scene.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate reset-on-scene
  useEffect(() => {
    setModal(null);
    setConfirmRemove(false);
    setDrillIn(null);
    setRenaming(false);
    setBgTabOverride(null);
    setLiveThumb((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [sceneIndex, setDrillIn]);

  // The remove confirmation disarms itself (the EditBar pattern).
  useEffect(() => {
    if (!confirmRemove) return;
    const t = window.setTimeout(() => setConfirmRemove(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmRemove]);

  // The Delete-scene confirmation disarms itself, and on any scene change.
  useEffect(() => {
    if (!confirmDeleteScene) return;
    const t = window.setTimeout(() => setConfirmDeleteScene(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmDeleteScene]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate disarm on scene change
  useEffect(() => setConfirmDeleteScene(false), [sceneIndex]);
  useEffect(() => {
    if (!confirmApplyAll) return;
    const t = window.setTimeout(() => setConfirmApplyAll(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmApplyAll]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate disarm on scene change
  useEffect(() => setConfirmApplyAll(false), [sceneIndex]);

  // Drill-ins + inline modals close on Esc like every layer; the text-motion drill-in's Esc keeps the picked spec and returns the playhead (Done semantics, the session-end restore must fire on every close path).
  useEscapeClose(() => {
    if (drillIn === "text.motion") textMotionDone();
    else setDrillIn(null);
  }, drillIn !== null);
  useEscapeClose(() => setModal(null), modal === "media");

  // Re-list theme choices when the drill opens or ThemeMode closes over it: Manage keeps the drill open, so edits must show in place.
  useEffect(() => {
    void themesRefreshKey; // re-list on ThemeMode close
    if (drillIn === "style.theme") void listThemeChoices().then(setThemeChoices);
  }, [drillIn, themesRefreshKey]);

  // The theme-card right-click menu; Apply here means the scene override.
  const themeMenu = useThemeCardMenu({
    onApply: (themeId) => {
      setThemeDraft(themeId);
      void patchDoc((next) => {
        next.themeId = themeId || undefined;
      }).then(onTimingChanged);
    },
    onManage: onOpenTheme,
    onEditInClaude: onEditThemeInClaude,
    onThemeEdited,
    onChanged: () => void listThemeChoices().then(setThemeChoices),
  });

  if (!slug) return null;

  /** Done = keep the picked spec, record one session history entry, restore the playhead (the EditBar's onDone, verbatim). */
  function textMotionDone() {
    if (doc && slug && sceneFile) {
      const orig = textAnimOriginal.current;
      const changed =
        JSON.stringify(doc.textAnimation ?? null) !== JSON.stringify(orig.spec ?? null) ||
        (doc.textAnimationForce === true) !== orig.force;
      if (changed) {
        const before = structuredClone(doc);
        if (orig.spec) before.textAnimation = orig.spec;
        else delete before.textAnimation;
        if (orig.force) before.textAnimationForce = true;
        else delete before.textAnimationForce;
        pushHistory({
          label: "text motion",
          changes: [
            {
              kind: "sceneDoc",
              slug,
              file: sceneFile,
              sceneIndex,
              before,
              after: structuredClone(doc),
            },
          ],
        });
      }
    }
    onReplaySessionEnd();
    setDrillIn(null);
  }

  function textMotionCancel() {
    const orig = textAnimOriginal.current;
    void patchDoc(
      (next) => {
        if (orig.spec) next.textAnimation = orig.spec;
        else delete next.textAnimation;
        if (orig.force) next.textAnimationForce = true;
        else delete next.textAnimationForce;
      },
      { history: false },
    );
    onReplaySessionEnd();
    setDrillIn(null);
  }

  const sceneFrame = project.sceneFrames[sceneIndex];
  const sections = sceneSections({
    doc,
    slotsCount: project.slots.length,
    deckFrame: project.deckFrame !== undefined,
    frame: sceneFrame,
  });
  // The row edits this scene's EXIT (boundary index = the outgoing scene); the last scene remaps to its entrance so the row always means something.
  const boundaryIndex = Math.max(0, Math.min(sceneIndex, project.slots.length - 2));
  const transitionValue =
    project.slots.length > 1
      ? (project.slots[boundaryIndex + 1]?.transitionIn?.type ?? "none")
      : undefined;
  const durationMode =
    doc?.duration?.mode === "manual"
      ? "Manual"
      : doc?.duration?.mode === "follow-media"
        ? "Follows media"
        : null;

  const previewSrc = cachedThumb ? fsUrl(cachedThumb) : liveThumb;

  const commitRename = () => {
    setRenaming(false);
    const trimmed = renameText.trim();
    if (!doc || trimmed === sceneTitle) return;
    void patchDoc(
      (next) => {
        if (trimmed) next.name = trimmed;
        else delete next.name;
      },
      { history: "scene name" },
    );
  };

  /** Commit a video background pick; the card click and the menu's Select share it, and a previously set parallax (Drift) survives the src swap. */
  const selectVideoBackground = (rel: string, meta: MediaMeta | null) => {
    if (meta && meta.kind !== "video") return;
    setBgTabOverride(null);
    void patchDoc((next) => {
      const parallax =
        next.background && next.background.type !== "none" ? next.background.parallax : undefined;
      next.background =
        parallax !== undefined
          ? { type: "video", src: rel, parallax }
          : { type: "video", src: rel };
    });
  };

  const header = (
    <div className="inspector-scene-head">
      <div className="inspector-scene-preview">
        {previewSrc && <img src={previewSrc} alt="" draggable={false} />}
      </div>
      <div className="inspector-scene-id">
        {renaming && doc ? (
          <input
            className="modal-input inspector-scene-rename"
            value={renameText}
            // biome-ignore lint/a11y/noAutofocus: entered by clicking the title — it IS the focus target
            autoFocus
            aria-label="Scene name"
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="inspector-scene-title-btn"
            title={doc ? "Click to rename this scene" : undefined}
            disabled={!doc}
            onClick={() => {
              setRenameText(doc?.name ?? sceneTitle);
              setRenaming(true);
            }}
          >
            <div className="inspector-scene-title">{sceneTitle}</div>
          </button>
        )}
        <div className="inspector-scene-sub">
          {`Scene ${sceneIndex + 1} · ${(scene.durationMs / 1000).toFixed(1)}s`}
        </div>
      </div>
    </div>
  );

  // The media picker, shared by the device-media row and the decorations drill-in. Defined here
  // (not only in the main return) so it renders over a drill-in too, whose early return skips the tail.
  const mediaModal = modal === "media" && (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal wizard-wide media-modal-wide">
        <div className="modal-title-row">
          <h2>{mediaTarget.kind === "decoration" ? "Choose image" : "Change media"}</h2>
          <AddMediaButton
            slug={slug}
            kinds={mediaTarget.kind === "decoration" ? ["image"] : undefined}
            onImported={() => setMediaRefresh((n) => n + 1)}
          />
        </div>
        <div className="wizard-media-host">
          <MediaBrowser
            slug={slug}
            projectPath={workspaceProjectPath(slug) ?? ""}
            kinds={mediaTarget.kind === "decoration" ? ["image"] : undefined}
            kindToggle={mediaTarget.kind === "device"}
            hideAdd
            refreshKey={mediaRefresh}
            onPick={(rel, meta) => {
              setModal(null);
              if (mediaTarget.kind === "device") {
                void patchDoc(
                  (next) => {
                    const d = next.devices?.[0];
                    if (d) {
                      d.media = {
                        ...d.media,
                        src: rel,
                        kind: meta?.kind === "image" ? "image" : "video",
                      };
                    }
                  },
                  { resync: true },
                );
                return;
              }
              const decos = sceneFrame?.decorations ?? [];
              const { replaceId } = mediaTarget;
              const nextDecos: FrameDecorationSpec[] = replaceId
                ? decos.map((d) => (d.id === replaceId ? { ...d, src: rel } : d))
                : [
                    ...decos,
                    {
                      id: nextDecorationId(rel, new Set(decos.map((d) => d.id))),
                      src: rel,
                      position: [0.45, -0.5],
                      size: 0.15,
                      shape: "none",
                      layer: "above",
                    },
                  ];
              void patchDoc((next) => {
                next.frame = { ...(next.frame ?? {}), decorations: nextDecos };
              });
            }}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => setModal(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  // ── Drill-in views ────────────────────────────────────────────────────────
  if (drillIn === "text.motion" && doc) {
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={textMotionDone} />
        <div className="inspector-drill-title">Text motion</div>
        <div className="inspector-drill-body inspector-textmotion">
          <TextMotionPanel
            current={doc.textAnimation}
            theme={sceneTheme}
            codedMotion={codedMotion}
            force={doc.textAnimationForce === true}
            onLive={(spec) =>
              void patchDoc(
                (next) => {
                  if (spec) next.textAnimation = spec;
                  else delete next.textAnimation;
                },
                { history: false },
              )
            }
            onForce={(on) =>
              void patchDoc(
                (next) => {
                  if (on) next.textAnimationForce = true;
                  else delete next.textAnimationForce;
                },
                { history: false },
              )
            }
            onReplay={() => onReplayScene(scene.startMs, scene.startMs + scene.durationMs - 17)}
            onCancel={textMotionCancel}
            onDone={textMotionDone}
          />
        </div>
      </div>
    );
  }
  if (drillIn === "style.theme" && doc) {
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">Scene theme</div>
        <div className="inspector-drill-body">
          <p className="modal-hint">
            Overrides the project theme for THIS scene only — right-click a card for more.
          </p>
          <div className="font-slot-row">
            <button
              type="button"
              className={`chip${themeDraft === "" ? " selected" : ""}`}
              onClick={() => setThemeDraft("")}
            >
              Project theme
            </button>
          </div>
          <ThemeGrid
            choices={themeChoices}
            value={themeDraft}
            onChange={setThemeDraft}
            onCardContextMenu={themeMenu.openMenu}
          />
        </div>
        <div className="inspector-drill-actions">
          <button
            type="button"
            className="btn btn-left"
            title="Duplicate, edit fonts or delete themes"
            onClick={() => onOpenTheme()}
          >
            Manage…
          </button>
          <button type="button" className="btn" onClick={() => setDrillIn(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={themeDraft === (doc.themeId ?? "")}
            onClick={() => {
              setDrillIn(null);
              // Theme resolution bakes at load; the write chains the nonce reload.
              void patchDoc((next) => {
                next.themeId = themeDraft || undefined;
              }).then(onTimingChanged);
            }}
          >
            Apply
          </button>
        </div>
        {themeMenu.menuElement}
      </div>
    );
  }
  if (drillIn === "frame.cutout" && sceneFrame) {
    const cutout = sceneFrame.cutout;
    // The override replaces the deck's cutout whole, so materialise the resolved cutout then patch the field.
    const patchCutout = (change: Partial<FrameCutoutSpec>) =>
      void patchDoc((next) => {
        next.frame = { ...(next.frame ?? {}), cutout: { ...cutout, ...change } };
      });
    const sides: { id: FrameSide; label: string }[] = [
      { id: "start", label: "Left" },
      { id: "end", label: "Right" },
    ];
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">Cutout</div>
        <div className="inspector-drill-body">
          <div className="bg-type-grid" role="tablist" aria-label="Cutout shape">
            {FRAME_SHAPES.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={cutout.shape === s}
                className={`bg-type-tile${cutout.shape === s ? " selected" : ""}`}
                onClick={() => patchCutout({ shape: s })}
              >
                <FrameShapeIcon id={s} />
                {FRAME_SHAPE_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="popover-row">
            <span className="popover-inline">
              Side
              <div className="wizard-presets">
                {sides.map((sd) => (
                  <button
                    key={sd.id}
                    type="button"
                    className={`chip${(cutout.side ?? "start") === sd.id ? " selected" : ""}`}
                    onClick={() => patchCutout({ side: sd.id })}
                  >
                    {sd.label}
                  </button>
                ))}
              </div>
            </span>
          </div>
          <div className="popover-row">
            <span className="popover-inline slider-row-label">
              <CutoutSliderIcon id="size" />
              Size
            </span>
            <DebouncedRange
              value={cutout.size ?? 0.56}
              min={0.3}
              max={0.85}
              step={0.01}
              label="Cutout size"
              onCommit={(v) => patchCutout({ size: v })}
            />
          </div>
          {cutout.shape === "rounded-rect" && (
            <div className="popover-row">
              <span className="popover-inline slider-row-label">
                <CutoutSliderIcon id="radius" />
                Corner radius
              </span>
              <DebouncedRange
                value={cutout.radius ?? 0.12}
                min={0}
                max={0.5}
                step={0.01}
                label="Corner radius"
                onCommit={(v) => patchCutout({ radius: v })}
              />
            </div>
          )}
          <div className="popover-row">
            <span className="popover-inline slider-row-label">
              <CutoutSliderIcon id="inset" />
              Inset
            </span>
            <DebouncedRange
              value={cutout.inset ?? 0}
              min={0}
              max={0.2}
              step={0.01}
              label="Inset"
              onCommit={(v) => patchCutout({ inset: v })}
            />
          </div>
        </div>
      </div>
    );
  }
  if (drillIn === "frame.panel" && sceneFrame) {
    const resolveColour = (c: string | undefined): string => {
      if (c === "background" || c === "text" || c === "accent" || c === "muted") {
        return sceneTheme?.colors[c] ?? c;
      }
      return c ?? sceneTheme?.colors.background ?? "#1e2226";
    };
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">Panel colour</div>
        <div className="inspector-drill-body">
          <div className="popover-row">
            <span className="popover-inline">
              Colour
              <ColourPicker
                value={resolveColour(sceneFrame.background)}
                label="Panel colour"
                onCommit={(hex) =>
                  void patchDoc((next) => {
                    next.frame = { ...(next.frame ?? {}), background: hex };
                  })
                }
                onReset={() =>
                  void patchDoc((next) => {
                    if (next.frame) delete next.frame.background;
                  })
                }
              />
            </span>
          </div>
          <p className="modal-hint">Leave unset for the neutral panel that suits the theme.</p>
        </div>
      </div>
    );
  }
  if (drillIn === "frame.chip" && sceneFrame) {
    const chip = sceneFrame.chip;
    const accent = sceneTheme?.colors.accent ?? "#3ec6b0";
    // Materialise the resolved chip then patch a field; `null` removes the chip entirely.
    const setChip = (change: Partial<FrameChipSpec> | null) =>
      void patchDoc((next) => {
        if (change === null) {
          if (next.frame) delete next.frame.chip;
          return;
        }
        const base: FrameChipSpec = chip ?? { label: "Released" };
        next.frame = { ...(next.frame ?? {}), chip: { ...base, ...change } };
      });
    const chipColour = (c: string | undefined): string => {
      if (c === "background" || c === "text" || c === "accent" || c === "muted") {
        return sceneTheme?.colors[c] ?? c;
      }
      return c ?? accent;
    };
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">Chip</div>
        <div className="inspector-drill-body">
          {chip ? (
            <>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Preset</span>
                <div className="wizard-presets">
                  {CHIP_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="chip"
                      onClick={() => setChip({ label: p.label, colour: p.colour, icon: p.icon })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <TextFieldRow
                label="Label"
                value={chip.label}
                placeholder="Released"
                colour={{
                  value: chipColour(chip.colour),
                  defaultValue: accent,
                  onCommit: (hex) => setChip({ colour: hex }),
                  onReset: () => setChip({ colour: undefined }),
                }}
                onChange={(t) => setChip({ label: t })}
              />
              <div className="wizard-field">
                <span className="wizard-label">Mark</span>
                <div className="chip-icon-grid">
                  <button
                    type="button"
                    className={`chip-icon-tile${!chip.icon ? " selected" : ""}`}
                    title="No mark"
                    onClick={() => setChip({ icon: undefined })}
                  >
                    <span className="chip-icon-none">None</span>
                  </button>
                  {CHIP_ICON_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`chip-icon-tile${resolveChipIconId(chip.icon) === id ? " selected" : ""}`}
                      title={id}
                      onClick={() => setChip({ icon: id })}
                    >
                      <ChipIconPreview id={id} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="wizard-field">
                <span className="wizard-label">Custom mark</span>
                <input
                  className="modal-input"
                  value={chip.icon && !resolveChipIconId(chip.icon) ? chip.icon : ""}
                  placeholder="an emoji or assets/icon.png"
                  aria-label="Custom chip mark"
                  onChange={(e) => setChip({ icon: e.target.value.trim() || undefined })}
                />
              </div>
              <div className="inspector-drill-actions">
                <button type="button" className="btn danger" onClick={() => setChip(null)}>
                  Remove chip
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={() =>
                setChip({ label: "Released", colour: "#2fb170", icon: "circle-check" })
              }
            >
              Add chip
            </button>
          )}
        </div>
      </div>
    );
  }
  if (drillIn === "frame.decorations" && sceneFrame) {
    const decos = sceneFrame.decorations ?? [];
    // The override replaces the whole array, so materialise the resolved decorations then patch.
    const writeDecos = (nextDecos: FrameDecorationSpec[]) =>
      void patchDoc((next) => {
        next.frame = { ...(next.frame ?? {}), decorations: nextDecos };
      });
    const patchDeco = (id: string, change: Partial<FrameDecorationSpec>) =>
      writeDecos(decos.map((d) => (d.id === id ? { ...d, ...change } : d)));
    const openImagePicker = (replaceId?: string) => {
      setMediaTarget({ kind: "decoration", replaceId });
      setModal("media");
    };
    const shapes: { id: FrameDecorationShape; label: string }[] = [
      { id: "none", label: "Natural" },
      { id: "circle", label: "Circle" },
    ];
    const layers: { id: FrameDecorationLayer; label: string }[] = [
      { id: "below", label: "Behind" },
      { id: "above", label: "In front" },
    ];
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">Decorations</div>
        <div className="inspector-drill-body">
          {decos.length === 0 && (
            <p className="modal-hint">
              Positioned images that break out of the panel, like a logo or avatar.
            </p>
          )}
          {decos.map((d) => (
            <div
              key={d.id}
              className={`deco-card${d.id === selectedDecoId ? " selected" : ""}`}
              onPointerDown={() => selectDeco(d.id)}
            >
              <div className="deco-card-head">
                <span className="deco-card-name" title={d.src}>
                  {decorationLabel(d.src)}
                </span>
                <button
                  type="button"
                  className="deco-remove"
                  title="Remove decoration"
                  aria-label="Remove decoration"
                  onClick={() => writeDecos(decos.filter((x) => x.id !== d.id))}
                >
                  Remove
                </button>
              </div>
              <button type="button" className="btn" onClick={() => openImagePicker(d.id)}>
                Replace image
              </button>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Across</span>
                <DebouncedRange
                  value={d.position[0]}
                  min={-1}
                  max={1}
                  step={0.01}
                  label="Horizontal position"
                  onCommit={(v) => patchDeco(d.id, { position: [v, d.position[1]] })}
                />
              </div>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Up/down</span>
                <DebouncedRange
                  value={d.position[1]}
                  min={-1}
                  max={1}
                  step={0.01}
                  label="Vertical position"
                  onCommit={(v) => patchDeco(d.id, { position: [d.position[0], v] })}
                />
              </div>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Size</span>
                <DebouncedRange
                  value={d.size}
                  min={0.03}
                  max={0.6}
                  step={0.01}
                  label="Size"
                  onCommit={(v) => patchDeco(d.id, { size: v })}
                />
              </div>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Rotation</span>
                <DebouncedRange
                  value={d.rotationDeg ?? 0}
                  min={-180}
                  max={180}
                  step={1}
                  label="Rotation"
                  onCommit={(v) => patchDeco(d.id, { rotationDeg: v })}
                />
              </div>
              <div className="popover-row">
                <span className="popover-inline">
                  Shape
                  <div className="wizard-presets">
                    {shapes.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`chip${(d.shape ?? "none") === s.id ? " selected" : ""}`}
                        onClick={() => patchDeco(d.id, { shape: s.id })}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </span>
              </div>
              <div className="popover-row">
                <span className="popover-inline">
                  Layer
                  <div className="wizard-presets">
                    {layers.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        className={`chip${(d.layer ?? "above") === l.id ? " selected" : ""}`}
                        onClick={() => patchDeco(d.id, { layer: l.id })}
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </span>
              </div>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => openImagePicker()}>
            Add decoration
          </button>
        </div>
        {mediaModal}
      </div>
    );
  }
  if (drillIn === "style.shadow" && doc && device) {
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">Device shadow</div>
        <div className="inspector-drill-body">
          <div className="option-grid">
            {SHADOW_OPTIONS.map((o) => (
              <OptionCard
                key={o.id}
                label={o.label}
                image={optionPreviewStill(`shadow-${o.id}`)}
                selected={(device.shadow ?? "soft") === o.id}
                onSelect={() => {
                  void patchDoc((next) => {
                    const d = next.devices?.[0];
                    if (d) d.shadow = o.id as DeviceShadowMode;
                  });
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (drillIn === "style.background" && doc) {
    const bgOpts = backgroundOptions(sceneTheme);
    const colourOpt = bgOpts.find((o) => o.value?.type === "color")?.value;
    const docTab = doc.background === undefined ? "default" : doc.background.type;
    const bgTab = bgTabOverride ?? docTab;
    // Staging state from the registry: null = the scene mounts no SceneStage (hide the toggle, never warn).
    const stagingOn = stagedBackdrop !== null && stagedBackdrop !== "none";
    const resolvedBackdrop = doc.backdrop ?? sceneTheme?.backdrop;
    /** A floor of `hex`, keeping the resolved floor's fillet so write-through can't reshape the cyc. */
    const floorFor = (hex: string): ThemeBackdrop =>
      resolvedBackdrop?.type === "floor" && resolvedBackdrop.filletRadius !== undefined
        ? { type: "floor", color: hex, filletRadius: resolvedBackdrop.filletRadius }
        : { type: "floor", color: hex };
    const commitBackground = (value: ThemeBackground | undefined) => {
      setBgTabOverride(null);
      void patchDoc((next) => {
        next.background = value;
        // Theme resets both layers; a fresh colour writes through to the stage (one visual, one edit).
        if (value === undefined) next.backdrop = undefined;
        else if (value.type === "color" && stagingOn) next.backdrop = floorFor(value.color);
      });
    };
    const removeStageBackdrop = () =>
      void patchDoc((next) => {
        next.backdrop = { type: "none" };
      });
    const occlusionWarning = (kind: "image" | "video" | "animation") =>
      stagingOn && (
        <div className="bg-occlusion">
          <span className="modal-hint">
            This scene stages a {stagedBackdrop} backdrop that will hide the {kind} — remove it so
            the {kind} shows.
          </span>
          <button type="button" className="btn" onClick={removeStageBackdrop}>
            Remove stage backdrop
          </button>
        </div>
      );
    const shaderSpec = doc.background?.type === "shader" ? doc.background : null;
    const shaderDef = shaderSpec ? SHADER_BACKGROUNDS[shaderSpec.shader] : undefined;
    const patchShader = (mutate: (spec: Extract<ThemeBackground, { type: "shader" }>) => void) =>
      void patchDoc((next) => {
        if (next.background?.type !== "shader") return;
        const spec = structuredClone(next.background);
        mutate(spec);
        next.background = spec;
      });
    // Shared by the preset tiles and the header Reset: the whole look lands explicitly.
    const applyShaderPreset = (preset: ShaderBackgroundPreset) =>
      patchShader((spec) => {
        spec.colors = [...preset.colors];
        spec.speed = preset.speed ?? 1;
        spec.scale = preset.scale;
        spec.params = preset.params ? { ...preset.params } : undefined;
        spec.preset = preset.id;
      });
    const selectedShaderPreset =
      shaderSpec?.preset && shaderSpec
        ? SHADER_BACKGROUND_PRESETS[shaderSpec.shader]?.find((p) => p.id === shaderSpec.preset)
        : undefined;
    const types: { id: Exclude<typeof bgTab, "default">; label: string }[] = [
      { id: "none", label: "None" },
      { id: "color", label: "Colour" },
      { id: "gradient", label: "Gradient" },
      { id: "shader", label: "Animated" },
      { id: "image", label: "Image" },
      { id: "video", label: "Video" },
    ];
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">
          <span>Background</span>
          {bgTab === "shader" && selectedShaderPreset && (
            <button
              type="button"
              className="inspector-reset-btn"
              title={`Back to the ${selectedShaderPreset.name} preset's colours and motion`}
              onClick={() => applyShaderPreset(selectedShaderPreset)}
            >
              Reset
            </button>
          )}
        </div>
        <div className="inspector-drill-body">
          {docTab === "default" ? (
            <p className="modal-hint">
              Following the theme's background — pick a fill type to override it for this scene.
            </p>
          ) : (
            <div className="popover-row">
              <button type="button" className="btn" onClick={() => commitBackground(undefined)}>
                Reset to theme default
              </button>
            </div>
          )}
          <div className="bg-type-grid" role="tablist" aria-label="Background fill type">
            {types.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={bgTab === t.id}
                className={`bg-type-tile${bgTab === t.id ? " selected" : ""}`}
                onClick={() => {
                  if (t.id === "none") commitBackground({ type: "none" });
                  else if (t.id === "color") {
                    if (docTab !== "color") commitBackground(colourOpt);
                    else setBgTabOverride(null);
                  } else setBgTabOverride(t.id);
                }}
              >
                <BgTypeIcon id={t.id} />
                {t.label}
              </button>
            ))}
          </div>
          {bgTab === "color" && doc.background?.type === "color" && (
            <div className="popover-row">
              <span className="popover-inline">
                Colour
                <ColourPicker
                  value={doc.background.color}
                  label="Background colour"
                  onCommit={(hex) => {
                    void patchDoc((next) => {
                      if (next.background?.type === "color") {
                        next.background = { ...next.background, color: hex };
                      }
                      if (stagingOn) next.backdrop = floorFor(hex);
                    });
                  }}
                />
              </span>
            </div>
          )}
          {bgTab === "gradient" && (
            <GradientPickerModal
              embedded
              current={doc.background}
              theme={sceneTheme}
              onCancel={() => setBgTabOverride(null)}
              onApply={(value) => {
                setBgTabOverride(null);
                void patchDoc((next) => {
                  const parallax =
                    next.background && next.background.type !== "none"
                      ? next.background.parallax
                      : undefined;
                  next.background = parallax !== undefined ? { ...value, parallax } : value;
                  // The same gradient drives the stage plane, so the edit is visible on staged scenes.
                  if (stagingOn && value.type === "gradient") {
                    const backdrop: ThemeBackdrop = { type: "gradient" };
                    if (value.gradient) backdrop.gradient = value.gradient;
                    if (value.spec) backdrop.spec = value.spec;
                    next.backdrop = backdrop;
                  }
                });
              }}
            />
          )}
          {bgTab === "shader" && (
            <>
              {occlusionWarning("animation")}
              <p className="modal-hint">
                Animated fills run on the project clock, so the motion is continuous across scene
                cuts when neighbouring scenes share the same pick.
              </p>
              <div className="option-grid">
                {SHADER_BACKGROUND_IDS.map((id) => {
                  const def = SHADER_BACKGROUNDS[id];
                  const preview = optionPreviewClip(`bg-${id}`);
                  return (
                    <OptionCard
                      key={id}
                      label={def.name}
                      image={preview?.poster ?? optionPreviewStill(`bg-${id}`)}
                      clip={preview?.clip}
                      playing={bgHover === id || shaderSpec?.shader === id}
                      selected={shaderSpec?.shader === id}
                      onSelect={() => {
                        setBgTabOverride(null);
                        void patchDoc((next) => {
                          next.background = {
                            type: "shader",
                            shader: id,
                            colors: def.colorSlots.map((slot) => slot.fallback),
                            speed: 1,
                          };
                        });
                      }}
                      onHoverChange={(h) => setBgHover((cur) => (h ? id : cur === id ? null : cur))}
                    />
                  );
                })}
              </div>
              {shaderSpec && shaderDef && (
                <>
                  {(SHADER_BACKGROUND_PRESETS[shaderSpec.shader] ?? []).length > 0 && (
                    <>
                      <div className="popover-row">
                        <span className="popover-group-label">Presets</span>
                      </div>
                      <div className="option-grid three-up">
                        {(SHADER_BACKGROUND_PRESETS[shaderSpec.shader] ?? []).map((preset) => (
                          <OptionCard
                            key={preset.id}
                            label={preset.name}
                            image={optionPreviewStill(`bgp-${shaderSpec.shader}-${preset.id}`)}
                            selected={shaderSpec.preset === preset.id}
                            onSelect={() => applyShaderPreset(preset)}
                          />
                        ))}
                      </div>
                    </>
                  )}
                  {shaderDef.colorSlots.map((slot, i) => (
                    <div key={slot.label} className="popover-row">
                      <span className="popover-inline">
                        {slot.label}
                        <ColourPicker
                          value={shaderSpec.colors?.[i] ?? slot.fallback}
                          label={slot.label}
                          defaultValue={slot.fallback}
                          onReset={() =>
                            patchShader((spec) => {
                              const colors = shaderDef.colorSlots.map(
                                (s, j) => spec.colors?.[j] ?? s.fallback,
                              );
                              colors[i] = slot.fallback;
                              spec.colors = colors;
                            })
                          }
                          onCommit={(hex) =>
                            patchShader((spec) => {
                              const colors = shaderDef.colorSlots.map(
                                (s, j) => spec.colors?.[j] ?? s.fallback,
                              );
                              colors[i] = hex;
                              spec.colors = colors;
                            })
                          }
                        />
                      </span>
                    </div>
                  ))}
                  <div className="popover-row">
                    <span className="popover-inline">Speed</span>
                    <DebouncedRange
                      value={shaderSpec.speed ?? 1}
                      min={0}
                      max={3}
                      step={0.05}
                      label="Animation speed"
                      onCommit={(v) =>
                        patchShader((spec) => {
                          spec.speed = v;
                        })
                      }
                    />
                  </div>
                  <div className="popover-row">
                    <span className="popover-inline">Zoom</span>
                    <DebouncedRange
                      value={shaderSpec.scale ?? 1}
                      min={0.25}
                      max={3}
                      step={0.05}
                      label="Pattern zoom"
                      onCommit={(v) =>
                        patchShader((spec) => {
                          spec.scale = v;
                        })
                      }
                    />
                  </div>
                  {Object.entries(shaderDef.params).map(([key, p]) => (
                    <div key={key} className="popover-row">
                      <span className="popover-inline">{p.label}</span>
                      <DebouncedRange
                        value={shaderSpec.params?.[key] ?? p.default}
                        min={p.min}
                        max={p.max}
                        step={p.step}
                        label={p.label}
                        onCommit={(v) =>
                          patchShader((spec) => {
                            spec.params = { ...(spec.params ?? {}), [key]: v };
                          })
                        }
                      />
                    </div>
                  ))}
                </>
              )}
            </>
          )}
          {bgTab === "image" && (
            <>
              {occlusionWarning("image")}
              <div className="popover-row">
                <span className="modal-hint bg-media-hint">
                  Fills the frame behind everything and stays locked to the camera — pick an image
                  with a safe centre (it cover-crops per aspect).
                </span>
                <AddMediaButton
                  slug={slug}
                  kinds={["image"]}
                  onImported={() => setMediaRefresh((n) => n + 1)}
                />
              </div>
              <div className="inspector-media-host">
                <MediaBrowser
                  slug={slug}
                  projectPath={workspaceProjectPath(slug) ?? ""}
                  kinds={["image"]}
                  hideAdd
                  refreshKey={mediaRefresh}
                  selectedRel={doc?.background?.type === "image" ? doc.background.src : null}
                  onPick={(rel, meta) => {
                    if (meta && meta.kind !== "image") return;
                    setBgTabOverride(null);
                    void patchDoc((next) => {
                      const parallax =
                        next.background && next.background.type !== "none"
                          ? next.background.parallax
                          : undefined;
                      next.background =
                        parallax !== undefined
                          ? { type: "image", src: rel, parallax }
                          : { type: "image", src: rel };
                    });
                  }}
                />
              </div>
            </>
          )}
          {bgTab === "video" && (
            <>
              {occlusionWarning("video")}
              <div className="popover-row">
                <span className="modal-hint bg-media-hint">
                  Video that fills the frame behind everything.
                </span>
                <AddMediaButton
                  slug={slug}
                  kinds={["video"]}
                  onImported={() => setMediaRefresh((n) => n + 1)}
                />
              </div>
              <div className="inspector-media-host">
                <MediaBrowser
                  slug={slug}
                  projectPath={workspaceProjectPath(slug) ?? ""}
                  kinds={["video"]}
                  hideAdd
                  refreshKey={mediaRefresh}
                  selectedRel={doc?.background?.type === "video" ? doc.background.src : null}
                  cardMenu={mediaCardMenu({
                    slug,
                    primaryLabel: "Select",
                    onPrimary: (rel, meta) => selectVideoBackground(rel, meta),
                    onChanged: () => setMediaRefresh((n) => n + 1),
                    onError: setError,
                    // Editing the scene's current background arms the re-point; other cards keep library semantics.
                    onEdit: (rel) => {
                      if (doc?.background?.type !== "video" || doc.background.src !== rel)
                        return false;
                      onOpenEditVideo(sceneIndex, rel, "background");
                      return true;
                    },
                  })}
                  onPick={selectVideoBackground}
                />
              </div>
              {doc.background?.type === "video" && (
                <div className="popover-row">
                  <label className="popover-inline" title="Off holds the video's last frame">
                    <input
                      type="checkbox"
                      checked={doc.background.loop !== false}
                      onChange={(e) => {
                        const on = e.target.checked;
                        void patchDoc((next) => {
                          if (next.background?.type === "video") {
                            const { loop: _drop, ...rest } = next.background;
                            next.background = on ? rest : { ...rest, loop: false };
                          }
                        });
                      }}
                    />
                    Loop
                  </label>
                </div>
              )}
            </>
          )}
          <div className="popover-row">
            <span className="popover-group-label">Drift</span>
          </div>
          <p className="modal-hint">
            Camera motion drifts the fill at 5% of the content's screen motion — a pure orbit at the
            origin shows none; pan the camera target to see it.
          </p>
          <div className="popover-row">
            <label
              className={`popover-inline${doc.background && doc.background.type !== "none" ? "" : " popover-disabled"}`}
            >
              <input
                type="checkbox"
                disabled={!doc.background || doc.background.type === "none"}
                checked={
                  !!doc.background &&
                  doc.background.type !== "none" &&
                  (doc.background.parallax ?? 0) > 0
                }
                onChange={(e) => {
                  const on = e.target.checked;
                  void patchDoc((next) => {
                    if (next.background && next.background.type !== "none") {
                      next.background = toggleDrift(next.background, on);
                    }
                  });
                }}
              />
              Drift
            </label>
          </div>
          {stagedBackdrop !== null && (
            <>
              <div className="popover-row">
                <span className="popover-group-label">Staging</span>
              </div>
              <p className="modal-hint">
                The world-space floor and backdrop that catch light and real shadows. Colour and
                gradient picks write through to it; off shows the flat background alone.
              </p>
              <div className="popover-row">
                <label className="popover-inline">
                  <input
                    type="checkbox"
                    checked={stagingOn}
                    onChange={(e) => {
                      const on = e.target.checked;
                      void patchDoc((next) => {
                        if (!on) {
                          next.backdrop = { type: "none" };
                          return;
                        }
                        // Back on: the theme's own staging when it has one, else a floor in the current colour.
                        if (sceneTheme?.backdrop && sceneTheme.backdrop.type !== "none") {
                          next.backdrop = undefined;
                        } else {
                          next.backdrop = floorFor(
                            doc.background?.type === "color"
                              ? doc.background.color
                              : (sceneTheme?.colors.background ?? "#ffffff"),
                          );
                        }
                      });
                    }}
                  />
                  Staging
                </label>
              </div>
              {stagingOn && (
                <div className="wizard-presets">
                  {(() => {
                    const themeGradients = Object.keys(sceneTheme?.gradients ?? {});
                    const themeGradient = themeGradients.includes("backdrop")
                      ? "backdrop"
                      : themeGradients[0];
                    const gradientSource =
                      doc.background?.type === "gradient" ? doc.background : undefined;
                    const currentColour =
                      doc.background?.type === "color"
                        ? doc.background.color
                        : (sceneTheme?.colors.background ?? "#ffffff");
                    const form =
                      doc.backdrop === undefined ? "theme" : (resolvedBackdrop?.type ?? "none");
                    const chips: { id: string; label: string; disabled?: boolean }[] = [
                      { id: "theme", label: "Theme default" },
                      { id: "floor", label: "Floor" },
                      {
                        id: "gradient",
                        label: "Gradient",
                        disabled: !gradientSource && !themeGradient,
                      },
                    ];
                    return chips.map((chip) => (
                      <button
                        type="button"
                        key={chip.id}
                        className={`chip${form === chip.id ? " selected" : ""}`}
                        disabled={chip.disabled}
                        onClick={() => {
                          void patchDoc((next) => {
                            if (chip.id === "theme") next.backdrop = undefined;
                            else if (chip.id === "floor") next.backdrop = floorFor(currentColour);
                            else if (gradientSource) {
                              const backdrop: ThemeBackdrop = { type: "gradient" };
                              if (gradientSource.gradient)
                                backdrop.gradient = gradientSource.gradient;
                              if (gradientSource.spec) backdrop.spec = gradientSource.spec;
                              next.backdrop = backdrop;
                            } else if (themeGradient) {
                              next.backdrop = { type: "gradient", gradient: themeGradient };
                            }
                          });
                        }}
                      >
                        {chip.label}
                      </button>
                    ));
                  })()}
                </div>
              )}
            </>
          )}
          {slug && project.slots.length > 1 && (
            <>
              <div className="popover-row">
                <span className="popover-group-label">Apply everywhere</span>
              </div>
              <p className="modal-hint">
                Copies this background{stagedBackdrop !== null ? " and staging" : ""} onto every
                other scene, matching each slide.
              </p>
              <div className="popover-row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (!confirmApplyAll) {
                      setConfirmApplyAll(true);
                      return;
                    }
                    setConfirmApplyAll(false);
                    applyBackgroundToAllScenes(project, sceneIndex, onDocChanged)
                      .then(({ failed }) => {
                        if (failed > 0) setError(`${failed} scene(s) failed to update.`);
                      })
                      .catch((e) => setError(String(e)));
                  }}
                >
                  {confirmApplyAll
                    ? `Apply to ${project.slots.length - 1} other scene${project.slots.length > 2 ? "s" : ""}?`
                    : "Apply to all slides"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }
  if (drillIn === "motion.transition") {
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">{`Transition out of scene ${boundaryIndex + 1}`}</div>
        <div className="inspector-drill-body">
          <TransitionModal
            embedded
            project={project}
            boundaryIndex={boundaryIndex}
            thumbs={thumbs ?? {}}
            onCancel={() => setDrillIn(null)}
            onApply={async (spec) => {
              const manifestBefore = await readProjectManifestSnapshot(slug);
              await updateSceneTransition(slug, boundaryIndex, spec);
              pushHistory({
                label: "transition",
                changes: [
                  {
                    kind: "manifest",
                    slug,
                    before: manifestBefore,
                    after: await readProjectManifestSnapshot(slug),
                    reload: false,
                  },
                ],
              });
              setDrillIn(null);
              onTimingChanged();
            }}
          />
        </div>
      </div>
    );
  }
  if (drillIn?.startsWith("text.font:") && doc) {
    const key = drillIn.slice("text.font:".length);
    const label = key === "headline" && !doc.text?.title ? "Title" : key;
    const themeFace = (sceneTheme ?? project.theme).typography.headline;
    const override = doc.textStyle?.[`${key}Font`];
    const currentRef = typeof override === "string" ? parseFontString(override) : themeFace;
    const commitFont = (value: string | undefined) =>
      void patchDoc(
        (next) => {
          const style = { ...(next.textStyle ?? {}) };
          if (value === undefined) delete style[`${key}Font`];
          else style[`${key}Font`] = value;
          next.textStyle = Object.keys(style).length > 0 ? style : undefined;
        },
        { history: `${label.toLowerCase()} font` },
      );
    return (
      <div className="inspector-drill">
        <DrillBack label="Edit text" onClick={() => setDrillIn("text.edit")} />
        <div className="inspector-drill-title">
          {label.charAt(0).toUpperCase() + label.slice(1)} font
        </div>
        <div className="inspector-drill-body">
          {typeof override === "string" && (
            <button
              type="button"
              className="btn text-font-reset"
              onClick={() => commitFont(undefined)}
            >
              Use theme font
            </button>
          )}
          <FontPicker
            value={currentRef}
            onPick={(ref) => {
              // Pin + preload before the sidecar write so the face renders the moment the doc patch lands.
              void (async () => {
                await ensureFontRefsPinned([ref]);
                await preloadAppFonts([ref]);
                commitFont(formatFontString(ref));
              })();
            }}
          />
          <p className="modal-hint">
            System fonts are pinned into your workspace on first use, so exports never drift with
            macOS updates.
          </p>
        </div>
      </div>
    );
  }
  if (drillIn === "text.edit" && doc) {
    const textKeys = Object.keys(doc.text ?? {});
    const pinnedKeys = ["title", "subtitle", "headline"].filter((key) => textKeys.includes(key));
    const orderedKeys = [
      ...pinnedKeys,
      ...textKeys.filter((key) => !pinnedKeys.includes(key)).sort(),
    ];
    // Legacy device scenes keep their single line under `headline`; call it Title unless a real title coexists.
    const fieldLabels: Record<string, string> = {
      title: "Title",
      subtitle: "Subtitle",
      headline: textKeys.includes("title") ? "Headline" : "Title",
    };
    const align = doc.textLayout?.align ?? "center";
    const textTheme = sceneTheme ?? project.theme;
    // Swatches come from the mounted primitives: a key gets a colour control exactly when its text primitive accepts a sidecar override (`textKey`), and the reset value is that primitive's registered default fill, tokens resolved through the scene's theme.
    const colourDefaults = textKeyColorDefaults(sceneIndex);
    const styleCapable = textKeyStyleCapable(sceneIndex);
    const resolveFillToken = (fill: string): string =>
      fill === "text" || fill === "muted" || fill === "accent" ? textTheme.colors[fill] : fill;
    const styleStr = (k: string): string | undefined => {
      const v = doc.textStyle?.[k];
      return typeof v === "string" ? v : undefined;
    };
    const styleNum = (k: string): number | undefined => {
      const v = doc.textStyle?.[k];
      return typeof v === "number" ? v : undefined;
    };
    // Default values delete their key, so untouched fields stay absent from the sidecar.
    const patchStyle = (history: string, k: string, value: string | number | undefined) =>
      void patchDoc(
        (next) => {
          const style = { ...(next.textStyle ?? {}) };
          if (value === undefined) delete style[k];
          else style[k] = value;
          next.textStyle = Object.keys(style).length > 0 ? style : undefined;
        },
        { history },
      );
    const commitTextEdit = () => {
      const merged = { ...(doc.text ?? {}), ...textValues };
      setDrillIn(null);
      setTextValues({});
      void patchDoc((next) => {
        next.text = merged;
      });
    };
    return (
      <div className="inspector-drill">
        <DrillBack label="Scene" onClick={() => setDrillIn(null)} />
        <div className="inspector-drill-title">Edit text</div>
        <div className="inspector-drill-body">
          <div className="wizard-field">
            <span className="wizard-label">Alignment</span>
            <div className="wizard-presets">
              {ALIGN_OPTIONS.map((o) => (
                <button
                  type="button"
                  key={o.id}
                  className={`chip${align === o.id ? " selected" : ""}`}
                  onClick={() =>
                    void patchDoc(
                      (next) => {
                        next.textLayout = { ...(next.textLayout ?? {}), align: o.id };
                      },
                      { history: "text alignment" },
                    )
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {orderedKeys.map((key) => {
            const value = textValues[key] ?? doc.text?.[key] ?? "";
            const label = fieldLabels[key] ?? key;
            const colour =
              colourDefaults[key] !== undefined
                ? { key: `${key}Color`, token: resolveFillToken(colourDefaults[key]) }
                : undefined;
            const fontOverride = styleStr(`${key}Font`);
            return (
              <div key={key} className="text-field-group">
                <TextFieldRow
                  label={label}
                  value={value}
                  onChange={(text) => setTextValues((v) => ({ ...v, [key]: text }))}
                  onKeyDown={(e) => {
                    // Cmd/Ctrl+Enter saves; plain Enter stays a newline (native textarea behaviour).
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      commitTextEdit();
                    }
                  }}
                  colour={
                    colour
                      ? {
                          value: styleStr(colour.key) ?? colour.token,
                          defaultValue: colour.token,
                          onReset: () =>
                            patchStyle(`${label.toLowerCase()} colour`, colour.key, undefined),
                          onCommit: (hex) =>
                            patchStyle(`${label.toLowerCase()} colour`, colour.key, hex),
                        }
                      : undefined
                  }
                />
                {styleCapable.has(key) && (
                  <div className="text-style-row">
                    <span className="text-style-fontfield">
                      <button
                        type="button"
                        className={`text-style-font${fontOverride ? " overridden" : ""}`}
                        title={`${label} font`}
                        onClick={() => setDrillIn(`text.font:${key}`)}
                      >
                        <span className="text-style-font-name">
                          {fontOverride ? parseFontString(fontOverride).family : "Theme font"}
                        </span>
                        <span className="text-style-font-chevron" aria-hidden>
                          ›
                        </span>
                      </button>
                      <span className="inspector-pose-caption">Font</span>
                    </span>
                    <NumericField
                      label="Size %"
                      value={Math.round((styleNum(`${key}Size`) ?? 1) * 100)}
                      decimals={0}
                      onCommit={(n) =>
                        patchStyle(
                          `${label.toLowerCase()} size`,
                          `${key}Size`,
                          n === 100 || n <= 0 ? undefined : Math.min(1000, n) / 100,
                        )
                      }
                    />
                    <NumericField
                      label="X"
                      value={styleNum(`${key}OffsetX`) ?? 0}
                      decimals={2}
                      onCommit={(n) =>
                        patchStyle(
                          `${label.toLowerCase()} position`,
                          `${key}OffsetX`,
                          n === 0 ? undefined : n,
                        )
                      }
                    />
                    <NumericField
                      label="Y"
                      value={styleNum(`${key}OffsetY`) ?? 0}
                      decimals={2}
                      onCommit={(n) =>
                        patchStyle(
                          `${label.toLowerCase()} position`,
                          `${key}OffsetY`,
                          n === 0 ? undefined : n,
                        )
                      }
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="inspector-drill-actions">
          <button type="button" className="btn" onClick={() => setDrillIn(null)}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={commitTextEdit}>
            Save
          </button>
        </div>
      </div>
    );
  }
  if (drillIn === "device.change" && device) {
    return (
      <DeviceDrillIn
        model={(device.model in DEVICE_CATALOG ? device.model : "iphone-15-pro") as DeviceId}
        colour={device.colour ?? DEVICE_CATALOG["iphone-15-pro"].defaultColour}
        motion={device.motion?.preset ?? "none"}
        onBack={() => setDrillIn(null)}
        onSave={(model, colour, motion) => {
          setDrillIn(null);
          void patchDoc((next) => {
            const d = next.devices?.[0];
            if (d) {
              d.model = model;
              d.colour = colour;
              d.motion = { ...d.motion, preset: motion };
            }
          });
        }}
      />
    );
  }

  if (drillIn === "device.rotation" && device) {
    return (
      <RotationDrillIn
        rotationDeg={device.placement?.rotationDeg ?? [0, 0, 0]}
        onBack={() => setDrillIn(null)}
        onCommit={(rotationDeg) => {
          void patchDoc((next) => {
            const d = next.devices?.[0];
            if (d) d.placement = { ...d.placement, rotationDeg };
          });
        }}
      />
    );
  }

  // ── The section list ──────────────────────────────────────────────────────
  return (
    <>
      {header}
      {unrenderableChars.size > 0 && (
        <p className="inspector-text-warning">
          {`Some characters can't render in this scene's fonts: ${[...unrenderableChars].join("  ")}`}
        </p>
      )}
      {!doc && (
        <p className="inspector-stub-note">
          This scene has no scene document yet, so its text, media and style can't be edited here —
          ask Claude to add one in the terminal, or edit the scene file directly.
        </p>
      )}
      {sections.map((section, i) => {
        const isCollapsed = collapsed.includes(section.id);
        return (
          <div key={section.id}>
            {i > 0 && <div className="inspector-section-divider" />}
            {/* The Camera section owns its header; its Reset trailing button needs the camera doc (decision 6). */}
            {section.id === "camera" ? (
              <CameraSectionBody
                project={project}
                sceneIndex={sceneIndex}
                onDocChanged={onDocChanged}
                collapsed={isCollapsed}
                onToggle={() => toggleSection(section.id)}
              />
            ) : (
              <SectionHeader
                label={section.label}
                collapsed={isCollapsed}
                onToggle={() => toggleSection(section.id)}
              />
            )}
            {!isCollapsed && section.id !== "camera" && (
              <div className="inspector-rows inspector-section-body">
                {section.rows.map((row) => {
                  if (row.id === "motion.duration") {
                    return (
                      <DurationRow
                        key={row.id}
                        durationMs={scene.durationMs}
                        mode={durationMode}
                        onCommit={(ms) => void commitDuration(ms)}
                      />
                    );
                  }
                  if (row.id === "device.lid" && device) {
                    const lid = isDeviceId(device.model)
                      ? DEVICE_CATALOG[device.model].lid
                      : undefined;
                    return (
                      <LidRow
                        key={row.id}
                        lidDeg={device.lidDeg ?? lid?.defaultDeg ?? 90}
                        openDeg={lid?.openDeg ?? 110}
                        onCommit={(deg) =>
                          void patchDoc((next) => {
                            const d = next.devices?.[0];
                            if (d) d.lidDeg = deg;
                          })
                        }
                      />
                    );
                  }
                  if (row.id === "frame.enabled") {
                    return (
                      <FrameEnabledRow
                        key={row.id}
                        on={sceneFrame !== undefined}
                        onToggle={(on) =>
                          void patchDoc((next) => {
                            if (on) {
                              if (next.frame) delete next.frame.enabled;
                            } else {
                              next.frame = { ...(next.frame ?? {}), enabled: false };
                            }
                          })
                        }
                      />
                    );
                  }
                  const onClick = {
                    "text.edit": () => {
                      setTextValues({});
                      setDrillIn("text.edit");
                    },
                    "text.motion": () => {
                      if (!doc) return;
                      textAnimOriginal.current = {
                        spec: doc.textAnimation,
                        force: doc.textAnimationForce === true,
                      };
                      setDrillIn("text.motion");
                    },
                    "text.add": () => {
                      // Seed the keys the mounted scene actually reads; the host fallback owns title/subtitle otherwise.
                      const consumed = textKeysConsumedBy(sceneIndex);
                      void patchDoc((next) => {
                        next.text =
                          consumed.includes("headline") && !consumed.includes("title")
                            ? { ...next.text, headline: sceneTitle }
                            : { ...next.text, title: sceneTitle, subtitle: "" };
                      }).then(() => {
                        setTextValues({});
                        setDrillIn("text.edit");
                      });
                    },
                    "device.media": () => {
                      setMediaTarget({ kind: "device" });
                      setModal("media");
                    },
                    "device.editVideo": () =>
                      device?.media && onOpenEditVideo(sceneIndex, device.media.src),
                    "device.change": () => setDrillIn("device.change"),
                    "device.add": () => {
                      void patchDoc((next) => {
                        // The Rust scaffolder's device defaults, byte for byte.
                        next.devices = [
                          ...(next.devices ?? []),
                          {
                            id: "d1",
                            model: "iphone-17-pro",
                            colour: "silver",
                            placement: {
                              position: [0, -0.3, 0],
                              rotationDeg: [0, 0, 0],
                              scale: 1,
                            },
                            motion: { preset: "none" },
                            shadow: "soft",
                          },
                        ];
                      });
                    },
                    "device.rotation": () => setDrillIn("device.rotation"),
                    "device.remove": () => {
                      if (!confirmRemove) {
                        setConfirmRemove(true);
                        return;
                      }
                      setConfirmRemove(false);
                      void patchDoc((next) => {
                        next.devices = (next.devices ?? []).slice(1);
                      });
                    },
                    "motion.transition": () => {
                      void listCachedSceneThumbs(project).then(setThumbs);
                      setDrillIn("motion.transition");
                    },
                    "style.theme": () => {
                      if (!doc) return;
                      setThemeDraft(doc.themeId ?? "");
                      setDrillIn("style.theme");
                    },
                    "style.background": () => {
                      setBgTabOverride(null);
                      setDrillIn("style.background");
                    },
                    "style.shadow": () => setDrillIn("style.shadow"),
                    "frame.cutout": () => setDrillIn("frame.cutout"),
                    "frame.panel": () => setDrillIn("frame.panel"),
                    "frame.chip": () => setDrillIn("frame.chip"),
                    "frame.decorations": () => setDrillIn("frame.decorations"),
                  }[row.id];
                  const value = {
                    "text.motion": doc?.textAnimation
                      ? describeSpec(doc.textAnimation)
                      : "Theme default",
                    "device.change": device
                      ? DEVICE_CATALOG[
                          (device.model in DEVICE_CATALOG
                            ? device.model
                            : "iphone-15-pro") as DeviceId
                        ].name
                      : undefined,
                    "device.rotation": device
                      ? (device.placement?.rotationDeg ?? [0, 0, 0])
                          .map((n) => `${Math.round(n)}°`)
                          .join(" ")
                      : undefined,
                    "motion.transition": transitionValue,
                    "style.theme": sceneTheme?.name,
                    "style.background": doc
                      ? doc.background === undefined
                        ? "Theme default"
                        : {
                            none: "None",
                            color: "Colour",
                            gradient: "Gradient",
                            shader: "Animated",
                            image: "Image",
                            video: "Video",
                          }[doc.background.type]
                      : undefined,
                    "style.shadow": device
                      ? SHADOW_OPTIONS.find((o) => o.id === (device.shadow ?? "soft"))?.label
                      : undefined,
                    "frame.cutout": sceneFrame
                      ? FRAME_SHAPE_LABELS[sceneFrame.cutout.shape]
                      : undefined,
                    "frame.panel": sceneFrame ? (sceneFrame.background ?? "Default") : undefined,
                    "frame.chip": sceneFrame ? (sceneFrame.chip?.label ?? "None") : undefined,
                    "frame.decorations": sceneFrame
                      ? sceneFrame.decorations?.length
                        ? String(sceneFrame.decorations.length)
                        : "None"
                      : undefined,
                  }[row.id];
                  return (
                    <ActionRow
                      key={row.id}
                      icon={<SceneRowIcon id={row.id} />}
                      label={
                        row.id === "device.remove" && confirmRemove ? "Really remove?" : row.label
                      }
                      value={value}
                      chevron={row.chevron}
                      danger={row.danger}
                      selected={row.id === "device.media" && modal === "media"}
                      onClick={onClick}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {error && <p className="inspector-error">{error}</p>}

      {/* Scene management (the wizard's Arrange delete, re-homed): files move to the Trash; the last scene is protected (the Rust guard, mirrored as disabled); deliberately outside the pinned sceneSections model, bottom-of-panel chrome like the error line. */}
      <div className="inspector-section-divider" />
      <div className="inspector-rows inspector-section-body">
        <ActionRow
          icon={<SceneRowIcon id="device.remove" />}
          label={confirmDeleteScene ? "Really delete?" : "Delete scene…"}
          chevron={false}
          danger
          disabled={project.slots.length <= 1}
          onClick={() => {
            if (!confirmDeleteScene) {
              setConfirmDeleteScene(true);
              return;
            }
            setConfirmDeleteScene(false);
            onDeleteScene(sceneIndex);
          }}
        />
      </div>

      {/* ── Modals (the EditBar's hosting, re-homed) ─────────────────────── */}
      {mediaModal}
    </>
  );
}
