import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useCameraEditStore } from "../../engine/cameraEditStore";
import { useChartEditStore } from "../../engine/chartEditStore";
import { useClockStore } from "../../engine/clock";
import { COMPARE_MASK_CATALOG } from "../../engine/compareCatalog";
import { COMPARE_PRESETS } from "../../engine/comparePresets";
import { useDecorationEditStore } from "../../engine/decorationEditStore";
import { useSceneIsBanded } from "../../engine/depthStageRegistry";
import { useDeviceEditStore } from "../../engine/deviceEditStore";
import { useFormat } from "../../engine/format";
import type { GizmoMode } from "../../engine/gizmoMode";
import { useGizmoSectionOpen } from "../../engine/gizmoSections";
import { pushHistory } from "../../engine/history";
import { useLayeredScreenshotEditStore } from "../../engine/layeredScreenshotEditStore";
import { fsUrl, type MediaMeta } from "../../engine/media";
import { useObjectEditStore } from "../../engine/objectEditStore";
import { optionPreviewClip, optionPreviewStill } from "../../engine/optionPreviews";
import { type LoadedProject, sceneFileStem, workspaceProjectPath } from "../../engine/project";
import { readProjectManifestSnapshot, updateSceneTransition } from "../../engine/projectEdit";
import { defaultOrbitPose } from "../../engine/sceneCamera";
import { type CameraDoc, nearestKey, type RigDoc, setKeyPose } from "../../engine/sceneCameraEdit";
import { applyBackgroundToAllScenes } from "../../engine/sceneDoc";
import {
  DEVICE_LAYOUT_PRESETS,
  type DeviceLayoutPreset,
  type SceneDoc,
  type SceneDocCameraPose,
  type SceneDocDeviceLayoutDelta,
  type SceneDocRigPose,
  type SceneDocVideoWindow,
  type SceneTextAlign,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
  type VideoWindowMotionPreset,
} from "../../engine/sceneDocSchema";
import { defaultRigPose } from "../../engine/sceneRig";
import { canRigConvertToOrbit, orbitToRig, rigToOrbit } from "../../engine/sceneRigConvert";
import { useLargestSceneText, useSceneTextRegistry } from "../../engine/sceneTextRegistry";
import { listCachedSceneThumbs } from "../../engine/sceneThumbs";
import { resolveVideoWindowRadius } from "../../engine/sceneVideoWindow";
import { captureCurrentFrame } from "../../engine/snapshots";
import { useSceneStageBackdrop } from "../../engine/stageRegistry";
import { ensureFontRefsPinned } from "../../engine/systemFonts";
import { useTextEditStore } from "../../engine/textEditStore";
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
import type { Theme, ThemeBackdrop, ThemeBackground } from "../../theme/tokens";
import { DEVICE_CATALOG, type DeviceId, isDeviceId } from "../../toolkit/device/catalog";
import type { DeviceShadowMode } from "../../toolkit/device/Device";
import { CHIP_ICON_IDS, type ChipIconId, resolveChipIconId } from "../../toolkit/frame/chipIcons";
import { isTextDecoration } from "../../toolkit/frame/icon";
import type {
  FrameChipSpec,
  FrameCutoutSpec,
  FrameDecorationFace,
  FrameDecorationLayer,
  FrameDecorationShape,
  FrameDecorationSpec,
  FrameShape,
  FrameSide,
  FrameSpec,
} from "../../toolkit/frame/types";
import {
  besideDevicePlacement,
  floorCentrePlacement,
  frontOfDevicePlacement,
} from "../../toolkit/objects/presets";
import {
  SCENE3D_BACKGROUND_IDS,
  SCENE3D_BACKGROUND_PRESETS,
  SCENE3D_BACKGROUNDS,
  type Scene3dBackgroundPreset,
  scene3dThemeAnchor,
} from "../../toolkit/stage/scene3d";
import {
  deriveThemeColorsFromAnchor,
  deriveThemeShaderColors,
  SHADER_BACKGROUND_IDS,
  SHADER_BACKGROUND_PRESETS,
  SHADER_BACKGROUNDS,
  type ShaderBackgroundPreset,
  themePresetAnchor,
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
import { useFreeCameraWarning } from "../freeCameraWarning";
import { GradientPickerModal } from "../GradientPicker";
import { textRotationWrite } from "../gizmo/textGizmoWrite";
import {
  chartRowValue,
  drillStackForScene,
  objectRowLabel,
  type SceneSectionModel,
  sceneSections,
} from "../inspectorOptions";
import { detectWindowRecording } from "../windowRecordingDetect";
import { ChartDrillIn, ChartPlacementDrillIn, newChartBlock } from "./ChartSection";
import { LightingSectionBody } from "./LightingSection";

/** Sideways step between devices: a phone auto-fits 2.6 world units tall (~1.26 wide at scale 1), a laptop width-fits to 3.4, so these clear one footprint with margin. */
const DEVICE_STEP_X = 1.4;
const LAPTOP_STEP_X = 3.6;

/** Titles the DrillBack shows for the screen one level down: the group/detail screens that own children. */
const SCREEN_TITLES: Record<string, string> = {
  text: "Text",
  device: "Device",
  frame: "Overlay",
  camera: "Animations",
  lighting: "Lighting",
  motion: "Timing",
  "text.edit": "Edit text",
  "style.background": "Background",
  "frame.panel": "Panel",
  "videoWindow.edit": "Video window",
  "compare.edit": "Comparison",
  "chart.edit": "Chart",
  "chart.position": "Position",
  "device.position": "Position",
};

/** Layout presets for the Position drill's chips; ids match `DEVICE_LAYOUT_PRESETS`. */
const LAYOUT_PRESET_LABELS: Record<DeviceLayoutPreset, { label: string; title: string }> = {
  row: { label: "Row", title: "A flat line-up facing the camera" },
  "toe-in": { label: "Toe-in", title: "A row with outer devices turned toward centre" },
  arc: { label: "Arc", title: "A shallow arc, outer devices receding" },
  cascade: { label: "Cascade", title: "Fanned cards stepping across and back" },
  hero: { label: "Hero", title: "Device 1 forward, the rest flanking behind" },
  "depth-pair": { label: "Depth", title: "Two devices split front and back" },
};

/** Preset poses for a device's absolute rotation (block-less scenes): Front on is the glb's authored identity. */
const ROTATION_PRESETS: { id: string; label: string; value: V3 }[] = [
  { id: "front", label: "Front on", value: [0, 0, 0] },
  { id: "editorial", label: "Editorial", value: [3, -14, 0] },
  { id: "mirrored", label: "Mirrored", value: [3, 14, 0] },
];

const ROTATION_AXIS_LABELS = ["tilt x °", "turn y °", "roll z °"] as const;

/** The Position drill's two write branches, module-scoped so the sliders and the preview gizmo share one write path: with a `deviceLayout` block an edit lands on that device's DELTA (0 = on the preset), without one on its raw placement. */
function mutateDelta(
  next: SceneDoc,
  id: string,
  fn: (delta: SceneDocDeviceLayoutDelta) => void,
): void {
  if (!next.deviceLayout) return;
  next.deviceLayout.devices ??= {};
  next.deviceLayout.devices[id] ??= {};
  fn(next.deviceLayout.devices[id]);
}

function mutatePlacement(
  next: SceneDoc,
  id: string,
  fn: (p: NonNullable<NonNullable<SceneDoc["devices"]>[number]["placement"]>) => void,
): void {
  const d = next.devices?.find((x) => x.id === id);
  if (!d) return;
  d.placement ??= {};
  fn(d.placement);
}

/** 14px phone/laptop glyph for the device pill (laptops are the catalog entries with a lid). */
function DevicePillIcon({ model }: { model: string }) {
  const laptop = isDeviceId(model) && DEVICE_CATALOG[model].lid !== undefined;
  return laptop ? (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M5 13V6.5A1.5 1.5 0 016.5 5h7A1.5 1.5 0 0115 6.5V13" />
      <path d="M3 15h14" />
    </svg>
  ) : (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="6.5" y="3" width="7" height="14" rx="1.8" />
      <path d="M9 15.5h2" />
    </svg>
  );
}

/** Text-alignment glyphs: three lines pinned left, centre or right. */
function AlignIcon({ id }: { id: SceneTextAlign }) {
  const lines: Record<SceneTextAlign, string> = {
    left: "M3 5h12M3 9h7M3 13h10",
    center: "M3 5h12M5.5 9h7M4 13h10",
    right: "M3 5h12M8 9h7M5 13h10",
  };
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={lines[id]} />
    </svg>
  );
}

import type { V3 } from "../../toolkit/types";
import { LayeredScreenshotBuilder } from "../LayeredScreenshotBuilder";
import { MediaBrowser } from "../MediaBrowser";
import { mediaCardMenu } from "../mediaCardMenu";
import { ObjectPicker } from "../ObjectPicker";
import { OptionCard } from "../OptionCard";
import { HeaderIconField, TextFieldRow } from "../SceneTextFields";
import { SHADOW_OPTIONS } from "../SceneWizards";
import { backgroundOptions, toggleDrift } from "../stageOptions";
import { DebouncedRange, TextMotionPanel } from "../TextAnimationPicker";
import { listThemeChoices, type ThemeChoice, ThemeGrid } from "../ThemePicker";
import { TransitionModal } from "../TransitionPicker";
import { describeSpec } from "../textAnimationOptions";
import { isTypingIn } from "../textEditFocus";
import { useThemeCardMenu } from "../themeCardMenu";
import { useEscapeClose } from "../useEscapeClose";
import { useSceneDocPatch } from "../useSceneDocPatch";
import { CameraPresetRow } from "./CameraPresetRow";
import { CameraRigFields, seedRig } from "./CameraRigFields";
import { DeviceDrillIn } from "./DeviceDrillIn";
import { DofFields } from "./DofFields";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  GizmoModeIcon,
  middleTruncate,
  NumberField,
  type SegmentedOption,
  SegmentedRow,
  ToggleFieldset,
  ToggleRow,
  useDragScrub,
} from "./rows";

/** The inspector's Scene tab: collapsible sections over the playhead's dominant scene, every edit riding the same `useSceneDocPatch` funnel the EditBar uses. Section/row structure comes from the pinned `sceneSections` model. The header thumb is read from `listCachedSceneThumbs` only, never a capture, to avoid the clock-borrow playhead-blip class. */

/** The Move/Rotate/Scale pills every gizmo drill shows. */
const GIZMO_MODE_OPTIONS: SegmentedOption<GizmoMode>[] = [
  { value: "translate", label: "Move", icon: <GizmoModeIcon mode="translate" /> },
  { value: "rotate", label: "Rotate", icon: <GizmoModeIcon mode="rotate" /> },
  { value: "scale", label: "Scale", icon: <GizmoModeIcon mode="scale" /> },
];

const FRAME_SHAPES: FrameShape[] = [
  "rect",
  "rounded-rect",
  "squircle",
  "circle",
  "capsule",
  "none",
];
const FRAME_SHAPE_LABELS: Record<FrameShape, string> = {
  rect: "Rectangle",
  "rounded-rect": "Rounded",
  squircle: "Squircle",
  circle: "Circle",
  capsule: "Capsule",
  none: "Full panel",
};

/** The Panel row's value: the colour itself for the flat fills (token or hex, the v1 shape included), the fill type otherwise. */
function panelFillLabel(background: FrameSpec["background"]): string {
  if (background === undefined) return "Default";
  if (typeof background === "string") return background;
  switch (background.type) {
    case "color":
      return background.color;
    case "gradient":
      return "Gradient";
    case "image":
      return middleTruncate(background.src.split("/").pop() ?? "Image");
    default:
      return "Transparent";
  }
}

/** Scene-row icons: same 20-viewBox stroke style as the Project tab. */
function SceneRowIcon({ id }: { id: string }) {
  switch (id) {
    case "lighting":
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
          <circle cx="10" cy="10" r="3.2" />
          <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M14.6 5.4l-1.4 1.4M6.8 13.2l-1.4 1.4" />
        </svg>
      );
    case "frame":
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
          <rect x="6" y="6.5" width="8" height="2.6" rx="1" />
          <path d="M6 12h8M6 14h5" />
        </svg>
      );
    case "frame.add":
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
          <rect x="2.5" y="3.5" width="11.5" height="13" rx="2" />
          <rect x="5" y="6.5" width="6.5" height="2.6" rx="1" />
          <path d="M16 12v5M13.5 14.5h5" />
        </svg>
      );
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
    case "compare.edit":
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
          <path d="M10 4v12" />
          <path d="M6 10h2M12 10h2" opacity="0.7" />
        </svg>
      );
    case "chart.edit":
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
          <path d="M3 16.5h14" />
          <path d="M5.5 16V9M10 16V4.5M14.5 16v-4" />
        </svg>
      );
    case "chart.add":
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
          <path d="M3 15.5h9" />
          <path d="M5 15V9.5M9 15V5" />
          <path d="M15 11v6M12 14h6" />
        </svg>
      );
    case "device.duplicate":
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
          <rect x="4" y="3" width="7" height="12" rx="1.6" />
          <rect x="9.5" y="6" width="7" height="12" rx="1.6" opacity="0.7" />
        </svg>
      );
    case "layeredScreenshot.add":
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
          <path d="M8.5 3.5l5.5 2.6-5.5 2.6L3 6.1l5.5-2.6z" />
          <path d="M3 9.4l5.5 2.6 5.5-2.6" />
          <path d="M15 12v5M12.5 14.5h5" />
        </svg>
      );
    case "layeredScreenshot.edit":
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
          <path d="M10 3l6.5 3-6.5 3-6.5-3 6.5-3z" />
          <path d="M3.5 9.8l6.5 3 6.5-3M3.5 13.3L10 16.3l6.5-3" />
        </svg>
      );
    case "videoWindow.add":
    case "videoWindow.edit":
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
          <rect x="3" y="4" width="14" height="11" rx="2" />
          <path d="M3 7.5h14" />
          <path d="M8.5 10l3.2 1.7-3.2 1.7z" fill="currentColor" stroke="none" />
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
    case "objects.edit":
    case "objects.add":
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
          <path d="M10 3l6 3.5v7L10 17l-6-3.5v-7L10 3z" />
          <path d="M10 3v7m0 0l6-3.5M10 10L4 6.5" />
        </svg>
      );
    case "device.position":
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
    case "camera.orbit":
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
          <ellipse cx="10" cy="10" rx="7" ry="3.6" transform="rotate(-20 10 10)" />
          <circle cx="16.6" cy="7.6" r="1.7" fill="currentColor" stroke="none" />
        </svg>
      );
    case "camera.free":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.5 9.4L17.4 3l-6.5 14.4-2.4-6z" />
          <path d="M8.5 11.4L17.4 3" />
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
    case "frame.icon":
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
          <circle cx="10" cy="10" r="7" />
          <circle cx="7.5" cy="8.5" r="0.6" fill="currentColor" stroke="none" />
          <circle cx="12.5" cy="8.5" r="0.6" fill="currentColor" stroke="none" />
          <path d="M7 12.3c.8 1 1.9 1.5 3 1.5s2.2-.5 3-1.5" strokeLinecap="round" />
        </svg>
      );
    case "frame.text":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 6h12" />
          <path d="M4 10h8" />
          <path d="M4 14h11" />
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
  const inputRef = useRef<HTMLInputElement>(null);
  const { dragging, onPointerDown } = useDragScrub({
    value: durationMs / 1000,
    decimals: 2,
    min: 0.1,
    dragScale: 0.05,
    onText: setText,
    inputRef,
    onCommit: (seconds) => onCommit(Math.round(seconds * 1000)),
  });
  useEffect(() => {
    if (!dragging && !isTypingIn(inputRef.current)) setText((durationMs / 1000).toFixed(2));
  }, [durationMs, dragging]);
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
    <div
      className={`inspector-duration-row${dragging ? " scrubbing" : ""}`}
      title="Scene length in seconds (switches to manual)"
    >
      <span className="action-row-icon">
        <SceneRowIcon id="motion.duration" />
      </span>
      <span className="action-row-label">Duration</span>
      {mode && <span className="action-row-value">{mode}</span>}
      <input
        ref={inputRef}
        className="modal-input inspector-num inspector-seconds inspector-num-drag"
        value={text}
        inputMode="decimal"
        aria-label="Scene duration in seconds"
        onPointerDown={onPointerDown}
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

/** Object placement preset chip icons: a dot for the object against a phone outline (or the floor). */
function ObjectPresetIcon({ id }: { id: "left" | "right" | "front" | "floor" }) {
  const glyph = {
    left: (
      <>
        <rect x="11" y="4" width="6" height="12" rx="1.4" />
        <circle cx="5.5" cy="13.5" r="2.3" />
      </>
    ),
    right: (
      <>
        <rect x="3" y="4" width="6" height="12" rx="1.4" />
        <circle cx="14.5" cy="13.5" r="2.3" />
      </>
    ),
    front: (
      <>
        <rect x="7" y="3.5" width="6" height="11" rx="1.4" />
        <circle cx="10" cy="15" r="2.3" />
      </>
    ),
    floor: (
      <>
        <path d="M3 16h14" />
        <circle cx="10" cy="12.5" r="2.6" />
      </>
    ),
  }[id];
  return (
    <svg
      width="13"
      height="13"
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

/** Cutout-shape tiles, the `BgTypeIcon` sibling scoped to `FrameShape`. */
function FrameShapeIcon({ id }: { id: FrameShape }) {
  const shape = {
    rect: <rect x="4" y="4" width="12" height="12" />,
    "rounded-rect": <rect x="4" y="4" width="12" height="12" rx="3" />,
    squircle: <path d="M10 4c4.5 0 6 1.5 6 6s-1.5 6-6 6-6-1.5-6-6 1.5-6 6-6z" />,
    circle: <circle cx="10" cy="10" r="6.5" />,
    capsule: <rect x="3" y="6" width="14" height="8" rx="4" />,
    none: <rect x="4" y="4" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
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

/** Corner-preset glyphs: one magnified top-left corner drawn at the preset's real rounding. */
function VwCornerIcon({ id }: { id: "sharp" | "subtle" | "macos" | "rounded" }) {
  const r = { sharp: 0, subtle: 1.5, macos: 3.5, rounded: 7 }[id];
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {r === 0 ? (
        <path d="M16.5 4.5H4.5V16.5" />
      ) : (
        <path d={`M16.5 4.5H${4.5 + r}A${r} ${r} 0 0 0 4.5 ${4.5 + r}V16.5`} />
      )}
    </svg>
  );
}

/** Motion-preset pictograms matching sampleVideoWindowMotion: float bobs on Y, drift sways in rotation, tilt swings flush from a tilted start, push grows from 90%. */
function VwMotionIcon({ id }: { id: VideoWindowMotionPreset }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {id === "none" ? (
        <rect x="4.5" y="6" width="11" height="8" rx="1.5" />
      ) : id === "float" ? (
        <>
          <rect x="4.5" y="6.5" width="11" height="7" rx="1.5" />
          <path d="M10 2.5v2M10 15.5v2" />
        </>
      ) : id === "drift" ? (
        <rect x="4.5" y="6.5" width="11" height="7" rx="1.5" transform="rotate(-9 10 10)" />
      ) : id === "tilt-reveal" ? (
        <path d="M5 4.5l10.5 2v7L5 15.5z" />
      ) : (
        <>
          <rect x="3.5" y="5" width="13" height="10" rx="1.5" />
          <rect x="6.5" y="7.5" width="7" height="5" rx="1" />
        </>
      )}
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

/** A decoration's display name: its first line of text, else its asset basename. */
function decorationLabel(d: FrameDecorationSpec): string {
  if (isTextDecoration(d)) return d.text?.split("\n")[0] || "Text";
  const src = d.src ?? "";
  return src.split("/").pop() || src;
}

/** A unique decoration id from a stem, deduped against the existing ids. */
function uniqueDecorationId(stem: string, taken: Set<string>): string {
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/** A unique decoration id from a picked asset's stem. */
function nextDecorationId(src: string, taken: Set<string>): string {
  const base = src.split("/").pop() || src;
  return uniqueDecorationId(base.replace(/\.[^.]+$/, "") || "decoration", taken);
}

/** The Animations section body: orbit-pose numerics (decision 5, the real model, not the mock's pos/rot) editing the selected-else-nearest key via `setKeyPose` → `useCameraDoc.commit` (history rides "camera edit" for free); an empty track commits a lone key at 0, the whole-scene static reframe, exactly the CameraToolOverlay's seed. */
function CameraSectionBody({
  project,
  sceneIndex,
  onDocChanged,
  onBack,
  patchDoc,
}: {
  project: LoadedProject;
  sceneIndex: number;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onBack: () => void;
  patchDoc: (patch: (next: SceneDoc) => void) => Promise<void>;
}) {
  const {
    doc,
    slot,
    mode,
    camera,
    rig,
    preview,
    previewRig,
    commit,
    commitRig,
    setMode,
    appliedPoseAt,
    appliedRigAt,
    appliedViewAt,
  } = useCameraDoc(project, sceneIndex, onDocChanged);
  const free = mode === "rig";
  const format = useFormat();
  const { requestFreeMode, freeCameraWarning } = useFreeCameraWarning(project, sceneIndex);
  const aspect = format.width / format.height;
  const banded = useSceneIsBanded(sceneIndex);
  const lsAnimated = doc?.animatedTrack === "layeredScreenshot";
  const selectedKeyId = useCameraEditStore((s) => s.selectedKeyId);
  const cameraOpen = useCameraEditStore((s) => s.open);
  const detailedLane = useUiStore((s) => s.detailedAnimationView);
  const setDetailedLane = useUiStore((s) => s.setDetailedAnimationView);
  const keyCount = free ? rig.keys.length : camera.keys.length;
  // Re-render only when the target key changes, not per playhead tick; for a trackless scene, follow the playhead in coarse quarter-second buckets (display only, commits snapshot the live clock).
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
  const targetKey = camera.keys.find((k) => k.id === targetKeyId) ?? null;
  const rigKey = rig.keys.find((k) => k.id === targetKeyId) ?? null;
  const pose: SceneDocCameraPose = targetKey?.pose ?? appliedPoseAt(coarseLocal);
  const rigPose: SceneDocRigPose = rigKey?.pose ?? appliedRigAt(coarseLocal);
  const rigTargetTMs = rigKey?.tMs ?? coarseLocal;

  const rigPosePatch = (mutate: (p: SceneDocRigPose) => void): RigDoc => {
    const next: SceneDocRigPose = {
      ...rigPose,
      position: [...rigPose.position],
      aim: { ...rigPose.aim, at: [...rigPose.aim.at] },
    };
    mutate(next);
    return seedRig(rig, rigKey?.id ?? null, next);
  };
  const previewRigPose = (mutate: (p: SceneDocRigPose) => void) =>
    previewRig(rigPosePatch(mutate), false);
  const commitRigPose = (mutate: (p: SceneDocRigPose) => void) => {
    const seeding = !rigKey;
    void commitRig(rigPosePatch(mutate));
    if (seeding) useCameraEditStore.getState().select("k1", null);
  };

  const posePatch = (mutate: (p: SceneDocCameraPose) => void): CameraDoc => {
    const next: SceneDocCameraPose = { ...pose, target: [...pose.target] };
    mutate(next);
    return targetKey
      ? (setKeyPose(camera, targetKey.id, next) ?? camera)
      : { keys: [{ id: "k1", tMs: 0, pose: next }], segments: [] };
  };

  /** Live drag tick: render the pose through the store draft, no doc write, no undo. */
  const previewPose = (mutate: (p: SceneDocCameraPose) => void) =>
    preview(posePatch(mutate), false);

  const commitPose = (mutate: (p: SceneDocCameraPose) => void) => {
    const seeding = !targetKey;
    void commit(posePatch(mutate));
    // Empty track: a lone key at 0 = static reframe (the overlay's seed).
    if (seeding) useCameraEditStore.getState().select("k1", null);
  };

  /** Per-key Reset (decision 6, moved here from the old strip's tools row): the selected-else-nearest key back to the scene-default pose, in whichever mode drives the scene. */
  const onResetKey = () => {
    if (free) {
      if (!rigKey) return;
      const next = setKeyPose(rig, rigKey.id, defaultRigPose());
      if (next) void commitRig(next as RigDoc);
      return;
    }
    if (!targetKey) return;
    const cam = setKeyPose(camera, targetKey.id, defaultOrbitPose());
    if (cam) void commit(cam);
  };

  /** The Orbit/Free switch plus the one-history-entry conversions between them. Switching alone never touches keys; converting rewrites them so the applied pose is unchanged. */
  const modeControl = (
    <>
      <SegmentedRow
        options={[
          {
            value: "orbit" as const,
            label: "Orbit",
            icon: <SceneRowIcon id="camera.orbit" />,
            title: "Poses orbit a target",
          },
          {
            value: "rig" as const,
            label: "Free",
            icon: <SceneRowIcon id="camera.free" />,
            title: "Free-flight poses: a position and an aim",
          },
        ]}
        value={mode}
        onChange={(next) => {
          if (next === "rig") requestFreeMode(() => void setMode("rig", coarseLocal));
          else void setMode("orbit", coarseLocal);
        }}
      />
      {!free && camera.keys.length > 0 && (
        <button
          type="button"
          className="inspector-reset-btn"
          title="Rewrite every orbit key as a free pose; the shot does not move"
          onClick={() =>
            requestFreeMode(() => {
              void commitRig(orbitToRig(camera));
              void setMode("rig", coarseLocal);
            })
          }
        >
          Convert to free
        </button>
      )}
      {free && canRigConvertToOrbit(rig) && (
        <button
          type="button"
          className="inspector-reset-btn"
          title="Rewrite every free pose as an orbit key; field of view and roll are dropped"
          onClick={() => {
            const next = rigToOrbit(rig);
            if (!next) return;
            void commit(next);
            void setMode("orbit", coarseLocal);
          }}
        >
          Convert to orbit
        </button>
      )}
      <ToggleRow
        label="Detailed animation view"
        description="Draw keyframes on every animation lane as narrow lines instead of diamonds, for finer editing."
        checked={detailedLane}
        onChange={setDetailedLane}
      />
    </>
  );

  const presetRow = (
    <CameraPresetRow
      durationMs={slot.durationMs}
      orbitPose={pose}
      fov={appliedViewAt(coarseLocal).fov}
      hasKeys={keyCount > 0}
      icon={<SceneRowIcon id="camera.animate" />}
      onApply={(result) => {
        if (result.mode === "rig" && result.rig) {
          void commitRig(result.rig);
          void setMode("rig", coarseLocal);
        } else if (result.camera) {
          void commit(result.camera);
          void setMode("orbit", coarseLocal);
        }
      }}
    />
  );

  /** Only legal on the first key of a scene that has one before it. */
  const continuityRow =
    free && sceneIndex > 0 && rig.keys.length > 0 ? (
      <ToggleRow
        label="Continue from previous scene"
        description="Start this scene where the previous one's camera stopped. A continuous PATH, not a continuous image: content still dissolves across a transition."
        checked={rig.keys[0].continueFromPrevious === true}
        onChange={(on) => {
          const keys = rig.keys.map((key, i) => {
            if (i !== 0) return key;
            const next = { ...key };
            if (on) next.continueFromPrevious = true;
            else delete next.continueFromPrevious;
            return next;
          });
          void commitRig({ ...rig, keys });
        }}
      />
    ) : null;

  const rigOptions = (
    <>
      {modeControl}
      <CameraRigFields
        doc={doc}
        rig={rig}
        pose={rigPose}
        targetKeyId={rigKey?.id ?? null}
        appliedView={appliedViewAt(rigTargetTMs)}
        aspect={aspect}
        banded={banded}
        frame={format.frame}
        previewPose={previewRigPose}
        commitPose={commitRigPose}
        commitRig={(next: RigDoc) => void commitRig(next)}
      />
      <ActionRow
        icon={<SceneRowIcon id="camera.animate" />}
        label="Animate scene"
        value={
          rig.keys.length > 0
            ? `${rig.keys.length} key${rig.keys.length === 1 ? "" : "s"}`
            : undefined
        }
        selected={cameraOpen}
        onClick={() => useCameraEditStore.getState().setOpen(!cameraOpen)}
      />
      {presetRow}
      {continuityRow}
    </>
  );

  const cameraOptions = (
    <>
      {modeControl}
      <div className="inspector-pose-grid">
        <NumberField
          label="orbit °"
          value={pose.azimuthDeg}
          decimals={1}
          dragScale={0.5}
          onInput={(n) => previewPose((p) => (p.azimuthDeg = n))}
          onCommit={(n) => commitPose((p) => (p.azimuthDeg = n))}
        />
        <NumberField
          label="tilt °"
          value={pose.elevationDeg}
          decimals={1}
          dragScale={0.5}
          onInput={(n) => previewPose((p) => (p.elevationDeg = n))}
          onCommit={(n) => commitPose((p) => (p.elevationDeg = n))}
        />
        <NumberField
          label="distance"
          value={pose.distance}
          decimals={2}
          dragScale={0.02}
          onInput={(n) => previewPose((p) => (p.distance = n))}
          onCommit={(n) => commitPose((p) => (p.distance = n))}
        />
      </div>
      <div className="inspector-pose-grid">
        <NumberField
          label="target x"
          value={pose.target[0]}
          decimals={2}
          dragScale={0.02}
          onInput={(n) => previewPose((p) => (p.target[0] = n))}
          onCommit={(n) => commitPose((p) => (p.target[0] = n))}
        />
        <NumberField
          label="target y"
          value={pose.target[1]}
          decimals={2}
          dragScale={0.02}
          onInput={(n) => previewPose((p) => (p.target[1] = n))}
          onCommit={(n) => commitPose((p) => (p.target[1] = n))}
        />
        <NumberField
          label="target z"
          value={pose.target[2]}
          decimals={2}
          dragScale={0.02}
          onInput={(n) => previewPose((p) => (p.target[2] = n))}
          onCommit={(n) => commitPose((p) => (p.target[2] = n))}
        />
      </div>
      <DofFields
        keys={camera.keys}
        targetKeyId={targetKey?.id ?? null}
        authored={pose.dof}
        autoDistance={pose.distance}
        autoLabel="the target"
        preview={(next) =>
          previewPose((p) => {
            if (next) p.dof = next;
            else delete p.dof;
          })
        }
        commit={(next) =>
          commitPose((p) => {
            if (next) p.dof = next;
            else delete p.dof;
          })
        }
        commitAll={(map) =>
          void commit({
            ...camera,
            keys: camera.keys.map((key) => {
              const dof = map(key.pose.dof);
              const nextPose = { ...key.pose };
              if (dof) nextPose.dof = dof;
              else delete nextPose.dof;
              return { ...key, pose: nextPose };
            }),
          })
        }
      />
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
      {presetRow}
      {camera.keys.length > 1 && (
        <>
          <ToggleRow
            label="Loop in Present"
            description="In slideshow Present mode, the camera eases back to its first key each cycle. Video playback and export are untouched."
            checked={camera.presentLoop !== undefined}
            onChange={(on) => {
              if (on) {
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
          {camera.presentLoop && (
            <div className="camera-loop-modes">
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
                <NumberField
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
    </>
  );

  return (
    <div className="inspector-drill">
      <DrillBack label="Scene" onClick={onBack} />
      <div className="inspector-drill-title">Animations</div>
      {keyCount > 0 && (
        <div className="inspector-drill-reset">
          <button
            type="button"
            className="inspector-reset-btn"
            title="Reset this key to the scene-default pose"
            onClick={onResetKey}
          >
            Reset
          </button>
        </div>
      )}
      <div className="inspector-drill-body inspector-section-body">
        {doc?.layeredScreenshot ? (
          <ToggleFieldset
            control={
              // One animated track per scene: the toggle stands one track down, never deletes keys.
              <SegmentedRow
                options={[
                  {
                    value: "camera",
                    label: "Camera",
                    icon: <SceneRowIcon id="camera.animate" />,
                    title: "Animate this scene with the camera track",
                  },
                  {
                    value: "layeredScreenshot",
                    label: "Screenshot stack",
                    icon: <SceneRowIcon id="layeredScreenshot.edit" />,
                    title:
                      "Animate this scene with the screenshot stack's pose track (the camera stands down; its keys are kept)",
                  },
                ]}
                value={lsAnimated ? "layeredScreenshot" : "camera"}
                onChange={(track) => {
                  if (track === "camera") {
                    useLayeredScreenshotEditStore.getState().setLaneOpen(false);
                    void patchDoc((next) => {
                      delete next.animatedTrack;
                    });
                  } else {
                    useCameraEditStore.getState().setOpen(false);
                    void patchDoc((next) => {
                      next.animatedTrack = "layeredScreenshot";
                    });
                  }
                }}
              />
            }
          >
            {lsAnimated && (
              <p className="modal-hint">
                This scene animates the screenshot stack; the camera track is standing down.
              </p>
            )}
            {free ? rigOptions : cameraOptions}
          </ToggleFieldset>
        ) : free ? (
          rigOptions
        ) : (
          cameraOptions
        )}
      </div>
      {freeCameraWarning}
    </div>
  );
}

/** Alignment chips for the text.edit drill-in; UI labels use Australian spelling, the stored value is always troika's "center". */
const ALIGN_OPTIONS: { id: SceneTextAlign; label: string }[] = [
  { id: "left", label: "Left" },
  { id: "center", label: "Centre" },
  { id: "right", label: "Right" },
];

/** Where the line-spacing slider parks for troika's own "normal" spacing; landing here clears the override, so an untouched field keeps rendering exactly as it always has. */
const LINE_SPACING_NORMAL = 1.2;

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
    case "scene3d":
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
          <path d="M3 15.5h14" />
          <path d="M7.2 15.5L9 7.5M12.8 15.5L11 7.5" />
          <path d="M4.8 12.5h10.4M6.3 9.8h7.4" opacity="0.45" />
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

/** Applies a picked recording to the doc's video window and defaults the scene length to follow it (a manual length stays put, the device-picker rule); `meta` seeds the stored aspect so the window keeps its size before frames arrive, and `recording` (when detection ran) sets the window-recording crop to match the new clip. */
function applyVideoWindowMedia(
  next: SceneDoc,
  src: string,
  meta: MediaMeta | null,
  recording?: boolean,
) {
  if (!next.videoWindow) return;
  const media = { ...next.videoWindow.media, src };
  if (meta && meta.width > 0 && meta.height > 0) media.aspect = meta.width / meta.height;
  else delete media.aspect;
  next.videoWindow.media = media;
  if (recording !== undefined) next.videoWindow.recording = recording;
  if (next.duration?.mode !== "manual") {
    next.duration = { mode: "follow-media", source: "videoWindow" };
  }
}

export function SceneTab({
  project,
  sceneIndex,
  sceneTheme,
  onOpenEditVideo,
  onDocChanged,
  onTimingChanged,
  onOpenTheme,
  onEditThemeInClaude,
  onThemeEdited,
  themesRefreshKey,
  mediaRefreshKey,
  onDeleteScene,
}: {
  project: LoadedProject;
  sceneIndex: number;
  sceneTheme: Theme | undefined;
  onOpenEditVideo: (
    sceneIndex: number,
    mediaRel: string,
    slot?: "device" | "background" | "videoWindow",
    deviceId?: string,
  ) => void;
  onDocChanged: (sceneIndex: number, doc: SceneDoc) => void;
  onTimingChanged: () => void;
  /** Open ThemeMode, optionally on a pane (the theme context menu). */
  onOpenTheme: (manage?: { view: "fonts" | "duplicate"; themeId: string }) => void;
  onEditThemeInClaude: (choice: { id: string; name: string }) => void;
  onThemeEdited: (wsId: string, json: string) => Promise<void>;
  themesRefreshKey: number;
  /** Bumped by the main window's media-changed listener so pickers surface fresh renders. */
  mediaRefreshKey: number;
  /** Trash-recoverable scene removal (the bottom Delete row; Rust guards the last scene). */
  onDeleteScene: (sceneIndex: number) => void;
}) {
  const { slug, doc, scene, error, setError, patchDoc, commitFromBaseline, commitDuration } =
    useSceneDocPatch(project, sceneIndex, onDocChanged, onTimingChanged);
  const drillIn = useUiStore((s) => s.inspector.drillIn);
  const drillStack = useUiStore((s) => s.inspector.drillStack);
  // The back bar names the screen it pops to: the parent group (or a detail with children), else the row list.
  const backLabel =
    drillStack.length > 1 ? (SCREEN_TITLES[drillStack[drillStack.length - 2]] ?? "Scene") : "Scene";
  const openDrill = useUiStore((s) => s.openInspectorDrill);
  const jumpDrill = useUiStore((s) => s.jumpInspectorDrill);
  const closeDrill = useUiStore((s) => s.closeInspectorDrill);
  const resetDrill = useUiStore((s) => s.resetInspectorDrill);
  const selectedDecoId = useDecorationEditStore((s) => s.selectedId);
  const selectDeco = useDecorationEditStore((s) => s.select);
  // The text gizmo's selection, reflected both ways: touching a key's fields shows its handles, and a canvas click scrolls the drill to that key.
  const selectedTextKey = useTextEditStore((s) =>
    s.selected?.sceneIndex === sceneIndex ? s.selected.key : null,
  );
  const textFieldRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!selectedTextKey) return;
    const el = textFieldRefs.current[selectedTextKey];
    // Skip when the selection came from focusing a field, so typing never scrolls the panel.
    if (!el || el.contains(document.activeElement)) return;
    el.scrollIntoView({ block: "nearest" });
  }, [selectedTextKey]);
  const decoMediaRequestId = useDecorationEditStore((s) => s.mediaRequestId);
  const requestDecoMedia = useDecorationEditStore((s) => s.requestMedia);
  // The gizmo's "Change media" action routes through here to reuse the scene media picker.
  useEffect(() => {
    if (!decoMediaRequestId) return;
    setMediaTarget({ kind: "decoration", replaceId: decoMediaRequestId });
    setModal("media");
    requestDecoMedia(null);
  }, [decoMediaRequestId, requestDecoMedia]);

  const [modal, setModal] = useState<"media" | null>(null);
  // What a media pick targets: a scene device by id, or a decoration (append, or replace one by id).
  const [mediaTarget, setMediaTarget] = useState<
    { kind: "device"; deviceId?: string } | { kind: "decoration"; replaceId?: string }
  >({ kind: "device" });
  // Which device the device rows act on; null (or a stale id) falls back to the first device. Store-held (the objectEditStore idiom) so a preview gizmo can attach to the same selection.
  const pickedDeviceId = useDeviceEditStore((s) =>
    s.selected?.sceneIndex === sceneIndex ? s.selected.deviceId : null,
  );
  const pickDevice = useCallback(
    (id: string | null) =>
      useDeviceEditStore.getState().select(id ? { sceneIndex, deviceId: id } : null),
    [sceneIndex],
  );
  const deviceGizmoMode = useDeviceEditStore((s) => s.gizmoMode);
  // Outlines, click-to-select and the handles all follow the open section, not one deep drill.
  const devicesSectionOpen = useGizmoSectionOpen("devices");
  const objectsSectionOpen = useGizmoSectionOpen("objects");
  const chartSectionOpen = useGizmoSectionOpen("chart");
  // Which staged object the placement drill targets, plus the library picker modal.
  const [pickedObjectId, setPickedObjectId] = useState<string | null>(null);
  const [objectPickerOpen, setObjectPickerOpen] = useState(false);
  const gizmoMode = useObjectEditStore((s) => s.gizmoMode);
  // The comparison drill's side pill and its full-height media screen's target device.
  const [compareSide, setCompareSide] = useState<"a" | "b">("a");
  const [compareMediaDeviceId, setCompareMediaDeviceId] = useState<string | null>(null);
  const [confirmRemoveCompare, setConfirmRemoveCompare] = useState(false);
  // Snapshot at the start of a comparison slider drag: live ticks write history-less, release records one entry.
  const compareDragBaseline = useRef<SceneDoc | null>(null);
  // Which document the background/lighting drills edit: the scene itself, or the comparison's after side (set at every drill entry point, reset on scene change).
  const [bgTarget, setBgTarget] = useState<"scene" | "compareB">("scene");
  const [lightingTarget, setLightingTarget] = useState<"scene" | "compareB">("scene");
  const [thumbs, setThumbs] = useState<Record<string, string> | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRemoveVideoWindow, setConfirmRemoveVideoWindow] = useState(false);
  // Snapshot of the doc at the start of a videoWindow slider drag: live ticks write history-less, release records one entry.
  const vwDragBaseline = useRef<SceneDoc | null>(null);
  // The Position drill's drag baseline (same pattern).
  const posDragBaseline = useRef<SceneDoc | null>(null);
  // The Text drill's line-spacing drag baseline (same pattern).
  const lineDragBaseline = useRef<SceneDoc | null>(null);
  // The bottom Delete-scene row's two-step confirm (the house self-disarming pattern).
  const [confirmDeleteScene, setConfirmDeleteScene] = useState(false);
  const [confirmApplyAll, setConfirmApplyAll] = useState(false);
  const [mediaRefresh, setMediaRefresh] = useState(0);
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const textEditTimer = useRef<number | null>(null);
  const textEditBaseline = useRef<SceneDoc | null>(null);
  // The header-icon field mirrors the text-field debounce so half-typed paths don't hit the renderer per keystroke.
  const [iconDraft, setIconDraft] = useState<string | null>(null);
  const iconEditTimer = useRef<number | null>(null);
  const iconEditBaseline = useRef<SceneDoc | null>(null);
  // Text fields commit on a 200ms debounce (history-less live preview); the session finalises to one undo on blur.
  const liveText = (key: string, value: string) => {
    setTextValues((v) => ({ ...v, [key]: value }));
    if (!textEditBaseline.current && doc) textEditBaseline.current = structuredClone(doc);
    if (textEditTimer.current !== null) window.clearTimeout(textEditTimer.current);
    // The handle check keeps a write detached by a scene change from clearing the new scene's own.
    const id = window.setTimeout(() => {
      if (textEditTimer.current === id) textEditTimer.current = null;
      void patchDoc(
        (next) => {
          next.text = { ...(next.text ?? {}), [key]: value };
        },
        { history: false },
      );
    }, 200);
    textEditTimer.current = id;
  };
  const flushText = () => {
    if (textEditTimer.current !== null) {
      window.clearTimeout(textEditTimer.current);
      textEditTimer.current = null;
    }
    const baseline = textEditBaseline.current;
    if (!baseline) return;
    textEditBaseline.current = null;
    const merged = { ...(doc?.text ?? {}), ...textValues };
    setTextValues({});
    void commitFromBaseline(baseline, (next) => {
      next.text = merged;
    });
  };
  /** Header preview fallback: a current-frame capture when no cached thumb exists. An object URL, revoked on replacement/unmount. */
  const [liveThumb, setLiveThumb] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  /** Background drill: viewing the Gradient/Image/Video tab before anything is committed; every other tab derives from the doc itself. */
  const [bgTabOverride, setBgTabOverride] = useState<
    "gradient" | "image" | "video" | "shader" | "scene3d" | null
  >(null);
  /** Overlay panel drill: viewing the Gradient/Image tab before anything is committed (the background drill's idiom). */
  const [panelTabOverride, setPanelTabOverride] = useState<"gradient" | "image" | null>(null);
  /** Which animated-fill card is hovered (its clip preview plays). */
  const [bgHover, setBgHover] = useState<string | null>(null);
  /** Which 3D-backing editor is open when it doesn't match the stored backing type. */
  const [backingTabOverride, setBackingTabOverride] = useState<"gradient" | "shader" | null>(null);
  const codedMotion = useSceneHasCodedTextMotion(sceneIndex);
  /** The mounted stage's resolved backdrop type; null when the scene mounts no SceneStage. */
  const stagedBackdrop = useSceneStageBackdrop(sceneIndex);
  const [themeChoices, setThemeChoices] = useState<ThemeChoice[]>([]);
  const [themeDraft, setThemeDraft] = useState<string>("");

  const devices = doc?.devices ?? [];
  const device = devices.find((d) => d.id === pickedDeviceId) ?? devices[0];
  const deviceId = device?.id;
  // Read by the ensure-select subscription below, which fires on store writes rather than renders.
  const deviceIdsRef = useRef<string[]>([]);
  deviceIdsRef.current = devices.map((d) => d.id);
  const devicePillOptions = devices.map((d, i) => ({
    value: d.id,
    label: `${i + 1}`,
    icon: <DevicePillIcon model={d.model} />,
    title: DEVICE_CATALOG[(d.model in DEVICE_CATALOG ? d.model : "iphone-15-pro") as DeviceId].name,
  }));
  const objects = doc?.objects ?? [];
  const stagedObject = objects.find((o) => o.id === pickedObjectId) ?? objects[0];
  // The gizmo posts drags here (patchDoc lives in this DOM tree, not the canvas): land ONE history entry per drag.
  const patchDocRef = useRef(patchDoc);
  patchDocRef.current = patchDoc;
  useEffect(() => {
    return useObjectEditStore.subscribe((s) => {
      const commit = s.pendingCommit;
      if (!commit) return;
      // Cleared even for another scene (a click during a transition can select one): only the dominant scene has a doc to write here, so an unclaimed drag is dropped, never left to land later.
      useObjectEditStore.getState().clearCommit();
      if (commit.sceneIndex !== sceneIndex) return;
      void patchDocRef.current((next) => {
        const o = next.objects?.find((x) => x.id === commit.objectId);
        if (o) o.placement = commit.placement;
      });
    });
  }, [sceneIndex]);
  // The preview gizmo follows the open Objects section; leaving it (or the scene) deselects.
  const stagedObjectId = stagedObject?.id;
  useEffect(() => {
    const store = useObjectEditStore.getState();
    if (objectsSectionOpen && stagedObjectId !== undefined) {
      store.select({ sceneIndex, objectId: stagedObjectId });
      return () => useObjectEditStore.getState().select(null);
    }
    if (store.selected) store.select(null);
  }, [objectsSectionOpen, sceneIndex, stagedObjectId]);
  // A canvas click selects in the store, so the drill rows follow it (the mirror only writes non-null ids, so the deselect above cannot bounce back).
  const selectedObjectId = useObjectEditStore((s) =>
    s.selected?.sceneIndex === sceneIndex ? s.selected.objectId : null,
  );
  useEffect(() => {
    if (selectedObjectId) setPickedObjectId(selectedObjectId);
  }, [selectedObjectId]);
  // The staged chart's gizmo, same contract: it posts finished drags here, and follows its own drill.
  useEffect(() => {
    return useChartEditStore.subscribe((s) => {
      const commit = s.pendingCommit;
      if (!commit) return;
      useChartEditStore.getState().clearCommit();
      if (commit.sceneIndex !== sceneIndex) return;
      void patchDocRef.current((next) => {
        if (next.chart) next.chart.placement = commit.placement;
      });
    });
  }, [sceneIndex]);
  useEffect(() => {
    const store = useChartEditStore.getState();
    if (chartSectionOpen) {
      store.select({ sceneIndex });
      return () => useChartEditStore.getState().select(null);
    }
    if (store.selected) store.select(null);
  }, [chartSectionOpen, sceneIndex]);
  // The device gizmo's finished drags, through the Position drill's own write paths so a laid-out scene keeps editing its delta.
  useEffect(() => {
    return useDeviceEditStore.subscribe((s) => {
      const commit = s.pendingCommit;
      if (!commit) return;
      useDeviceEditStore.getState().clearCommit();
      if (commit.sceneIndex !== sceneIndex) return;
      void patchDocRef.current((next) => {
        if (commit.kind === "delta") {
          mutateDelta(next, commit.deviceId, (d) => Object.assign(d, commit.delta));
        } else {
          mutatePlacement(next, commit.deviceId, (p) => Object.assign(p, commit.placement));
        }
      });
    });
  }, [sceneIndex]);
  // The device pills fall back to the first device implicitly; the canvas cannot, since a cleared store MUST mean no gizmo. The subscription (not just the body) is what re-selects after an export clears the store mid-session.
  useEffect(() => {
    if (!devicesSectionOpen || deviceId === undefined) return;
    const ensure = () => {
      const store = useDeviceEditStore.getState();
      const sel = store.selected;
      // A removed device leaves a selection nothing else repairs (no gizmo, and with one device left no pill to click back), so an id this scene no longer has counts as empty.
      const stale =
        sel !== null &&
        sel.sceneIndex === sceneIndex &&
        !deviceIdsRef.current.includes(sel.deviceId);
      if (sel === null || stale) store.select({ sceneIndex, deviceId });
    };
    ensure();
    return useDeviceEditStore.subscribe(ensure);
  }, [devicesSectionOpen, deviceId, sceneIndex]);
  // Declared after the ensure effect on purpose: cleanups run in declaration order, so the subscription is gone before this clears.
  useEffect(() => () => useDeviceEditStore.getState().select(null), []);
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

  // Collapse transient state when the playhead moves to another scene. The open screen stays put
  // where the new scene has it (its editor reads the new doc), else it pops back a level.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate reset-on-scene
  useEffect(() => {
    setModal(null);
    setConfirmRemove(false);
    pickDevice(null);
    setCompareSide("a");
    setCompareMediaDeviceId(null);
    setConfirmRemoveCompare(false);
    setBgTarget("scene");
    setLightingTarget("scene");
    // Text drafts are keyed by field name, not by scene, so a leftover would shadow the new
    // scene's text. A pending debounce is detached rather than cancelled: its closure holds the
    // old scene's patchDoc, so unflushed typing still lands on the scene it was typed in.
    setTextValues({});
    textEditTimer.current = null;
    textEditBaseline.current = null;
    setIconDraft(null);
    iconEditTimer.current = null;
    iconEditBaseline.current = null;
    setThemeDraft(doc?.themeId ?? "");
    const kept = drillStackForScene(drillStack, {
      hasDoc: !!doc,
      textKeys: Object.keys(doc?.text ?? {}),
      hasDevice: devices.length > 0,
      hasObject: objects.length > 0,
      hasOverlay: project.deckFrame !== undefined || doc?.frame?.cutout !== undefined,
    });
    if (kept.length !== drillStack.length) {
      if (kept.length === 0) resetDrill();
      else jumpDrill(kept);
    }
    setRenaming(false);
    setBgTabOverride(null);
    setPanelTabOverride(null);
    setBackingTabOverride(null);
    setLiveThumb((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [sceneIndex, resetDrill, jumpDrill]);

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

  // Drill-ins + inline modals close on Esc, popping one level like the back bar.
  useEscapeClose(() => closeDrill(), drillIn !== null);
  useEscapeClose(() => setModal(null), modal === "media");

  // Re-list theme choices when the drill opens or ThemeMode closes over it: Manage keeps the drill open, so edits must show in place.
  useEffect(() => {
    void themesRefreshKey; // re-list on ThemeMode close
    if (drillIn === "style.theme" || drillIn === "compare.edit" || drillIn === "compare.theme") {
      void listThemeChoices().then(setThemeChoices);
    }
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

  const sceneFrame = project.sceneFrames[sceneIndex];
  const sections = sceneSections({
    doc,
    slotsCount: project.slots.length,
    deckFrame: project.deckFrame !== undefined,
    frame: sceneFrame,
    selectedDeviceId: pickedDeviceId ?? undefined,
  });

  /** Mutate the selected device in place; a no-op when the scene has none. */
  const patchDevice = (fn: (d: NonNullable<SceneDoc["devices"]>[number]) => void) =>
    void patchDoc((next) => {
      const d = next.devices?.find((x) => x.id === deviceId);
      if (d) fn(d);
    });

  const freshDeviceId = () => {
    const used = new Set(devices.map((d) => d.id));
    let n = 1;
    while (used.has(`d${n}`)) n += 1;
    return `d${n}`;
  };
  const addDevice = () => {
    const id = freshDeviceId();
    // Later devices step outward alternately so a new one never lands inside an existing device.
    const k = devices.length;
    const x = k === 0 ? 0 : DEVICE_STEP_X * Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1);
    void patchDoc((next) => {
      // The Rust scaffolder's device defaults, byte for byte (the first device lands centred).
      next.devices = [
        ...(next.devices ?? []),
        {
          id,
          model: "iphone-17-pro",
          colour: "silver",
          placement: { position: [x, -0.3, 0], rotationDeg: [0, 0, 0], scale: 1 },
          motion: { preset: "none" },
          shadow: "soft",
        },
      ];
    });
    pickDevice(id);
  };
  const duplicateDevice = () => {
    if (!deviceId) return;
    const id = freshDeviceId();
    void patchDoc((next) => {
      const src = next.devices?.find((x) => x.id === deviceId);
      if (!src) return;
      const copy = structuredClone(src);
      copy.id = id;
      // Mirror across centre: flip x (a centred device steps one footprint aside) and the y rotation.
      const laptop = isDeviceId(src.model) && DEVICE_CATALOG[src.model].lid !== undefined;
      const step = (laptop ? LAPTOP_STEP_X : DEVICE_STEP_X) * (src.placement?.scale ?? 1);
      const [px = 0, py = -0.3, pz = 0] = src.placement?.position ?? [];
      const [rx = 0, ry = 0, rz = 0] = src.placement?.rotationDeg ?? [];
      copy.placement = {
        ...copy.placement,
        position: [px === 0 ? step : -px, py, pz],
        rotationDeg: [rx, -ry, rz],
      };
      next.devices = [...(next.devices ?? []), copy];
    });
    pickDevice(id);
  };
  const freshObjectId = () => {
    const used = new Set(objects.map((o) => o.id));
    let n = 1;
    while (used.has(`o${n}`)) n += 1;
    return `o${n}`;
  };
  const addObjectFromPicker = (objectId: string) => {
    const id = freshObjectId();
    // Beside the device when one is staged, else grounded at centre; a starting point to nudge from.
    const placement = device ? besideDevicePlacement(device, "right") : floorCentrePlacement();
    void patchDoc((next) => {
      next.objects = [...(next.objects ?? []), { id, objectId, placement }];
    });
    setPickedObjectId(id);
    setObjectPickerOpen(false);
    openDrill("objects.placement");
  };
  /** Mutate the drill's staged object in place; a no-op when the scene has none. */
  const patchObject = (fn: (o: NonNullable<SceneDoc["objects"]>[number]) => void) =>
    void patchDoc((next) => {
      const o = next.objects?.find((x) => x.id === stagedObjectId);
      if (o) fn(o);
    });

  const addCompare = () => {
    void patchDoc((next) => {
      // A visible starting point: line + chips on; the halves stay identical until the after side changes something.
      next.compare = {
        b: {},
        mask: { type: "linear", angleDeg: 90 },
        value: 0.5,
        chrome: { line: { width: 4, colour: "accent" }, chips: true },
      };
    });
    openDrill("compare.edit");
  };
  const addChart = () => {
    void patchDoc((next) => {
      next.chart = newChartBlock();
    });
    jumpDrill(["chart.edit"]);
  };
  const addOverlay = () =>
    void patchDoc((next) => {
      // The Rust scaffolder's Cutout start defaults, byte for byte; replaces wholesale so stale opt-out junk can't linger. No starter chip: the slide pass paints the panel and its cutout whether or not the panel carries content.
      next.frame = { cutout: { shape: "rounded-rect", side: "start" } };
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

  /** Route a background-drill mutation at its target: the scene's own `background`, or the comparison's after side. For the after side, side B's value swaps in before the mutation and transplants out after, so the drill's reads and writes work unchanged and every OTHER field still mutates the real doc. */
  const patchBgDoc = (mutate: (next: SceneDoc) => void, opts?: Parameters<typeof patchDoc>[1]) => {
    if (bgTarget !== "compareB") return patchDoc(mutate, opts);
    return patchDoc((next) => {
      const own = next.background;
      next.background = next.compare?.b?.background;
      mutate(next);
      const written = next.background;
      next.background = own;
      if (!next.compare) next.compare = {};
      if (!next.compare.b) next.compare.b = {};
      next.compare.b.background = written;
    }, opts);
  };
  /** The lighting drill's target routing, same transplant rule over `lighting`. */
  const patchLightingDoc = (
    mutate: (next: SceneDoc) => void,
    opts?: Parameters<typeof patchDoc>[1],
  ) => {
    if (lightingTarget !== "compareB") return patchDoc(mutate, opts);
    return patchDoc((next) => {
      const own = next.lighting;
      next.lighting = next.compare?.b?.lighting;
      mutate(next);
      const written = next.lighting;
      next.lighting = own;
      if (!next.compare) next.compare = {};
      if (!next.compare.b) next.compare.b = {};
      next.compare.b.lighting = written;
    }, opts);
  };
  const commitLightingFromBaseline = (baseline: SceneDoc, mutate: (next: SceneDoc) => void) => {
    if (lightingTarget !== "compareB") return commitFromBaseline(baseline, mutate);
    return commitFromBaseline(baseline, (next) => {
      const own = next.lighting;
      next.lighting = next.compare?.b?.lighting;
      mutate(next);
      const written = next.lighting;
      next.lighting = own;
      if (!next.compare) next.compare = {};
      if (!next.compare.b) next.compare.b = {};
      next.compare.b.lighting = written;
    });
  };

  /** Commit a video background pick; the card click and the menu's Select share it, and a previously set parallax (Drift) survives the src swap. Follow-media scenes sourced from the background re-sync their length to the new video. */
  const selectVideoBackground = (rel: string, meta: MediaMeta | null) => {
    if (meta && meta.kind !== "video") return;
    setBgTabOverride(null);
    void patchBgDoc(
      (next) => {
        const parallax =
          next.background && next.background.type !== "none" && next.background.type !== "scene3d"
            ? next.background.parallax
            : undefined;
        next.background =
          parallax !== undefined
            ? { type: "video", src: rel, parallax }
            : { type: "video", src: rel };
        // A staged backdrop would hide the video: clear it in the same undoable entry.
        if (stagedBackdrop !== null && stagedBackdrop !== "none") next.backdrop = { type: "none" };
      },
      { resync: true },
    );
  };

  const selectImageBackground = (rel: string, meta: MediaMeta | null) => {
    if (meta && meta.kind !== "image") return;
    setBgTabOverride(null);
    void patchBgDoc((next) => {
      const parallax =
        next.background && next.background.type !== "none" && next.background.type !== "scene3d"
          ? next.background.parallax
          : undefined;
      next.background =
        parallax !== undefined
          ? { type: "image", src: rel, parallax }
          : { type: "image", src: rel };
      // A staged backdrop would hide the image: clear it in the same undoable entry.
      if (stagedBackdrop !== null && stagedBackdrop !== "none") next.backdrop = { type: "none" };
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
  const pickMediaModal = (rel: string, meta: MediaMeta | null) => {
    setModal(null);
    if (mediaTarget.kind === "device") {
      const isVideo = meta?.kind !== "image";
      const targetId = mediaTarget.deviceId ?? deviceId;
      void patchDoc(
        (next) => {
          const d = next.devices?.find((x) => x.id === targetId);
          if (d) {
            d.media = { ...d.media, src: rel, kind: isVideo ? "video" : "image" };
            // A device video defaults the scene length to the clip, unless it was locked manually.
            if (isVideo && next.duration?.mode !== "manual") {
              next.duration = { mode: "follow-media", sourceDeviceId: d.id };
            }
          }
        },
        { resync: true },
      );
      return;
    }
    const decos = sceneFrame?.decorations ?? [];
    const { replaceId } = mediaTarget;
    // A pick always lands an IMAGE decoration, so a text one switching type drops its text fields.
    const nextDecos: FrameDecorationSpec[] = replaceId
      ? decos.map((d) =>
          d.id === replaceId
            ? { ...d, src: rel, text: undefined, colour: undefined, face: undefined }
            : d,
        )
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
  };
  const mediaModal = modal === "media" && (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal wizard-wide media-modal-wide">
        <div className="modal-title-row">
          <h2>{mediaTarget.kind === "decoration" ? "Choose image" : "Change video"}</h2>
        </div>
        <div className="wizard-media-host">
          <MediaBrowser
            slug={slug}
            projectPath={workspaceProjectPath(slug) ?? ""}
            kinds={mediaTarget.kind === "decoration" ? ["image"] : undefined}
            kindToggle={mediaTarget.kind === "device"}
            globalToggle
            refreshKey={mediaRefreshKey + mediaRefresh}
            onPick={pickMediaModal}
            cardMenu={mediaCardMenu({
              slug,
              primaryLabel: "Select",
              onPrimary: pickMediaModal,
              onChanged: () => setMediaRefresh((n) => n + 1),
              onError: setError,
            })}
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
  if (drillIn === "style.theme" && doc) {
    // Applies on selection; the draft doubles as the same-id de-dupe.
    const applySceneTheme = (id: string) => {
      if (id === themeDraft) return;
      setThemeDraft(id);
      // Theme resolution bakes at load; the write chains the nonce reload.
      void patchDoc((next) => {
        next.themeId = id || undefined;
      }).then(onTimingChanged);
    };
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">Scene theme</div>
        <div className="inspector-drill-body">
          <div className="font-slot-row">
            <button
              type="button"
              className={`chip${themeDraft === "" ? " selected" : ""}`}
              onClick={() => applySceneTheme("")}
            >
              Project theme
            </button>
          </div>
          <ThemeGrid
            choices={themeChoices}
            value={themeDraft}
            onChange={applySceneTheme}
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
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
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
          {cutout.shape !== "none" && (
            <>
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
            </>
          )}
        </div>
      </div>
    );
  }
  if (drillIn === "frame.panel" && sceneFrame) {
    const panelBg = sceneFrame.background;
    const panelObj = typeof panelBg === "object" ? panelBg : undefined;
    const panelTab = panelTabOverride ?? panelObj?.type ?? "color";
    const resolveColour = (c: string | undefined): string => {
      if (c === "background" || c === "text" || c === "accent" || c === "muted") {
        return sceneTheme?.colors[c] ?? c;
      }
      return c ?? sceneTheme?.colors.background ?? "#1e2226";
    };
    const commitPanel = (value: FrameSpec["background"] | undefined) => {
      setPanelTabOverride(null);
      void patchDoc((next) => {
        if (value === undefined) {
          if (next.frame) delete next.frame.background;
          return;
        }
        next.frame = { ...(next.frame ?? {}), background: value };
      });
    };
    const types: { id: typeof panelTab; label: string; icon: string }[] = [
      { id: "transparent", label: "Transparent", icon: "none" },
      { id: "color", label: "Colour", icon: "color" },
      { id: "gradient", label: "Gradient", icon: "gradient" },
      { id: "image", label: "Image", icon: "image" },
    ];
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">Panel background</div>
        <div className="inspector-drill-body">
          <div className="bg-type-grid" role="tablist" aria-label="Panel fill type">
            {types.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={panelTab === t.id}
                className={`bg-type-tile${panelTab === t.id ? " selected" : ""}`}
                onClick={() => {
                  if (t.id === "transparent") commitPanel({ type: "transparent" });
                  // Colour is the unset default's home too: leaving a sampled fill drops back to it.
                  else if (t.id === "color") {
                    if (panelObj) commitPanel(undefined);
                    else setPanelTabOverride(null);
                  } else setPanelTabOverride(t.id);
                }}
              >
                <BgTypeIcon id={t.icon} />
                {t.label}
              </button>
            ))}
          </div>
          {panelTab === "color" && (
            <>
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Colour</span>
                <ColourPicker
                  value={resolveColour(
                    typeof panelBg === "string"
                      ? panelBg
                      : panelObj?.type === "color"
                        ? panelObj.color
                        : undefined,
                  )}
                  label="Panel colour"
                  onCommit={(hex) => commitPanel(hex)}
                  onReset={() => commitPanel(undefined)}
                />
              </div>
              <p className="modal-hint">Leave unset for the neutral panel that suits the theme.</p>
            </>
          )}
          {panelTab === "gradient" && (
            <GradientPickerModal
              embedded
              current={panelObj?.type === "gradient" ? panelObj : undefined}
              theme={sceneTheme}
              onCancel={() => setPanelTabOverride(null)}
              onApply={(value) =>
                commitPanel(
                  value.spec
                    ? { type: "gradient", spec: value.spec }
                    : { type: "gradient", gradient: value.gradient },
                )
              }
            />
          )}
          {panelTab === "image" && (
            <>
              <p className="modal-hint">
                Fills the panel behind the overlay's content; it cover-crops per aspect, so pick an
                image with a safe centre.
              </p>
              <ActionRow
                icon={<SceneRowIcon id="frame.panel" />}
                label={panelObj?.type === "image" ? "Change image" : "Choose an image"}
                value={
                  panelObj?.type === "image"
                    ? middleTruncate(panelObj.src.split("/").pop() ?? "")
                    : undefined
                }
                onClick={() => openDrill("frame.panel.media")}
              />
            </>
          )}
          {panelTab === "transparent" && (
            <p className="modal-hint">
              No panel fill: the scene fills the whole frame and the overlay's text, chip and
              decorations sit over it.
            </p>
          )}
        </div>
      </div>
    );
  }
  if (drillIn === "frame.panel.media" && sceneFrame) {
    const panelBg = sceneFrame.background;
    const selectedSrc =
      typeof panelBg === "object" && panelBg.type === "image" ? panelBg.src : null;
    const selectPanelImage = (rel: string) => {
      setPanelTabOverride(null);
      void patchDoc((next) => {
        next.frame = { ...(next.frame ?? {}), background: { type: "image", src: rel } };
      });
    };
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">Panel image</div>
        <div className="inspector-drill-body">
          <div className="inspector-media-host">
            <MediaBrowser
              slug={slug}
              projectPath={workspaceProjectPath(slug) ?? ""}
              kinds={["image"]}
              globalToggle
              refreshKey={mediaRefreshKey + mediaRefresh}
              selectedRel={selectedSrc}
              onPick={selectPanelImage}
              cardMenu={mediaCardMenu({
                slug,
                primaryLabel: "Select",
                onPrimary: selectPanelImage,
                onChanged: () => setMediaRefresh((n) => n + 1),
                onError: setError,
              })}
            />
          </div>
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
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
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
    // Switching to text keeps the placement and drops the image-only fields; switching back rides the picker, since an image decoration needs a `src` to exist.
    const makeText = (d: FrameDecorationSpec) =>
      patchDeco(d.id, { text: d.text ?? "Text", src: undefined, shape: undefined });
    const addText = () =>
      writeDecos([
        ...decos,
        {
          id: uniqueDecorationId("text", new Set(decos.map((d) => d.id))),
          text: "Text",
          position: [0.45, -0.5],
          size: 0.05,
          layer: "above",
        },
      ]);
    const textColour = sceneTheme?.colors.text ?? "#ffffff";
    const decoColour = (c: string | undefined): string => {
      if (c === "background" || c === "text" || c === "accent" || c === "muted") {
        return sceneTheme?.colors[c] ?? c;
      }
      return c ?? textColour;
    };
    const shapes: { id: FrameDecorationShape; label: string }[] = [
      { id: "none", label: "Natural" },
      { id: "circle", label: "Circle" },
    ];
    const faces: { id: FrameDecorationFace; label: string }[] = [
      { id: "headline", label: "Headline" },
      { id: "body", label: "Body" },
    ];
    const layers: { id: FrameDecorationLayer; label: string }[] = [
      { id: "below", label: "Behind" },
      { id: "above", label: "In front" },
    ];
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">Decorations</div>
        <div className="inspector-drill-body">
          {decos.length === 0 && (
            <p className="modal-hint">
              Positioned images and text that break out of the panel, like a logo, an avatar or a
              hand-placed caption.
            </p>
          )}
          {decos.map((d) => {
            const isText = isTextDecoration(d);
            return (
              <div
                key={d.id}
                className={`deco-card${d.id === selectedDecoId ? " selected" : ""}`}
                onPointerDown={() => selectDeco(d.id)}
              >
                <div className="deco-card-head">
                  <span className="deco-card-name" title={isText ? d.text : d.src}>
                    {decorationLabel(d)}
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
                <div className="popover-row">
                  <span className="popover-inline">
                    Type
                    <div className="wizard-presets">
                      <button
                        type="button"
                        className={`chip${isText ? "" : " selected"}`}
                        onClick={() => openImagePicker(d.id)}
                      >
                        Image
                      </button>
                      <button
                        type="button"
                        className={`chip${isText ? " selected" : ""}`}
                        onClick={() => makeText(d)}
                      >
                        Text
                      </button>
                    </div>
                  </span>
                </div>
                {isText ? (
                  <>
                    <TextFieldRow
                      label="Text"
                      value={d.text ?? ""}
                      placeholder="Your text"
                      colour={{
                        value: decoColour(d.colour),
                        defaultValue: textColour,
                        onCommit: (hex) => patchDeco(d.id, { colour: hex }),
                        onReset: () => patchDeco(d.id, { colour: undefined }),
                      }}
                      onChange={(t) => patchDeco(d.id, { text: t })}
                    />
                    <div className="popover-row">
                      <span className="popover-inline">
                        Face
                        <div className="wizard-presets">
                          {faces.map((f) => (
                            <button
                              key={f.id}
                              type="button"
                              className={`chip${(d.face ?? "headline") === f.id ? " selected" : ""}`}
                              onClick={() => patchDeco(d.id, { face: f.id })}
                            >
                              {f.label}
                            </button>
                          ))}
                        </div>
                      </span>
                    </div>
                    <div className="popover-row">
                      <span className="popover-inline">
                        Font
                        <button
                          type="button"
                          className={`text-style-font${d.font ? " overridden" : ""}`}
                          title="Decoration font"
                          onClick={() => openDrill(`deco.font:${d.id}`)}
                        >
                          <span className="text-style-font-name">
                            {d.font ? parseFontString(d.font).family : "Theme font"}
                          </span>
                          <span className="text-style-font-chevron" aria-hidden>
                            ›
                          </span>
                        </button>
                      </span>
                    </div>
                    <div className="popover-row">
                      <span className="popover-inline slider-row-label">Line spacing</span>
                      <DebouncedRange
                        value={d.lineHeight ?? LINE_SPACING_NORMAL}
                        min={TEXT_LINE_HEIGHT_MIN}
                        max={TEXT_LINE_HEIGHT_MAX}
                        step={0.05}
                        label="Line spacing"
                        onCommit={(v) => {
                          // The text drill's snap: the 0.05 grid, cleared at Normal.
                          const snapped = Math.round(v * 20) / 20;
                          patchDeco(d.id, {
                            lineHeight: snapped === LINE_SPACING_NORMAL ? undefined : snapped,
                          });
                        }}
                      />
                      {d.lineHeight !== undefined && (
                        <button
                          type="button"
                          className="inspector-reset-btn"
                          title="Back to the font's normal line spacing"
                          onClick={() => patchDeco(d.id, { lineHeight: undefined })}
                        >
                          Normal
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <button type="button" className="btn" onClick={() => openImagePicker(d.id)}>
                    Replace image
                  </button>
                )}
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
                    min={isText ? 0.01 : 0.03}
                    max={isText ? 0.25 : 0.6}
                    step={isText ? 0.005 : 0.01}
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
                {!isText && (
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
                )}
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
            );
          })}
          <div className="inspector-drill-actions">
            <button type="button" className="btn" onClick={() => openImagePicker()}>
              Add image
            </button>
            <button type="button" className="btn" onClick={addText}>
              Add text
            </button>
          </div>
        </div>
        {mediaModal}
      </div>
    );
  }
  if (drillIn === "frame.text" && sceneFrame) {
    const claimed = sceneFrame.claimsSceneText !== false;
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">Scene text</div>
        <div className="inspector-drill-body">
          <ToggleRow
            label="Use scene text in the panel"
            description="Shows the scene's title, subtitle and bullets in the panel; off shows the scene's own headline in the frame instead."
            checked={claimed}
            onChange={(on) =>
              void patchDoc((next) => {
                next.frame = { ...(next.frame ?? {}) };
                if (on) delete next.frame.claimsSceneText;
                else next.frame.claimsSceneText = false;
              })
            }
          />
        </div>
      </div>
    );
  }
  if (drillIn === "style.shadow" && doc && device) {
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
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
                  patchDevice((d) => {
                    d.shadow = o.id as DeviceShadowMode;
                  });
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (drillIn === "videoWindow.media" && doc) {
    const vw = doc.videoWindow;
    // Detection runs on the cached poster before the patch, so the recording crop lands in the same undoable entry as the pick.
    const createFrom = (src: string, meta: MediaMeta | null) =>
      void detectWindowRecording(meta).then((recording) =>
        patchDoc(
          (next) => {
            next.videoWindow = {
              media: { src },
              radius: "macos",
              border: { enabled: false, color: "#ffffff", width: 0.0035, opacity: 0.12 },
            };
            applyVideoWindowMedia(next, src, meta, recording);
            // Staged scenery sits in front of the shadow plane and clips it: stand staging down in the same undoable entry.
            if (stagedBackdrop !== null && stagedBackdrop !== "none")
              next.backdrop = { type: "none" };
          },
          { resync: true },
        ),
      );
    const pickVideoWindowMedia = (rel: string, meta: MediaMeta | null) => {
      if (meta && meta.kind !== "video") return;
      if (vw)
        void detectWindowRecording(meta).then((recording) =>
          patchDoc((next) => applyVideoWindowMedia(next, rel, meta, recording), { resync: true }),
        );
      else createFrom(rel, meta);
    };
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">
          <span>Recording</span>
        </div>
        <div className="inspector-drill-body">
          <div className="inspector-media-host">
            <MediaBrowser
              slug={slug}
              projectPath={workspaceProjectPath(slug) ?? ""}
              kinds={["video"]}
              globalToggle
              refreshKey={mediaRefreshKey + mediaRefresh}
              selectedRel={vw?.media.src ?? null}
              onPick={pickVideoWindowMedia}
              cardMenu={mediaCardMenu({
                slug,
                primaryLabel: "Select",
                onPrimary: pickVideoWindowMedia,
                onChanged: () => setMediaRefresh((n) => n + 1),
                onError: setError,
                onEdit: (rel) => {
                  if (!vw || vw.media.src !== rel) return false;
                  onOpenEditVideo(sceneIndex, rel, "videoWindow");
                  return true;
                },
              })}
            />
          </div>
        </div>
      </div>
    );
  }
  if (drillIn === "videoWindow.edit" && doc) {
    const vw = doc.videoWindow;
    const patchVW = (mutate: (v: SceneDocVideoWindow) => void, opts?: { resync?: boolean }) =>
      void patchDoc((next) => {
        if (next.videoWindow) mutate(next.videoWindow);
      }, opts);
    // Live slider ticks write history-less; the release records one entry from the drag-start snapshot.
    const vwLive = (mutate: (v: SceneDocVideoWindow) => void) => {
      if (!vwDragBaseline.current && doc) vwDragBaseline.current = structuredClone(doc);
      void patchDoc(
        (next) => {
          if (next.videoWindow) mutate(next.videoWindow);
        },
        { history: false },
      );
    };
    const vwCommit = (mutate: (v: SceneDocVideoWindow) => void) => {
      const baseline = vwDragBaseline.current;
      vwDragBaseline.current = null;
      if (baseline)
        void commitFromBaseline(baseline, (next) => {
          if (next.videoWindow) mutate(next.videoWindow);
        });
      else patchVW(mutate);
    };
    const createFrom = (src: string, meta: MediaMeta | null) =>
      void detectWindowRecording(meta).then((recording) =>
        patchDoc(
          (next) => {
            next.videoWindow = {
              media: { src },
              radius: "macos",
              border: { enabled: false, color: "#ffffff", width: 0.0035, opacity: 0.12 },
            };
            applyVideoWindowMedia(next, src, meta, recording);
            // Staged scenery sits in front of the shadow plane and clips it: stand staging down in the same undoable entry.
            if (stagedBackdrop !== null && stagedBackdrop !== "none")
              next.backdrop = { type: "none" };
          },
          { resync: true },
        ),
      );
    const RADII: { id: "sharp" | "subtle" | "macos" | "rounded"; label: string; title: string }[] =
      [
        { id: "sharp", label: "Sharp", title: "Square corners" },
        { id: "subtle", label: "Subtle", title: "A whisper of rounding" },
        { id: "macos", label: "macOS", title: "The macOS window look" },
        { id: "rounded", label: "Rounded", title: "Boldly rounded corners" },
      ];
    const MOTIONS: { id: VideoWindowMotionPreset; label: string; title: string }[] = [
      { id: "none", label: "None", title: "No motion" },
      { id: "float", label: "Float", title: "A gentle vertical bob" },
      { id: "drift", label: "Drift", title: "A slow rotational sway" },
      { id: "tilt-reveal", label: "Tilt", title: "Swings flush from a tilted start" },
      { id: "push-in", label: "Push", title: "Eases up from 90% to full size" },
    ];
    const radiusPreset = vw && typeof vw.radius === "string" ? vw.radius : null;
    const shadow = vw?.shadow ?? {
      opacity: 0.32,
      blur: 0.14,
      offset: [0, -0.05] as [number, number],
    };
    const border = vw?.border ?? { enabled: true, color: "#ffffff", width: 0.0035, opacity: 0.12 };
    const motionPreset = vw?.motion?.preset ?? "none";
    return (
      <div className="inspector-drill">
        <DrillBack
          label="Scene"
          onClick={() => {
            setConfirmRemoveVideoWindow(false);
            closeDrill();
          }}
        />
        <div className="inspector-drill-title">
          <span>Video window</span>
        </div>
        <div className="inspector-drill-body">
          {!vw ? (
            <>
              <p className="modal-hint">
                Pick a screen recording to float in a window over a backing stage.
              </p>
              <div className="inspector-media-host">
                <MediaBrowser
                  slug={slug}
                  projectPath={workspaceProjectPath(slug) ?? ""}
                  kinds={["video"]}
                  globalToggle
                  refreshKey={mediaRefreshKey + mediaRefresh}
                  onPick={(rel, meta) => {
                    if (meta && meta.kind !== "video") return;
                    createFrom(rel, meta);
                  }}
                  cardMenu={mediaCardMenu({
                    slug,
                    primaryLabel: "Select",
                    onPrimary: (rel, meta) => {
                      if (meta && meta.kind !== "video") return;
                      createFrom(rel, meta);
                    },
                    onChanged: () => setMediaRefresh((n) => n + 1),
                    onError: setError,
                  })}
                />
              </div>
            </>
          ) : (
            <>
              <ActionRow
                icon={<SceneRowIcon id="device.media" />}
                label="Recording"
                value={middleTruncate(vw.media.src.split("/").pop() ?? "None")}
                chevron
                onClick={() => openDrill("videoWindow.media")}
              />
              <ActionRow
                icon={<SceneRowIcon id="device.editVideo" />}
                label="Edit recording"
                chevron
                onClick={() => onOpenEditVideo(sceneIndex, vw.media.src, "videoWindow")}
              />
              <ToggleRow
                label="Window recording"
                description="Crops the margins and shadow baked into a macOS window recording."
                checked={vw.recording === true || (vw.radius as unknown) === "recording"}
                onChange={(on) =>
                  patchVW((v) => {
                    v.recording = on;
                    // An early branch-only build stored the mode on the radius; normalise it away on first touch.
                    if ((v.radius as unknown) === "recording") v.radius = "macos";
                  })
                }
              />
              <DrillGroup label="Corners">
                <SegmentedRow
                  className="subtabs-compact"
                  options={RADII.map((r) => ({
                    value: r.id,
                    label: r.label,
                    icon: <VwCornerIcon id={r.id} />,
                    title: r.title,
                  }))}
                  // A custom radius leaves no preset tab active.
                  value={(radiusPreset ?? "custom") as (typeof RADII)[number]["id"]}
                  onChange={(id) =>
                    patchVW((v) => {
                      v.radius = id;
                    })
                  }
                />
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Corner radius</span>
                  <DebouncedRange
                    value={resolveVideoWindowRadius(vw.radius)}
                    min={0}
                    max={0.2}
                    step={0.005}
                    label="Corner radius"
                    onInput={(val) =>
                      vwLive((v) => {
                        v.radius = { custom: val };
                      })
                    }
                    onCommit={(val) =>
                      vwCommit((v) => {
                        v.radius = { custom: val };
                      })
                    }
                  />
                </div>
              </DrillGroup>

              <DrillGroup label="Border">
                <ToggleRow
                  label="Show border"
                  description="A thin edge line around the window."
                  checked={border.enabled}
                  onChange={(on) =>
                    patchVW((v) => {
                      v.border = { ...border, enabled: on };
                    })
                  }
                />
                {border.enabled && (
                  <>
                    <div className="popover-row">
                      <span className="popover-inline slider-row-label">Colour</span>
                      <ColourPicker
                        value={border.color}
                        label="Border colour"
                        onCommit={(hex) =>
                          patchVW((v) => {
                            v.border = { ...border, color: hex };
                          })
                        }
                      />
                    </div>
                    <div className="popover-row">
                      <span className="popover-inline slider-row-label">Width</span>
                      <DebouncedRange
                        value={border.width}
                        min={0}
                        max={0.02}
                        step={0.0005}
                        label="Border width"
                        onInput={(val) =>
                          vwLive((v) => {
                            v.border = { ...border, width: val };
                          })
                        }
                        onCommit={(val) =>
                          vwCommit((v) => {
                            v.border = { ...border, width: val };
                          })
                        }
                      />
                    </div>
                    <div className="popover-row">
                      <span className="popover-inline slider-row-label">Strength</span>
                      <DebouncedRange
                        value={border.opacity}
                        min={0}
                        max={1}
                        step={0.02}
                        label="Border strength"
                        onInput={(val) =>
                          vwLive((v) => {
                            v.border = { ...border, opacity: val };
                          })
                        }
                        onCommit={(val) =>
                          vwCommit((v) => {
                            v.border = { ...border, opacity: val };
                          })
                        }
                      />
                    </div>
                  </>
                )}
              </DrillGroup>

              <DrillGroup label="Shadow">
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Strength</span>
                  <DebouncedRange
                    value={shadow.opacity}
                    min={0}
                    max={0.8}
                    step={0.02}
                    label="Shadow strength"
                    onInput={(val) =>
                      vwLive((v) => {
                        v.shadow = { ...shadow, opacity: val };
                      })
                    }
                    onCommit={(val) =>
                      vwCommit((v) => {
                        v.shadow = { ...shadow, opacity: val };
                      })
                    }
                  />
                </div>
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Softness</span>
                  <DebouncedRange
                    value={shadow.blur}
                    min={0}
                    max={0.4}
                    step={0.01}
                    label="Shadow softness"
                    onInput={(val) =>
                      vwLive((v) => {
                        v.shadow = { ...shadow, blur: val };
                      })
                    }
                    onCommit={(val) =>
                      vwCommit((v) => {
                        v.shadow = { ...shadow, blur: val };
                      })
                    }
                  />
                </div>
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Drop</span>
                  <DebouncedRange
                    value={shadow.offset[1]}
                    min={-0.2}
                    max={0.2}
                    step={0.01}
                    label="Shadow drop"
                    onInput={(val) =>
                      vwLive((v) => {
                        v.shadow = { ...shadow, offset: [shadow.offset[0], val] };
                      })
                    }
                    onCommit={(val) =>
                      vwCommit((v) => {
                        v.shadow = { ...shadow, offset: [shadow.offset[0], val] };
                      })
                    }
                  />
                </div>
              </DrillGroup>

              <DrillGroup label="Placement">
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Window size</span>
                  <DebouncedRange
                    value={vw.scale ?? 0.72}
                    min={0.3}
                    max={1}
                    step={0.01}
                    label="Window size"
                    onInput={(val) =>
                      vwLive((v) => {
                        v.scale = val;
                      })
                    }
                    onCommit={(val) =>
                      vwCommit((v) => {
                        v.scale = val;
                      })
                    }
                  />
                </div>
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Left/right (X)</span>
                  <DebouncedRange
                    value={vw.offset?.[0] ?? 0}
                    min={-0.5}
                    max={0.5}
                    step={0.01}
                    label="Left/right (X)"
                    onInput={(val) =>
                      vwLive((v) => {
                        v.offset = [val, v.offset?.[1] ?? 0];
                      })
                    }
                    onCommit={(val) =>
                      vwCommit((v) => {
                        v.offset = [val, v.offset?.[1] ?? 0];
                      })
                    }
                  />
                </div>
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Up/down (Y)</span>
                  <DebouncedRange
                    value={vw.offset?.[1] ?? 0}
                    min={-0.5}
                    max={0.5}
                    step={0.01}
                    label="Up/down (Y)"
                    onInput={(val) =>
                      vwLive((v) => {
                        v.offset = [v.offset?.[0] ?? 0, val];
                      })
                    }
                    onCommit={(val) =>
                      vwCommit((v) => {
                        v.offset = [v.offset?.[0] ?? 0, val];
                      })
                    }
                  />
                </div>
              </DrillGroup>

              <DrillGroup label="Motion">
                <SegmentedRow
                  className="subtabs-compact"
                  options={MOTIONS.map((m) => ({
                    value: m.id,
                    label: m.label,
                    icon: <VwMotionIcon id={m.id} />,
                    title: m.title,
                  }))}
                  value={motionPreset}
                  onChange={(id) =>
                    patchVW((v) => {
                      v.motion = { preset: id };
                    })
                  }
                />
              </DrillGroup>

              <div className="inspector-section-divider" />
              <ActionRow
                icon={<SceneRowIcon id="device.remove" />}
                label={confirmRemoveVideoWindow ? "Really remove?" : "Remove video window"}
                chevron={false}
                danger
                onClick={() => {
                  if (!confirmRemoveVideoWindow) {
                    setConfirmRemoveVideoWindow(true);
                    return;
                  }
                  setConfirmRemoveVideoWindow(false);
                  void patchDoc((next) => {
                    next.videoWindow = undefined;
                  });
                  closeDrill();
                }}
              />
            </>
          )}
        </div>
      </div>
    );
  }
  if (drillIn === "style.background.media" && doc) {
    const bgActive = bgTarget === "compareB" ? doc.compare?.b?.background : doc.background;
    const kind: "image" | "video" =
      bgTabOverride === "image" || bgTabOverride === "video"
        ? bgTabOverride
        : bgActive?.type === "video"
          ? "video"
          : "image";
    const selectedSrc = bgActive?.type === kind ? bgActive.src : null;
    const selectBg = kind === "video" ? selectVideoBackground : selectImageBackground;
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">
          {kind === "video" ? "Background video" : "Background image"}
        </div>
        <div className="inspector-drill-body">
          <div className="inspector-media-host">
            <MediaBrowser
              slug={slug}
              projectPath={workspaceProjectPath(slug) ?? ""}
              kinds={[kind]}
              globalToggle
              refreshKey={mediaRefreshKey + mediaRefresh}
              selectedRel={selectedSrc}
              onPick={selectBg}
              cardMenu={mediaCardMenu({
                slug,
                primaryLabel: "Select",
                onPrimary: selectBg,
                onChanged: () => setMediaRefresh((n) => n + 1),
                onError: setError,
                onEdit:
                  kind === "video"
                    ? (rel) => {
                        if (bgActive?.type !== "video" || bgActive.src !== rel) return false;
                        onOpenEditVideo(sceneIndex, rel, "background");
                        return true;
                      }
                    : undefined,
              })}
            />
          </div>
        </div>
      </div>
    );
  }
  if (drillIn === "style.background" && doc) {
    const bgActive = bgTarget === "compareB" ? doc.compare?.b?.background : doc.background;
    const bgOpts = backgroundOptions(sceneTheme);
    const colourOpt = bgOpts.find((o) => o.value?.type === "color")?.value;
    const docTab = bgActive === undefined ? "default" : bgActive.type;
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
      void patchBgDoc((next) => {
        next.background = value;
        // Theme resets both layers; a fresh colour writes through to the stage (one visual, one edit).
        if (value === undefined) next.backdrop = undefined;
        else if (value.type === "color" && stagingOn) next.backdrop = floorFor(value.color);
      });
    };
    const shaderSpec = bgActive?.type === "shader" ? bgActive : null;
    const shaderDef = shaderSpec ? SHADER_BACKGROUNDS[shaderSpec.shader] : undefined;
    const scene3dSpec = bgActive?.type === "scene3d" ? bgActive : null;
    const scene3dDef = scene3dSpec ? SCENE3D_BACKGROUNDS[scene3dSpec.look] : undefined;
    const patchScene3d = (mutate: (spec: Extract<ThemeBackground, { type: "scene3d" }>) => void) =>
      void patchBgDoc((next) => {
        if (next.background?.type !== "scene3d") return;
        const spec = structuredClone(next.background);
        mutate(spec);
        next.background = spec;
      });
    const applyScene3dPreset = (preset: Scene3dBackgroundPreset) =>
      patchScene3d((spec) => {
        spec.colors = [...preset.colors];
        spec.themeColors = undefined;
        spec.speed = preset.speed ?? 1;
        spec.params = preset.params ? { ...preset.params } : undefined;
        spec.backing = { type: "color", color: preset.backing };
        spec.preset = preset.id;
      });
    const patchShader = (mutate: (spec: Extract<ThemeBackground, { type: "shader" }>) => void) =>
      void patchBgDoc((next) => {
        if (next.background?.type !== "shader") return;
        const spec = structuredClone(next.background);
        mutate(spec);
        next.background = spec;
      });
    // Shared by the preset tiles and the header Reset: the whole look lands explicitly.
    const applyShaderPreset = (preset: ShaderBackgroundPreset) =>
      patchShader((spec) => {
        spec.colors = [...preset.colors];
        spec.themeColors = undefined;
        spec.speed = preset.speed ?? 1;
        spec.scale = preset.scale;
        spec.params = preset.params ? { ...preset.params } : undefined;
        spec.preset = preset.id;
      });
    // The Theme tile: colours resolve live from the theme (motion stamps from the mode's anchor preset).
    const applyThemePreset = () =>
      patchShader((spec) => {
        const anchor = sceneTheme ? themePresetAnchor(spec.shader, sceneTheme) : undefined;
        spec.colors = undefined;
        spec.themeColors = true;
        spec.speed = anchor?.speed ?? 1;
        spec.scale = anchor?.scale;
        spec.params = anchor?.params ? { ...anchor.params } : undefined;
        spec.preset = undefined;
      });
    const selectedShaderPreset =
      shaderSpec?.preset && shaderSpec
        ? SHADER_BACKGROUND_PRESETS[shaderSpec.shader]?.find((p) => p.id === shaderSpec.preset)
        : undefined;
    const lightTheme = sceneTheme?.mode === "light";
    const stripeSwatch = (stripes: string[]) =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">${stripes
          .map(
            (c, i) =>
              `<rect x="${((320 / stripes.length) * i).toFixed(2)}" y="0" width="${(
                320 / stripes.length + 1
              ).toFixed(2)}" height="180" fill="${c}"/>`,
          )
          .join("")}</svg>`,
      )}`;
    // Derived Theme-preset colours for the current pick: the tile swatch always, the pickers only while the flag is on.
    const themeSwatchColors =
      shaderSpec && sceneTheme ? deriveThemeShaderColors(shaderSpec.shader, sceneTheme) : null;
    const themeDerivedColors = shaderSpec?.themeColors ? themeSwatchColors : null;
    const themeSwatchImage = themeSwatchColors ? stripeSwatch(themeSwatchColors) : null;
    // The scene3d Theme preset derives geometry colours and the backing SEPARATELY (the renderer derives from anchor.colors alone; deriving them together would shift the luminance ranks).
    const scene3dAnchor =
      scene3dSpec && sceneTheme ? scene3dThemeAnchor(scene3dSpec.look, sceneTheme) : undefined;
    const scene3dColorsDerived =
      scene3dAnchor && sceneTheme
        ? deriveThemeColorsFromAnchor(scene3dAnchor.colors, sceneTheme)
        : null;
    const scene3dBackingDerived =
      scene3dAnchor && sceneTheme
        ? deriveThemeColorsFromAnchor([scene3dAnchor.backing], sceneTheme)?.[0]
        : undefined;
    const scene3dThemeSwatch =
      scene3dBackingDerived && scene3dColorsDerived
        ? stripeSwatch([scene3dBackingDerived, ...scene3dColorsDerived])
        : null;
    const scene3dDerivedColors = scene3dSpec?.themeColors ? scene3dColorsDerived : null;
    const applyScene3dThemePreset = () =>
      patchScene3d((spec) => {
        spec.colors = undefined;
        spec.themeColors = true;
        spec.speed = scene3dAnchor?.speed ?? 1;
        spec.params = scene3dAnchor?.params ? { ...scene3dAnchor.params } : undefined;
        if (scene3dBackingDerived) spec.backing = { type: "color", color: scene3dBackingDerived };
        spec.preset = undefined;
      });
    const scene3dPresetList = scene3dSpec
      ? (SCENE3D_BACKGROUND_PRESETS[scene3dSpec.look] ?? [])
      : [];
    const orderedScene3dPresets = [
      ...scene3dPresetList.filter((p) => (p.mode === "light") === lightTheme),
      ...scene3dPresetList.filter((p) => (p.mode === "light") !== lightTheme),
    ];
    const shaderPresets = shaderSpec ? (SHADER_BACKGROUND_PRESETS[shaderSpec.shader] ?? []) : [];
    // Presets matching the theme's mode lead the grid; the other mode follows.
    const orderedShaderPresets = [
      ...shaderPresets.filter((p) => (p.mode === "light") === lightTheme),
      ...shaderPresets.filter((p) => (p.mode === "light") !== lightTheme),
    ];
    const types: { id: Exclude<typeof bgTab, "default">; label: string }[] = [
      { id: "none", label: "None" },
      { id: "color", label: "Colour" },
      { id: "gradient", label: "Gradient" },
      { id: "shader", label: "Animated" },
      { id: "scene3d", label: "3D" },
      { id: "image", label: "Image" },
      { id: "video", label: "Video" },
    ];
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
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
              Following the theme's background. Pick a fill type to override it for this scene.
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
          {bgTab === "color" && bgActive?.type === "color" && (
            <div className="popover-row">
              <span className="popover-inline slider-row-label">Colour</span>
              <ColourPicker
                value={bgActive.color}
                label="Background colour"
                onCommit={(hex) => {
                  void patchBgDoc((next) => {
                    if (next.background?.type === "color") {
                      next.background = { ...next.background, color: hex };
                    }
                    if (stagingOn) next.backdrop = floorFor(hex);
                  });
                }}
              />
            </div>
          )}
          {bgTab === "gradient" && (
            <GradientPickerModal
              embedded
              current={bgActive}
              theme={sceneTheme}
              onCancel={() => setBgTabOverride(null)}
              onApply={(value) => {
                setBgTabOverride(null);
                void patchBgDoc((next) => {
                  const parallax =
                    next.background &&
                    next.background.type !== "none" &&
                    next.background.type !== "scene3d"
                      ? next.background.parallax
                      : undefined;
                  next.background = parallax !== undefined ? { ...value, parallax } : value;
                  // A staged backdrop would hide the gradient: clear it in the same undoable entry.
                  if (stagingOn) next.backdrop = { type: "none" };
                });
              }}
            />
          )}
          {bgTab === "shader" && (
            <>
              <p className="modal-hint">
                Animated fills run on the project clock, so the motion is continuous across scene
                cuts when neighbouring scenes share the same pick.
              </p>
              <div className="option-grid">
                {SHADER_BACKGROUND_IDS.map((id) => {
                  const def = SHADER_BACKGROUNDS[id];
                  // Light themes preview and apply the shader's p1 preset so the card shows what the click writes.
                  const lightP1 = lightTheme
                    ? SHADER_BACKGROUND_PRESETS[id]?.find((p) => p.id === "p1")
                    : undefined;
                  const preview =
                    (lightP1 ? optionPreviewClip(`bg-${id}-light`) : null) ??
                    optionPreviewClip(`bg-${id}`);
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
                        void patchBgDoc((next) => {
                          next.background = lightP1
                            ? {
                                type: "shader",
                                shader: id,
                                colors: [...lightP1.colors],
                                speed: lightP1.speed ?? 1,
                                ...(lightP1.scale !== undefined ? { scale: lightP1.scale } : {}),
                                ...(lightP1.params ? { params: { ...lightP1.params } } : {}),
                                preset: "p1",
                              }
                            : {
                                type: "shader",
                                shader: id,
                                colors: def.colorSlots.map((slot) => slot.fallback),
                                speed: 1,
                              };
                          // A staged backdrop would hide the animation: clear it in the same undoable entry.
                          if (stagingOn) next.backdrop = { type: "none" };
                        });
                      }}
                      onHoverChange={(h) => setBgHover((cur) => (h ? id : cur === id ? null : cur))}
                    />
                  );
                })}
              </div>
              {shaderSpec && shaderDef && (
                <>
                  {orderedShaderPresets.length > 0 && (
                    <DrillGroup label="Presets">
                      <div className="option-grid three-up">
                        <OptionCard
                          key="theme"
                          label="Theme"
                          image={themeSwatchImage}
                          selected={!!shaderSpec.themeColors}
                          onSelect={applyThemePreset}
                        />
                        {orderedShaderPresets.map((preset) => (
                          <OptionCard
                            key={preset.id}
                            label={preset.name}
                            image={optionPreviewStill(`bgp-${shaderSpec.shader}-${preset.id}`)}
                            selected={shaderSpec.preset === preset.id}
                            onSelect={() => applyShaderPreset(preset)}
                          />
                        ))}
                      </div>
                    </DrillGroup>
                  )}
                  <DrillGroup label="Colours and motion">
                    {shaderDef.colorSlots.map((slot, i) => (
                      <div key={slot.label} className="popover-row">
                        <span className="popover-inline slider-row-label">{slot.label}</span>
                        <ColourPicker
                          value={themeDerivedColors?.[i] ?? shaderSpec.colors?.[i] ?? slot.fallback}
                          label={slot.label}
                          defaultValue={slot.fallback}
                          onReset={() =>
                            patchShader((spec) => {
                              // A manual edit leaves the live Theme preset: seed from its derived colours, then go explicit.
                              const colors = shaderDef.colorSlots.map(
                                (s, j) => (themeDerivedColors ?? spec.colors)?.[j] ?? s.fallback,
                              );
                              colors[i] = slot.fallback;
                              spec.colors = colors;
                              spec.themeColors = undefined;
                            })
                          }
                          onCommit={(hex) =>
                            patchShader((spec) => {
                              const colors = shaderDef.colorSlots.map(
                                (s, j) => (themeDerivedColors ?? spec.colors)?.[j] ?? s.fallback,
                              );
                              colors[i] = hex;
                              spec.colors = colors;
                              spec.themeColors = undefined;
                            })
                          }
                        />
                      </div>
                    ))}
                    <div className="popover-row">
                      <span className="popover-inline slider-row-label">Speed</span>
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
                      <span className="popover-inline slider-row-label">Zoom</span>
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
                        <span className="popover-inline slider-row-label">{p.label}</span>
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
                  </DrillGroup>
                </>
              )}
            </>
          )}
          {bgTab === "scene3d" && (
            <>
              <p className="modal-hint">
                Real geometry behind the scene: it parallaxes with camera moves and keeps a clear
                area around your content. Runs on the project clock, continuous across cuts.
              </p>
              <div className="option-grid">
                {SCENE3D_BACKGROUND_IDS.map((id) => {
                  const def = SCENE3D_BACKGROUNDS[id];
                  // The card previews and applies the mode's anchor preset wholesale, so the card shows what the click writes.
                  const cardAnchor = SCENE3D_BACKGROUND_PRESETS[id]?.find(
                    (p) => p.id === (lightTheme ? "p1" : "p6"),
                  );
                  const preview =
                    (lightTheme ? optionPreviewClip(`bg-${id}-light`) : null) ??
                    optionPreviewClip(`bg-${id}`);
                  return (
                    <OptionCard
                      key={id}
                      label={def.name}
                      image={preview?.poster ?? optionPreviewStill(`bg-${id}`)}
                      clip={preview?.clip}
                      playing={bgHover === id || scene3dSpec?.look === id}
                      selected={scene3dSpec?.look === id}
                      onSelect={() => {
                        setBgTabOverride(null);
                        void patchBgDoc((next) => {
                          next.background = cardAnchor
                            ? {
                                type: "scene3d",
                                look: id,
                                colors: [...cardAnchor.colors],
                                speed: cardAnchor.speed ?? 1,
                                ...(cardAnchor.params ? { params: { ...cardAnchor.params } } : {}),
                                backing: { type: "color", color: cardAnchor.backing },
                                preset: cardAnchor.id,
                              }
                            : { type: "scene3d", look: id };
                          // A staged backdrop would hide the geometry: clear it in the same undoable entry.
                          if (stagingOn) next.backdrop = { type: "none" };
                        });
                      }}
                      onHoverChange={(h) => setBgHover((cur) => (h ? id : cur === id ? null : cur))}
                    />
                  );
                })}
              </div>
              {scene3dSpec && scene3dDef && (
                <>
                  {orderedScene3dPresets.length > 0 && (
                    <DrillGroup label="Presets">
                      <div className="option-grid three-up">
                        <OptionCard
                          key="theme"
                          label="Theme"
                          image={scene3dThemeSwatch}
                          selected={!!scene3dSpec.themeColors}
                          onSelect={applyScene3dThemePreset}
                        />
                        {orderedScene3dPresets.map((preset) => (
                          <OptionCard
                            key={preset.id}
                            label={preset.name}
                            image={optionPreviewStill(`bgp-${scene3dSpec.look}-${preset.id}`)}
                            selected={scene3dSpec.preset === preset.id}
                            onSelect={() => applyScene3dPreset(preset)}
                          />
                        ))}
                      </div>
                    </DrillGroup>
                  )}
                  <DrillGroup label="Backing">
                    <p className="modal-hint">The camera-locked fill behind the geometry.</p>
                    <div className="bg-type-grid">
                      {(
                        [
                          { id: "color", label: "Colour" },
                          { id: "gradient", label: "Gradient" },
                          { id: "shader", label: "Animated" },
                        ] as const
                      ).map((t) => {
                        const backingTab =
                          backingTabOverride ??
                          (scene3dSpec.backing?.type === "gradient" ||
                          scene3dSpec.backing?.type === "shader"
                            ? scene3dSpec.backing.type
                            : "color");
                        return (
                          <button
                            key={t.id}
                            type="button"
                            className={`bg-type-tile${backingTab === t.id ? " selected" : ""}`}
                            onClick={() => {
                              if (t.id === "color") {
                                setBackingTabOverride(null);
                                patchScene3d((spec) => {
                                  if (spec.backing?.type !== "color")
                                    spec.backing = {
                                      type: "color",
                                      color: lightTheme ? "#e8ecf2" : "#0d1218",
                                    };
                                });
                              } else setBackingTabOverride(t.id);
                            }}
                          >
                            <BgTypeIcon id={t.id} />
                            {t.label}
                          </button>
                        );
                      })}
                    </div>
                    {(backingTabOverride ?? scene3dSpec.backing?.type ?? "color") === "color" && (
                      <div className="popover-row">
                        <span className="popover-inline slider-row-label">Colour</span>
                        <ColourPicker
                          value={
                            scene3dSpec.backing?.type === "color"
                              ? scene3dSpec.backing.color
                              : lightTheme
                                ? "#e8ecf2"
                                : "#0d1218"
                          }
                          label="Backing colour"
                          onCommit={(hex) =>
                            patchScene3d((spec) => {
                              spec.backing = { type: "color", color: hex };
                            })
                          }
                        />
                      </div>
                    )}
                    {(backingTabOverride ??
                      (scene3dSpec.backing?.type === "gradient" ? "gradient" : null)) ===
                      "gradient" && (
                      <GradientPickerModal
                        embedded
                        current={
                          scene3dSpec.backing?.type === "gradient" ? scene3dSpec.backing : undefined
                        }
                        theme={sceneTheme}
                        onCancel={() => setBackingTabOverride(null)}
                        onApply={(value) => {
                          setBackingTabOverride(null);
                          patchScene3d((spec) => {
                            spec.backing = value;
                          });
                        }}
                      />
                    )}
                    {(backingTabOverride ??
                      (scene3dSpec.backing?.type === "shader" ? "shader" : null)) === "shader" && (
                      <div className="option-grid">
                        {SHADER_BACKGROUND_IDS.map((id) => {
                          const def = SHADER_BACKGROUNDS[id];
                          const lightP1 = lightTheme
                            ? SHADER_BACKGROUND_PRESETS[id]?.find((p) => p.id === "p1")
                            : undefined;
                          const preview =
                            (lightP1 ? optionPreviewClip(`bg-${id}-light`) : null) ??
                            optionPreviewClip(`bg-${id}`);
                          const selected =
                            scene3dSpec.backing?.type === "shader" &&
                            scene3dSpec.backing.shader === id;
                          return (
                            <OptionCard
                              key={id}
                              label={def.name}
                              image={preview?.poster ?? optionPreviewStill(`bg-${id}`)}
                              clip={preview?.clip}
                              playing={selected}
                              selected={selected}
                              onSelect={() => {
                                setBackingTabOverride(null);
                                patchScene3d((spec) => {
                                  spec.backing = lightP1
                                    ? {
                                        type: "shader",
                                        shader: id,
                                        colors: [...lightP1.colors],
                                        speed: lightP1.speed ?? 1,
                                        ...(lightP1.scale !== undefined
                                          ? { scale: lightP1.scale }
                                          : {}),
                                        ...(lightP1.params
                                          ? { params: { ...lightP1.params } }
                                          : {}),
                                        preset: "p1",
                                      }
                                    : {
                                        type: "shader",
                                        shader: id,
                                        colors: def.colorSlots.map((slot) => slot.fallback),
                                        speed: 1,
                                      };
                                });
                              }}
                            />
                          );
                        })}
                      </div>
                    )}
                  </DrillGroup>
                  <DrillGroup label="Colours and motion">
                    {scene3dDef.colorSlots.map((slot, i) => (
                      <div key={slot.label} className="popover-row">
                        <span className="popover-inline slider-row-label">{slot.label}</span>
                        <ColourPicker
                          value={
                            scene3dDerivedColors?.[i] ?? scene3dSpec.colors?.[i] ?? slot.fallback
                          }
                          label={slot.label}
                          defaultValue={slot.fallback}
                          onReset={() =>
                            patchScene3d((spec) => {
                              const colors = scene3dDef.colorSlots.map(
                                (s, j) => (scene3dDerivedColors ?? spec.colors)?.[j] ?? s.fallback,
                              );
                              colors[i] = slot.fallback;
                              spec.colors = colors;
                              spec.themeColors = undefined;
                            })
                          }
                          onCommit={(hex) =>
                            patchScene3d((spec) => {
                              const colors = scene3dDef.colorSlots.map(
                                (s, j) => (scene3dDerivedColors ?? spec.colors)?.[j] ?? s.fallback,
                              );
                              colors[i] = hex;
                              spec.colors = colors;
                              spec.themeColors = undefined;
                            })
                          }
                        />
                      </div>
                    ))}
                    <div className="popover-row">
                      <span className="popover-inline slider-row-label">Speed</span>
                      <DebouncedRange
                        value={scene3dSpec.speed ?? 1}
                        min={0}
                        max={3}
                        step={0.05}
                        label="Animation speed"
                        onCommit={(v) =>
                          patchScene3d((spec) => {
                            spec.speed = v;
                          })
                        }
                      />
                    </div>
                    {Object.entries(scene3dDef.params).map(([key, p]) => (
                      <div key={key} className="popover-row">
                        <span className="popover-inline slider-row-label">{p.label}</span>
                        <DebouncedRange
                          value={scene3dSpec.params?.[key] ?? p.default}
                          min={p.min}
                          max={p.max}
                          step={p.step}
                          label={p.label}
                          onCommit={(v) =>
                            patchScene3d((spec) => {
                              spec.params = { ...(spec.params ?? {}), [key]: v };
                            })
                          }
                        />
                      </div>
                    ))}
                  </DrillGroup>
                </>
              )}
            </>
          )}
          {bgTab === "image" && (
            <>
              <span className="modal-hint">
                Fills the frame behind everything and stays locked to the camera; pick an image with
                a safe centre (it cover-crops per aspect).
              </span>
              <ActionRow
                icon={<SceneRowIcon id="style.background" />}
                label={bgActive?.type === "image" ? "Change image" : "Choose an image"}
                value={
                  bgActive?.type === "image"
                    ? middleTruncate(bgActive.src.split("/").pop() ?? "")
                    : undefined
                }
                onClick={() => openDrill("style.background.media")}
              />
            </>
          )}
          {bgTab === "video" && (
            <>
              <span className="modal-hint">Video that fills the frame behind everything.</span>
              <ActionRow
                icon={<SceneRowIcon id="style.background" />}
                label={bgActive?.type === "video" ? "Change video" : "Choose a video"}
                value={
                  bgActive?.type === "video"
                    ? middleTruncate(bgActive.src.split("/").pop() ?? "")
                    : undefined
                }
                onClick={() => openDrill("style.background.media")}
              />
              {bgActive?.type === "video" && (
                <ToggleRow
                  label="Loop"
                  description="Plays again from the start when it ends; off holds the last frame."
                  checked={bgActive.loop !== false}
                  onChange={(on) =>
                    void patchBgDoc((next) => {
                      if (next.background?.type === "video") {
                        const { loop: _drop, ...rest } = next.background;
                        next.background = on ? rest : { ...rest, loop: false };
                      }
                    })
                  }
                />
              )}
              {bgActive?.type === "video" && (
                <ToggleRow
                  label="Fit inside frame"
                  description="Shows the whole video with letterbox bars; off crops it to fill the frame."
                  checked={bgActive.fit === "fit"}
                  onChange={(on) =>
                    void patchBgDoc((next) => {
                      if (next.background?.type === "video") {
                        const { fit: _drop, ...rest } = next.background;
                        next.background = on ? { ...rest, fit: "fit" } : rest;
                      }
                    })
                  }
                />
              )}
            </>
          )}
          <ToggleRow
            label="Drift"
            description="Camera motion shifts the fill slightly for depth; pan the camera to see it."
            disabled={!bgActive || bgActive.type === "none" || bgActive.type === "scene3d"}
            checked={
              !!bgActive &&
              bgActive.type !== "none" &&
              bgActive.type !== "scene3d" &&
              (bgActive.parallax ?? 0) > 0
            }
            onChange={(on) =>
              void patchBgDoc((next) => {
                if (next.background && next.background.type !== "none") {
                  next.background = toggleDrift(next.background, on);
                }
              })
            }
          />
          {stagedBackdrop !== null && (
            <>
              <ToggleRow
                label="Staging"
                description="A floor and backdrop that catch light and real shadows; colour and gradient picks write through to it."
                checked={stagingOn}
                onChange={(on) =>
                  void patchBgDoc((next) => {
                    if (!on) {
                      next.backdrop = { type: "none" };
                      return;
                    }
                    // Back on: the theme's own staging when it has one, else a floor in the current colour.
                    if (sceneTheme?.backdrop && sceneTheme.backdrop.type !== "none") {
                      next.backdrop = undefined;
                    } else {
                      next.backdrop = floorFor(
                        bgActive?.type === "color"
                          ? bgActive.color
                          : (sceneTheme?.colors.background ?? "#ffffff"),
                      );
                    }
                  })
                }
              />
              {stagingOn && (
                <div className="wizard-presets">
                  {(() => {
                    const themeGradients = Object.keys(sceneTheme?.gradients ?? {});
                    const themeGradient = themeGradients.includes("backdrop")
                      ? "backdrop"
                      : themeGradients[0];
                    const gradientSource = bgActive?.type === "gradient" ? bgActive : undefined;
                    const currentColour =
                      bgActive?.type === "color"
                        ? bgActive.color
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
                          void patchBgDoc((next) => {
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
            <DrillGroup
              label="Apply everywhere"
              hint={`Copies this background${stagedBackdrop !== null ? " and staging" : ""} onto every other scene, matching each slide.`}
            >
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
            </DrillGroup>
          )}
        </div>
      </div>
    );
  }
  if (drillIn === "motion.transition") {
    // A comparison on either side of this boundary blends its Before side only during the window (the v1 interop rule); said here where the choice is made, not as a console warning.
    const boundaryHasCompare =
      project.sceneDocs[boundaryIndex]?.compare !== undefined ||
      project.sceneDocs[boundaryIndex + 1]?.compare !== undefined;
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">{`Transition out of scene ${boundaryIndex + 1}`}</div>
        {boundaryHasCompare && (
          <p className="inspector-stub-note">
            A comparison sits on this boundary: during the transition window it blends its Before
            side only. Use a hard cut (None) to keep the full comparison to the edge.
          </p>
        )}
        <TransitionModal
          embedded
          project={project}
          boundaryIndex={boundaryIndex}
          thumbs={thumbs ?? {}}
          onCancel={() => closeDrill()}
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
            closeDrill();
            onTimingChanged();
          }}
          onApplyAll={
            project.slots.length > 2
              ? async (spec) => {
                  const manifestBefore = await readProjectManifestSnapshot(slug);
                  for (let i = 0; i < project.slots.length - 1; i++) {
                    await updateSceneTransition(slug, i, spec);
                  }
                  pushHistory({
                    label: "transition (all)",
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
                  closeDrill();
                  onTimingChanged();
                }
              : undefined
          }
        />
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
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
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
            onPick={(ref, opts) => {
              // Pin + preload before the sidecar write so the face renders the moment the doc patch lands.
              void (async () => {
                await ensureFontRefsPinned([ref]);
                await preloadAppFonts([ref]);
                commitFont(formatFontString(ref));
                // A recent chip is a committed choice, so step straight back to Edit text.
                if (opts?.fromRecent) closeDrill();
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
  if (drillIn?.startsWith("deco.font:") && sceneFrame) {
    const decoId = drillIn.slice("deco.font:".length);
    const decos = sceneFrame.decorations ?? [];
    const deco = decos.find((x) => x.id === decoId);
    const themeFace = (sceneTheme ?? project.theme).typography[deco?.face ?? "headline"];
    const currentRef = deco?.font ? parseFontString(deco.font) : themeFace;
    const commitFont = (value: string | undefined) =>
      void patchDoc(
        (next) => {
          next.frame = {
            ...(next.frame ?? {}),
            decorations: decos.map((x) => (x.id === decoId ? { ...x, font: value } : x)),
          };
        },
        { history: "decoration font" },
      );
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">Decoration font</div>
        <div className="inspector-drill-body">
          {deco?.font !== undefined && (
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
            onPick={(ref, opts) => {
              // Pin + preload before the sidecar write so the face renders the moment the doc patch lands.
              void (async () => {
                await ensureFontRefsPinned([ref]);
                await preloadAppFonts([ref]);
                commitFont(formatFontString(ref));
                if (opts?.fromRecent) closeDrill();
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
  if (drillIn === "text" && doc) {
    const textKeys = Object.keys(doc.text ?? {});
    const consumed = textKeysConsumedBy(sceneIndex);
    const useHeadline =
      consumed.includes("headline") && !consumed.includes("title") && !textKeys.includes("title");
    const baseKeys = useHeadline ? ["headline"] : ["title", "subtitle"];
    if (sceneFrame) baseKeys.push("bullets");
    const fieldKeys = [...baseKeys, ...textKeys.filter((k) => !baseKeys.includes(k)).sort()];
    const fieldLabels: Record<string, string> = {
      title: "Title",
      subtitle: "Subtitle",
      headline: textKeys.includes("title") ? "Headline" : "Title",
      bullets: "Bullets",
    };
    // One smart alignment: the overlay's own align on overlay scenes, the scene-text align otherwise.
    const align = sceneFrame
      ? (sceneFrame.textAlign ?? "left")
      : (doc.textLayout?.align ?? "center");
    const setAlign = (a: SceneTextAlign) =>
      void patchDoc(
        (next) => {
          if (sceneFrame) {
            next.frame = { ...(next.frame ?? {}) };
            if (a === "left") delete next.frame.textAlign;
            else next.frame.textAlign = a;
          } else {
            next.textLayout = { ...(next.textLayout ?? {}), align: a };
          }
        },
        { history: "text alignment" },
      );
    // Header icon: the overlay's icon on overlay scenes, else the plain scene's headerIcon (drawn above the fallback headline).
    const headerIcon = sceneFrame ? (sceneFrame.icon ?? "") : (doc.headerIcon ?? "");
    const writeHeaderIcon = (next: SceneDoc, v: string | undefined) => {
      if (sceneFrame) {
        next.frame = { ...(next.frame ?? {}) };
        if (v) next.frame.icon = v;
        else delete next.frame.icon;
      } else if (v) next.headerIcon = v;
      else delete next.headerIcon;
    };
    // Emoji tiles commit instantly; the free-text field live-previews on the text-field debounce and finalises to one undo on blur.
    const setHeaderIcon = (v: string | undefined) =>
      void patchDoc((next) => writeHeaderIcon(next, v));
    const liveHeaderIcon = (value: string) => {
      setIconDraft(value);
      if (!iconEditBaseline.current) iconEditBaseline.current = structuredClone(doc);
      if (iconEditTimer.current !== null) window.clearTimeout(iconEditTimer.current);
      const id = window.setTimeout(() => {
        if (iconEditTimer.current === id) iconEditTimer.current = null;
        void patchDoc((next) => writeHeaderIcon(next, value.trim() || undefined), {
          history: false,
        });
      }, 200);
      iconEditTimer.current = id;
    };
    const flushHeaderIcon = () => {
      if (iconEditTimer.current !== null) {
        window.clearTimeout(iconEditTimer.current);
        iconEditTimer.current = null;
      }
      const baseline = iconEditBaseline.current;
      const value = (iconDraft ?? headerIcon).trim() || undefined;
      iconEditBaseline.current = null;
      setIconDraft(null);
      if (!baseline) return;
      void commitFromBaseline(baseline, (next) => writeHeaderIcon(next, value));
    };
    const textTheme = sceneTheme ?? project.theme;
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
    const writeStyle = (k: string, value: string | number | undefined) => (next: SceneDoc) => {
      const style = { ...(next.textStyle ?? {}) };
      if (value === undefined) delete style[k];
      else style[k] = value;
      next.textStyle = Object.keys(style).length > 0 ? style : undefined;
    };
    const patchStyle = (history: string, k: string, value: string | number | undefined) =>
      void patchDoc(writeStyle(k, value), { history });
    // Slider drags write live (history-less) and record ONE entry on release, the lighting/position drill pattern.
    const liveStyle = (k: string, value: string | number | undefined) => {
      if (!lineDragBaseline.current) lineDragBaseline.current = structuredClone(doc);
      void patchDoc(writeStyle(k, value), { history: false });
    };
    const commitStyle = (history: string, k: string, value: string | number | undefined) => {
      const baseline = lineDragBaseline.current;
      lineDragBaseline.current = null;
      if (baseline) void commitFromBaseline(baseline, writeStyle(k, value));
      else patchStyle(history, k, value);
    };
    // Snap to the 0.05 grid so the slider's own float drift can't write 1.2000000000000002 (which would also miss the clear-at-Normal test).
    const lineSpacing = (n: number): number | undefined => {
      const v = Math.round(n * 20) / 20;
      return v === LINE_SPACING_NORMAL ? undefined : v;
    };
    const clearAllText = () => {
      // Drop pending live edits first so a focused field can't write itself back.
      if (textEditTimer.current !== null) {
        window.clearTimeout(textEditTimer.current);
        textEditTimer.current = null;
      }
      textEditBaseline.current = null;
      setTextValues({});
      if (iconEditTimer.current !== null) {
        window.clearTimeout(iconEditTimer.current);
        iconEditTimer.current = null;
      }
      iconEditBaseline.current = null;
      setIconDraft(null);
      // Blank every key the doc holds or the scene consumes, never delete: an absent key
      // resurfaces the TSX fallback in the preview.
      const keys = new Set([...baseKeys, ...textKeys, ...consumed]);
      void patchDoc(
        (next) => {
          next.text = Object.fromEntries([...keys].map((k) => [k, ""]));
          writeHeaderIcon(next, undefined);
        },
        { history: "clear text" },
      );
    };
    return (
      <div className="inspector-drill">
        <DrillBack
          label={backLabel}
          onClick={() => {
            flushText();
            closeDrill();
          }}
        />
        <div className="inspector-drill-title">
          Text
          <button
            type="button"
            className="inspector-reset-btn inspector-clear-text"
            title="Blank every text field on this scene (undoable)"
            onClick={clearAllText}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8.5 16.5H4.8L3 14.7a1.5 1.5 0 010-2.1l8.1-8.1a1.5 1.5 0 012.1 0l3.4 3.4a1.5 1.5 0 010 2.1l-6.6 6.5z" />
              <path d="M7.3 7.6l5.6 5.6" />
              <path d="M11 16.5h6" />
            </svg>
            Clear text
          </button>
        </div>
        <div className="inspector-drill-body">
          <div className="wizard-field">
            <span className="wizard-label">Alignment</span>
            <div className="inspector-tabs" role="tablist">
              {ALIGN_OPTIONS.map((o) => (
                <button
                  type="button"
                  key={o.id}
                  role="tab"
                  aria-selected={align === o.id}
                  className={`inspector-tab${align === o.id ? " active" : ""}`}
                  onClick={() => setAlign(o.id)}
                >
                  <AlignIcon id={o.id} />
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {fieldKeys.map((key) => {
            const label = fieldLabels[key] ?? key;
            const colour =
              colourDefaults[key] !== undefined
                ? { key: `${key}Color`, token: resolveFillToken(colourDefaults[key]) }
                : undefined;
            const fontOverride = styleStr(`${key}Font`);
            return (
              <div
                key={key}
                ref={(el) => {
                  textFieldRefs.current[key] = el;
                }}
                className={`text-field-group${selectedTextKey === key ? " selected" : ""}`}
                onFocusCapture={() => {
                  if (selectedTextKey !== key) {
                    useTextEditStore.getState().select({ sceneIndex, key });
                  }
                }}
              >
                <TextFieldRow
                  label={label}
                  value={textValues[key] ?? doc.text?.[key] ?? ""}
                  placeholder={key === "bullets" ? "one bullet per line" : undefined}
                  onChange={(text) => liveText(key, text)}
                  onBlur={flushText}
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
                        onClick={() => openDrill(`text.font:${key}`)}
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
                    <NumberField
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
                    <NumberField
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
                    <NumberField
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
                    <NumberField
                      label="Rotate °"
                      value={styleNum(`${key}RotationDeg`) ?? 0}
                      decimals={1}
                      onCommit={(n) =>
                        patchStyle(
                          `${label.toLowerCase()} rotation`,
                          `${key}RotationDeg`,
                          textRotationWrite(n),
                        )
                      }
                    />
                  </div>
                )}
                {styleCapable.has(key) && (
                  <div className="popover-row text-style-line-row">
                    <span className="popover-inline slider-row-label">Line spacing</span>
                    <DebouncedRange
                      label={`${label} line spacing`}
                      value={styleNum(`${key}LineHeight`) ?? LINE_SPACING_NORMAL}
                      min={TEXT_LINE_HEIGHT_MIN}
                      max={TEXT_LINE_HEIGHT_MAX}
                      step={0.05}
                      onInput={(n) => liveStyle(`${key}LineHeight`, lineSpacing(n))}
                      onCommit={(n) =>
                        commitStyle(
                          `${label.toLowerCase()} line spacing`,
                          `${key}LineHeight`,
                          lineSpacing(n),
                        )
                      }
                    />
                    {styleNum(`${key}LineHeight`) !== undefined && (
                      <button
                        type="button"
                        className="inspector-reset-btn"
                        title="Back to the font's normal line spacing"
                        onClick={() =>
                          patchStyle(
                            `${label.toLowerCase()} line spacing`,
                            `${key}LineHeight`,
                            undefined,
                          )
                        }
                      >
                        Normal
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <HeaderIconField
            value={iconDraft ?? headerIcon}
            selected={headerIcon}
            hint={
              sceneFrame
                ? "Drawn above the panel title. An emoji, or a project image path."
                : "Drawn above the headline. An emoji, or a project image path."
            }
            slug={slug}
            projectPath={workspaceProjectPath(slug) ?? ""}
            onChange={liveHeaderIcon}
            onBlur={flushHeaderIcon}
            onPick={setHeaderIcon}
          />
          {(iconDraft ?? headerIcon).trim() !== "" && (
            <div className="text-style-row text-style-icon">
              <NumberField
                label="Size %"
                value={Math.round((styleNum("iconSize") ?? 1) * 100)}
                decimals={0}
                onCommit={(n) =>
                  patchStyle(
                    "header icon size",
                    "iconSize",
                    n === 100 || n <= 0 ? undefined : Math.min(1000, n) / 100,
                  )
                }
              />
            </div>
          )}
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
                { history: "text motion" },
              )
            }
            onForce={(on) =>
              void patchDoc(
                (next) => {
                  if (on) next.textAnimationForce = true;
                  else delete next.textAnimationForce;
                },
                { history: "text motion" },
              )
            }
          />
        </div>
      </div>
    );
  }
  if (drillIn === "compare.media" && doc?.compare && compareMediaDeviceId) {
    const targetId = compareMediaDeviceId;
    const current = doc.compare.b?.media?.[targetId];
    const pickAfterMedia = (rel: string, meta: MediaMeta | null) => {
      const isVideo = meta?.kind !== "image";
      void patchDoc(
        (next) => {
          if (!next.compare) return;
          if (!next.compare.b) next.compare.b = {};
          if (!next.compare.b.media) next.compare.b.media = {};
          next.compare.b.media[targetId] = { src: rel, kind: isVideo ? "video" : "image" };
        },
        { resync: true },
      );
      closeDrill();
    };
    return (
      <div className="inspector-drill">
        <DrillBack label="Comparison" onClick={() => closeDrill()} />
        <div className="inspector-drill-title">After screen</div>
        <div className="inspector-drill-body">
          {current && (
            <ActionRow
              icon={<SceneRowIcon id="device.media" />}
              label="Match the before side"
              chevron={false}
              onClick={() => {
                void patchDoc(
                  (next) => {
                    if (next.compare?.b?.media) delete next.compare.b.media[targetId];
                  },
                  { resync: true },
                );
                closeDrill();
              }}
            />
          )}
          <div className="wizard-media-host">
            <MediaBrowser
              slug={slug}
              projectPath={workspaceProjectPath(slug) ?? ""}
              kindToggle
              globalToggle
              refreshKey={mediaRefreshKey + mediaRefresh}
              selectedRel={current?.src ?? null}
              onPick={pickAfterMedia}
              cardMenu={mediaCardMenu({
                slug,
                primaryLabel: "Select",
                onPrimary: pickAfterMedia,
                onChanged: () => setMediaRefresh((n) => n + 1),
                onError: setError,
              })}
            />
          </div>
        </div>
      </div>
    );
  }
  if (drillIn === "compare.theme" && doc?.compare) {
    const applyAfterTheme = (id: string) =>
      void patchDoc((next) => {
        if (!next.compare) return;
        if (!next.compare.b) next.compare.b = {};
        next.compare.b.themeId = id || undefined;
      }).then(onTimingChanged);
    const bThemeId = doc.compare.b?.themeId ?? "";
    return (
      <div className="inspector-drill">
        <DrillBack label="Comparison" onClick={() => closeDrill()} />
        <div className="inspector-drill-title">After theme</div>
        <div className="inspector-drill-body">
          <div className="font-slot-row">
            <button
              type="button"
              className={`chip${bThemeId === "" ? " selected" : ""}`}
              onClick={() => applyAfterTheme("")}
            >
              Match the before side
            </button>
          </div>
          <ThemeGrid choices={themeChoices} value={bThemeId} onChange={applyAfterTheme} />
        </div>
      </div>
    );
  }
  if (drillIn === "compare.edit" && doc?.compare) {
    const cmp = doc.compare;
    const patchCompare = (mutate: (c: NonNullable<SceneDoc["compare"]>) => void) =>
      void patchDoc((next) => {
        if (next.compare) mutate(next.compare);
      });
    const cmpLive = (mutate: (c: NonNullable<SceneDoc["compare"]>) => void) => {
      if (!compareDragBaseline.current && doc) compareDragBaseline.current = structuredClone(doc);
      void patchDoc(
        (next) => {
          if (next.compare) mutate(next.compare);
        },
        { history: false },
      );
    };
    const cmpCommit = (mutate: (c: NonNullable<SceneDoc["compare"]>) => void) => {
      const baseline = compareDragBaseline.current;
      compareDragBaseline.current = null;
      if (baseline)
        void commitFromBaseline(baseline, (next) => {
          if (next.compare) mutate(next.compare);
        });
      else patchCompare(mutate);
    };
    const maskType = cmp.mask?.type ?? "linear";
    const maskEntry = COMPARE_MASK_CATALOG.find((e) => e.id === maskType);
    const hasKeys = (cmp.track?.keys.length ?? 0) > 0;
    const applyPreset = (preset: (typeof COMPARE_PRESETS)[number]) => {
      const track = preset.build(scene.durationMs);
      void patchDoc((next) => {
        if (!next.compare) return;
        next.compare.track = track;
      });
    };
    const lineTokens = ["accent", "text", "muted", "background"] as const;
    const bThemeName = cmp.b?.themeId
      ? (themeChoices.find((c) => c.id === cmp.b?.themeId)?.name ?? cmp.b.themeId)
      : "Same as before";
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">Comparison</div>
        <div className="inspector-drill-body">
          <SegmentedRow
            options={COMPARE_MASK_CATALOG.map((e) => ({
              value: e.id,
              label: e.label,
              title: e.hint,
            }))}
            value={maskType}
            onChange={(id) =>
              patchCompare((c) => {
                c.mask = { ...(c.mask ?? {}), type: id };
              })
            }
          />
          {maskEntry?.needsAngle && (
            <div className="popover-row">
              <span className="popover-inline slider-row-label">Angle</span>
              <NumberField
                label="Divider angle"
                value={cmp.mask?.angleDeg ?? 90}
                decimals={0}
                min={0}
                max={360}
                step={1}
                onCommit={(v) =>
                  patchCompare((c) => {
                    c.mask = { ...(c.mask ?? { type: "linear" }), angleDeg: v };
                  })
                }
              />
            </div>
          )}
          {maskEntry?.needsCenter && (
            <div className="popover-row">
              <span className="popover-inline slider-row-label">Centre</span>
              <NumberField
                label="Centre X"
                value={cmp.mask?.center?.[0] ?? 0.5}
                decimals={2}
                min={0}
                max={1}
                step={0.01}
                onCommit={(v) =>
                  patchCompare((c) => {
                    c.mask = {
                      ...(c.mask ?? { type: maskType }),
                      center: [v, c.mask?.center?.[1] ?? 0.5],
                    };
                  })
                }
              />
              <NumberField
                label="Centre Y"
                value={cmp.mask?.center?.[1] ?? 0.5}
                decimals={2}
                min={0}
                max={1}
                step={0.01}
                onCommit={(v) =>
                  patchCompare((c) => {
                    c.mask = {
                      ...(c.mask ?? { type: maskType }),
                      center: [c.mask?.center?.[0] ?? 0.5, v],
                    };
                  })
                }
              />
            </div>
          )}
          <div className="popover-row">
            <span className="popover-inline slider-row-label">Edge softness</span>
            <DebouncedRange
              value={cmp.mask?.softness ?? 0}
              min={0}
              max={0.2}
              step={0.005}
              label="Edge softness"
              onInput={(v) =>
                cmpLive((c) => {
                  c.mask = { ...(c.mask ?? { type: maskType }), softness: v };
                })
              }
              onCommit={(v) =>
                cmpCommit((c) => {
                  c.mask = { ...(c.mask ?? { type: maskType }), softness: v };
                })
              }
            />
          </div>
          {hasKeys ? (
            <p className="inspector-stub-note">
              Keys drive the divider; edit them in the timeline lane below the preview.
            </p>
          ) : (
            <div className="popover-row">
              <span className="popover-inline slider-row-label">Divider</span>
              <DebouncedRange
                value={cmp.value ?? 0.5}
                min={0}
                max={1}
                step={0.01}
                label="Divider position"
                onInput={(v) =>
                  cmpLive((c) => {
                    c.value = v;
                  })
                }
                onCommit={(v) =>
                  cmpCommit((c) => {
                    c.value = v;
                  })
                }
              />
            </div>
          )}
          <DrillGroup label="Motion presets" hint="Writes keys you can hand-tune in the lane.">
            <div className="wizard-presets">
              {COMPARE_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="chip"
                  title={p.hint}
                  onClick={() => applyPreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </DrillGroup>
          <DrillGroup label="Divider line">
            <ToggleRow
              label="Show line"
              checked={!!cmp.chrome?.line}
              onChange={(on) =>
                patchCompare((c) => {
                  c.chrome = {
                    ...c.chrome,
                    line: on ? { width: 4, colour: "accent" } : undefined,
                  };
                })
              }
            />
            {cmp.chrome?.line && (
              <>
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Width</span>
                  <DebouncedRange
                    value={cmp.chrome.line.width ?? 4}
                    min={1}
                    max={12}
                    step={0.5}
                    label="Line width"
                    onInput={(v) =>
                      cmpLive((c) => {
                        if (c.chrome?.line) c.chrome.line.width = v;
                      })
                    }
                    onCommit={(v) =>
                      cmpCommit((c) => {
                        if (c.chrome?.line) c.chrome.line.width = v;
                      })
                    }
                  />
                </div>
                <SegmentedRow
                  className="subtabs-compact"
                  options={lineTokens.map((t) => ({ value: t, label: t }))}
                  value={(cmp.chrome.line.colour ?? "accent") as (typeof lineTokens)[number]}
                  onChange={(t) =>
                    patchCompare((c) => {
                      if (c.chrome?.line) c.chrome.line.colour = t;
                    })
                  }
                />
              </>
            )}
            {maskEntry?.hasGrip && (
              <ToggleRow
                label="Grip handle"
                description="The slider grip riding the divider."
                checked={!!cmp.chrome?.grip}
                onChange={(on) =>
                  patchCompare((c) => {
                    c.chrome = { ...c.chrome, grip: on ? true : undefined };
                  })
                }
              />
            )}
          </DrillGroup>
          <DrillGroup label="Labels">
            <ToggleRow
              label="Before / after chips"
              description="Label chips pinned to each half (text keys beforeLabel and afterLabel)."
              checked={cmp.chrome?.chips === true}
              onChange={(on) =>
                patchCompare((c) => {
                  c.chrome = { ...c.chrome, chips: on ? true : undefined };
                })
              }
            />
          </DrillGroup>
          <DrillGroup label="After tint">
            <SegmentedRow
              className="subtabs-compact"
              options={[
                { value: "none", label: "None" },
                { value: "accent", label: "accent" },
                { value: "text", label: "text" },
                { value: "muted", label: "muted" },
              ]}
              value={(cmp.chrome?.tint?.b ?? "none") as "none" | "accent" | "text" | "muted"}
              onChange={(t) =>
                patchCompare((c) => {
                  c.chrome = {
                    ...c.chrome,
                    tint:
                      t === "none"
                        ? undefined
                        : { ...c.chrome?.tint, b: t, amount: c.chrome?.tint?.amount ?? 0.08 },
                  };
                })
              }
            />
            {cmp.chrome?.tint?.b && (
              <div className="popover-row">
                <span className="popover-inline slider-row-label">Amount</span>
                <DebouncedRange
                  value={cmp.chrome.tint.amount ?? 0.08}
                  min={0}
                  max={0.3}
                  step={0.01}
                  label="Tint amount"
                  onInput={(v) =>
                    cmpLive((c) => {
                      if (c.chrome?.tint) c.chrome.tint.amount = v;
                    })
                  }
                  onCommit={(v) =>
                    cmpCommit((c) => {
                      if (c.chrome?.tint) c.chrome.tint.amount = v;
                    })
                  }
                />
              </div>
            )}
          </DrillGroup>
          <ToggleFieldset
            control={
              <SegmentedRow
                options={[
                  { value: "a" as const, label: "Before" },
                  { value: "b" as const, label: "After" },
                ]}
                value={compareSide}
                onChange={setCompareSide}
              />
            }
          >
            {compareSide === "a" ? (
              <>
                <p className="inspector-stub-note">
                  The before side is this scene itself; these rows edit it in place.
                </p>
                {devices.map((d, i) => (
                  <ActionRow
                    key={d.id}
                    icon={<SceneRowIcon id="device.media" />}
                    label={devices.length > 1 ? `Screen ${i + 1}` : "Screen media"}
                    value={middleTruncate(d.media?.src.split("/").pop() ?? "None")}
                    chevron
                    onClick={() => {
                      setMediaTarget({ kind: "device", deviceId: d.id });
                      setModal("media");
                    }}
                  />
                ))}
                <ActionRow
                  icon={<SceneRowIcon id="style.theme" />}
                  label="Theme"
                  value={sceneTheme?.name}
                  chevron
                  onClick={() => {
                    setThemeDraft(doc.themeId ?? "");
                    openDrill("style.theme");
                  }}
                />
                <ActionRow
                  icon={<SceneRowIcon id="style.background" />}
                  label="Background"
                  chevron
                  onClick={() => {
                    setBgTabOverride(null);
                    setBgTarget("scene");
                    openDrill("style.background");
                  }}
                />
                <ActionRow
                  icon={<SceneRowIcon id="lighting" />}
                  label="Lighting"
                  chevron
                  onClick={() => {
                    setLightingTarget("scene");
                    openDrill("lighting");
                  }}
                />
              </>
            ) : (
              <>
                {devices.map((d, i) => (
                  <ActionRow
                    key={d.id}
                    icon={<SceneRowIcon id="device.media" />}
                    label={devices.length > 1 ? `Screen ${i + 1}` : "Screen media"}
                    value={middleTruncate(
                      cmp.b?.media?.[d.id]?.src.split("/").pop() ?? "Same as before",
                    )}
                    chevron
                    onClick={() => {
                      setCompareMediaDeviceId(d.id);
                      openDrill("compare.media");
                    }}
                  />
                ))}
                <ActionRow
                  icon={<SceneRowIcon id="style.theme" />}
                  label="Theme"
                  value={bThemeName}
                  chevron
                  onClick={() => openDrill("compare.theme")}
                />
                <ActionRow
                  icon={<SceneRowIcon id="style.background" />}
                  label="Background"
                  value={
                    cmp.b?.background
                      ? {
                          none: "None",
                          color: "Colour",
                          gradient: "Gradient",
                          shader: "Animated",
                          scene3d: "3D",
                          image: "Image",
                          video: "Video",
                        }[cmp.b.background.type]
                      : "Same as before"
                  }
                  chevron
                  onClick={() => {
                    setBgTabOverride(null);
                    setBgTarget("compareB");
                    openDrill("style.background");
                  }}
                />
                <ActionRow
                  icon={<SceneRowIcon id="lighting" />}
                  label="Lighting"
                  value={cmp.b?.lighting ? "Overridden" : "Same as before"}
                  chevron
                  onClick={() => {
                    setLightingTarget("compareB");
                    openDrill("lighting");
                  }}
                />
              </>
            )}
          </ToggleFieldset>
          <div className="inspector-section-divider" />
          <ActionRow
            icon={<SceneRowIcon id="device.remove" />}
            label={confirmRemoveCompare ? "Really remove?" : "Remove comparison"}
            chevron={false}
            danger
            onClick={() => {
              if (!confirmRemoveCompare) {
                setConfirmRemoveCompare(true);
                return;
              }
              setConfirmRemoveCompare(false);
              void patchDoc((next) => {
                next.compare = undefined;
                if (next.animatedTrack === "compare") next.animatedTrack = undefined;
              });
              closeDrill();
            }}
          />
        </div>
        {mediaModal}
      </div>
    );
  }
  if (drillIn === "device.change" && device) {
    return (
      <DeviceDrillIn
        model={(device.model in DEVICE_CATALOG ? device.model : "iphone-15-pro") as DeviceId}
        colour={device.colour ?? DEVICE_CATALOG["iphone-15-pro"].defaultColour}
        motion={device.motion?.preset ?? "none"}
        deviceCount={devices.length}
        deviceLabel={`Device ${
          Math.max(
            0,
            devices.findIndex((d) => d.id === deviceId),
          ) + 1
        }`}
        onBack={() => closeDrill()}
        backLabel={backLabel}
        onSave={(model, colour, motion, applyAll) => {
          closeDrill();
          void patchDoc((next) => {
            for (const d of next.devices ?? []) {
              if (!applyAll && d.id !== deviceId) continue;
              d.model = model;
              d.colour = colour;
              d.motion = { ...d.motion, preset: motion };
            }
          });
        }}
      />
    );
  }

  if (drillIn === "layeredScreenshot.edit") {
    return (
      <LayeredScreenshotBuilder
        project={project}
        sceneIndex={sceneIndex}
        onDocChanged={onDocChanged}
        onBack={() => closeDrill()}
        backLabel={backLabel}
      />
    );
  }

  if (drillIn === "objects.placement" && stagedObject) {
    const placement = stagedObject.placement ?? {};
    const pos = placement.position ?? [0, 0, 0];
    const rot = placement.rotationDeg ?? [0, 0, 0];
    const setAxis = (field: "position" | "rotationDeg", axis: number, value: number) =>
      patchObject((o) => {
        const current = o.placement?.[field] ?? [0, 0, 0];
        const next: [number, number, number] = [current[0] ?? 0, current[1] ?? 0, current[2] ?? 0];
        next[axis] = value;
        o.placement = { ...o.placement, [field]: next };
        if (field === "position" && axis === 1) delete o.placement.ground;
      });
    return (
      <>
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">{objectRowLabel(stagedObject.objectId)}</div>
        <div className="inspector-section-body object-drill">
          <DrillGroup label="Gizmo">
            <SegmentedRow
              options={GIZMO_MODE_OPTIONS}
              value={gizmoMode}
              onChange={(mode) => useObjectEditStore.getState().setGizmoMode(mode)}
            />
            <span className="drill-group-hint">
              Drag the gizmo in the preview; Scale resizes evenly.
            </span>
          </DrillGroup>
          <DrillGroup label="Presets">
            <div className="wizard-presets object-preset-chips">
              {device && (
                <button
                  type="button"
                  className="chip"
                  onClick={() =>
                    patchObject((o) => {
                      o.placement = besideDevicePlacement(device, "left");
                    })
                  }
                >
                  <ObjectPresetIcon id="left" />
                  Left of device
                </button>
              )}
              {device && (
                <button
                  type="button"
                  className="chip"
                  onClick={() =>
                    patchObject((o) => {
                      o.placement = besideDevicePlacement(device, "right");
                    })
                  }
                >
                  <ObjectPresetIcon id="right" />
                  Right of device
                </button>
              )}
              {device && (
                <button
                  type="button"
                  className="chip"
                  onClick={() =>
                    patchObject((o) => {
                      o.placement = frontOfDevicePlacement(device);
                    })
                  }
                >
                  <ObjectPresetIcon id="front" />
                  In front
                </button>
              )}
              <button
                type="button"
                className="chip"
                onClick={() =>
                  patchObject((o) => {
                    o.placement = floorCentrePlacement();
                  })
                }
              >
                <ObjectPresetIcon id="floor" />
                Floor centre
              </button>
            </div>
          </DrillGroup>
          <DrillGroup label="Pose">
            <div className="inspector-pose-grid">
              {(["x", "y", "z"] as const).map((label, axis) => (
                <NumberField
                  key={label}
                  label={label}
                  value={pos[axis] ?? 0}
                  decimals={2}
                  onCommit={(n) => setAxis("position", axis, n)}
                />
              ))}
            </div>
            <div className="inspector-pose-grid">
              {(["tilt x °", "turn y °", "roll z °"] as const).map((label, axis) => (
                <NumberField
                  key={label}
                  label={label}
                  value={rot[axis] ?? 0}
                  decimals={1}
                  onCommit={(n) => setAxis("rotationDeg", axis, n)}
                />
              ))}
            </div>
            <div className="inspector-pose-grid">
              <NumberField
                label="scale ×"
                value={placement.scale ?? 1}
                decimals={2}
                onCommit={(n) =>
                  patchObject((o) => {
                    o.placement = { ...o.placement, scale: Math.max(0.01, n) };
                  })
                }
              />
            </div>
          </DrillGroup>
          <ToggleRow
            icon={<SceneRowIcon id="objects.edit" />}
            label="Rest on floor"
            description="Seats the object's base on the staged floor; off keeps the y above."
            checked={placement.ground ?? false}
            onChange={(on) =>
              patchObject((o) => {
                o.placement = { ...o.placement, ground: on };
                if (!on) delete o.placement.ground;
              })
            }
          />
          <ActionRow
            icon={<SceneRowIcon id="device.remove" />}
            label="Remove object"
            chevron={false}
            danger
            onClick={() => {
              closeDrill();
              setPickedObjectId(null);
              void patchDoc((next) => {
                next.objects = (next.objects ?? []).filter((x) => x.id !== stagedObject.id);
              });
            }}
          />
        </div>
      </>
    );
  }

  if (drillIn === "device.position" && doc && devices.length > 0) {
    const layout = doc.deviceLayout;
    const posLive = (mutate: (next: SceneDoc) => void) => {
      if (!posDragBaseline.current) posDragBaseline.current = structuredClone(doc);
      void patchDoc(mutate, { history: false });
    };
    const posCommit = (mutate: (next: SceneDoc) => void) => {
      const baseline = posDragBaseline.current;
      posDragBaseline.current = null;
      if (baseline) void commitFromBaseline(baseline, mutate);
      else void patchDoc(mutate);
    };
    const offsetSlider = (
      id: string,
      label: string,
      axis: 0 | 1 | 2,
      value: number,
      min: number,
      max: number,
    ) => {
      const write = (next: SceneDoc, val: number) => {
        if (layout) {
          mutateDelta(next, id, (delta) => {
            const offset: V3 = [...(delta.offset ?? [0, 0, 0])];
            offset[axis] = val;
            delta.offset = offset;
          });
        } else {
          mutatePlacement(next, id, (p) => {
            const position: V3 = [...(p.position ?? [0, -0.3, 0])];
            position[axis] = val;
            p.position = position;
          });
        }
      };
      return (
        <div className="popover-row" key={`${id}.${label}`}>
          <span className="popover-inline slider-row-label">{label}</span>
          <DebouncedRange
            value={value}
            min={min}
            max={max}
            step={0.01}
            label={label}
            onInput={(val) => posLive((next) => write(next, val))}
            onCommit={(val) => posCommit((next) => write(next, val))}
          />
        </div>
      );
    };
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={() => closeDrill()} />
        <div className="inspector-drill-title">
          <span>Position</span>
        </div>
        <div className="inspector-drill-body">
          <DrillGroup label="Gizmo">
            {devices.length > 1 && (
              <SegmentedRow
                className="subtabs-compact"
                options={devicePillOptions}
                value={deviceId ?? devices[0].id}
                onChange={pickDevice}
              />
            )}
            <SegmentedRow
              options={GIZMO_MODE_OPTIONS}
              value={deviceGizmoMode}
              onChange={(mode) => useDeviceEditStore.getState().setGizmoMode(mode)}
            />
            <span className="drill-group-hint">
              Drag the gizmo in the preview; Scale resizes evenly.
            </span>
          </DrillGroup>
          {devices.length > 1 && (
            <DrillGroup label="Layout">
              <div className="wizard-presets">
                {DEVICE_LAYOUT_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`chip${layout?.preset === p ? " selected" : ""}`}
                    title={LAYOUT_PRESET_LABELS[p].title}
                    onClick={() =>
                      void patchDoc((next) => {
                        // A preset tap overrides the per-device tuning below: deltas reset, gap survives.
                        next.deviceLayout = {
                          preset: p,
                          ...(next.deviceLayout?.gap !== undefined
                            ? { gap: next.deviceLayout.gap }
                            : {}),
                        };
                      })
                    }
                  >
                    {LAYOUT_PRESET_LABELS[p].label}
                  </button>
                ))}
              </div>
              {layout && (
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Gap</span>
                  <DebouncedRange
                    value={layout.gap ?? 0.35}
                    min={-0.5}
                    max={2}
                    step={0.01}
                    label="Gap"
                    onInput={(val) =>
                      posLive((next) => {
                        if (next.deviceLayout) next.deviceLayout.gap = val;
                      })
                    }
                    onCommit={(val) =>
                      posCommit((next) => {
                        if (next.deviceLayout) next.deviceLayout.gap = val;
                      })
                    }
                  />
                </div>
              )}
            </DrillGroup>
          )}
          {devices.map((d, i) => {
            const delta = layout?.devices?.[d.id] ?? {};
            const offset = layout
              ? (delta.offset ?? [0, 0, 0])
              : (d.placement?.position ?? [0, -0.3, 0]);
            const rotation = layout
              ? (delta.rotationDeg ?? [0, 0, 0])
              : (d.placement?.rotationDeg ?? [0, 0, 0]);
            const scale = layout ? (delta.scale ?? 1) : (d.placement?.scale ?? 1);
            const modelName = isDeviceId(d.model) ? DEVICE_CATALOG[d.model].name : d.model;
            const writeRotation = (next: SceneDoc, rotationDeg: V3) => {
              if (layout) {
                mutateDelta(next, d.id, (dd) => {
                  dd.rotationDeg = rotationDeg;
                });
              } else {
                mutatePlacement(next, d.id, (p) => {
                  p.rotationDeg = rotationDeg;
                });
              }
            };
            const matches = (v: V3) => v.every((n, k) => Math.abs(n - rotation[k]) < 0.05);
            return (
              <DrillGroup
                key={d.id}
                label={devices.length > 1 ? `Device ${i + 1} · ${modelName}` : modelName}
              >
                {offsetSlider(d.id, "Left-right", 0, offset[0], -3, 3)}
                {offsetSlider(d.id, "Up-down", 1, offset[1], -1.5, 1.5)}
                {offsetSlider(d.id, "Depth", 2, offset[2], -2, 2)}
                {!layout && (
                  <div className="wizard-presets">
                    {ROTATION_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`chip${matches(p.value) ? " selected" : ""}`}
                        onClick={() => void patchDoc((next) => writeRotation(next, [...p.value]))}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="inspector-pose-grid">
                  {ROTATION_AXIS_LABELS.map((label, axis) => (
                    <NumberField
                      key={label}
                      label={label}
                      value={rotation[axis]}
                      decimals={1}
                      onCommit={(n) =>
                        void patchDoc((next) => {
                          const rotationDeg: V3 = [...rotation];
                          rotationDeg[axis] = n;
                          writeRotation(next, rotationDeg);
                        })
                      }
                    />
                  ))}
                </div>
                <div className="popover-row">
                  <span className="popover-inline slider-row-label">Scale</span>
                  <DebouncedRange
                    value={scale}
                    min={0.4}
                    max={2}
                    step={0.01}
                    label="Scale"
                    onInput={(val) =>
                      posLive((next) => {
                        if (layout) {
                          mutateDelta(next, d.id, (dd) => {
                            dd.scale = val;
                          });
                        } else {
                          mutatePlacement(next, d.id, (p) => {
                            p.scale = val;
                          });
                        }
                      })
                    }
                    onCommit={(val) =>
                      posCommit((next) => {
                        if (layout) {
                          mutateDelta(next, d.id, (dd) => {
                            dd.scale = val;
                          });
                        } else {
                          mutatePlacement(next, d.id, (p) => {
                            p.scale = val;
                          });
                        }
                      })
                    }
                  />
                </div>
                <ToggleRow
                  label="Ground"
                  description="Rests the device on the staged floor; inert without one."
                  checked={d.placement?.ground === true}
                  onChange={(on) =>
                    void patchDoc((next) =>
                      mutatePlacement(next, d.id, (p) => {
                        if (on) p.ground = true;
                        else delete p.ground;
                      }),
                    )
                  }
                />
                <ActionRow
                  label={layout ? "Back to layout" : "Reset position"}
                  chevron={false}
                  onClick={() =>
                    void patchDoc((next) => {
                      if (next.deviceLayout) {
                        if (next.deviceLayout.devices) {
                          delete next.deviceLayout.devices[d.id];
                          if (Object.keys(next.deviceLayout.devices).length === 0)
                            delete next.deviceLayout.devices;
                        }
                      } else {
                        mutatePlacement(next, d.id, (p) => {
                          p.position = [0, -0.3, 0];
                          p.rotationDeg = [0, 0, 0];
                          p.scale = 1;
                        });
                      }
                    })
                  }
                />
              </DrillGroup>
            );
          })}
        </div>
      </div>
    );
  }

  if (drillIn === "chart.edit" && doc?.chart) {
    return (
      <ChartDrillIn
        doc={doc}
        theme={sceneTheme ?? project.theme}
        hasPanel={sceneFrame !== undefined}
        panelHostsChart={!!sceneFrame?.chart && sceneFrame.chart.enabled !== false}
        backLabel={backLabel}
        onBack={closeDrill}
        onOpenPosition={() => openDrill("chart.position")}
        patchDoc={patchDoc}
        commitFromBaseline={commitFromBaseline}
      />
    );
  }

  if (drillIn === "chart.position" && doc?.chart?.mount === "staged") {
    return (
      <ChartPlacementDrillIn
        doc={doc}
        backLabel={backLabel}
        onBack={closeDrill}
        patchDoc={patchDoc}
        commitFromBaseline={commitFromBaseline}
      />
    );
  }

  // ── The section list ──────────────────────────────────────────────────────
  const renderSectionRows = (section: SceneSectionModel) =>
    section.rows.map((row) => {
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
        const lid = isDeviceId(device.model) ? DEVICE_CATALOG[device.model].lid : undefined;
        return (
          <LidRow
            key={row.id}
            lidDeg={device.lidDeg ?? lid?.defaultDeg ?? 90}
            openDeg={lid?.openDeg ?? 110}
            onCommit={(deg) =>
              patchDevice((d) => {
                d.lidDeg = deg;
              })
            }
          />
        );
      }
      if (row.id === "frame.enabled") {
        return (
          <ToggleRow
            key={row.id}
            icon={<SceneRowIcon id="frame.enabled" />}
            label="Show on this scene"
            description={
              project.deckFrame !== undefined
                ? "Shows the deck's overlay panel on this scene."
                : "Shows the overlay panel on this scene."
            }
            checked={sceneFrame !== undefined}
            onChange={(on) =>
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
      if (row.id.startsWith("objects.edit:")) {
        const objectEditId = row.id.slice("objects.edit:".length);
        return (
          <ActionRow
            key={row.id}
            icon={<SceneRowIcon id="objects.edit" />}
            label={row.label}
            chevron={row.chevron}
            onClick={() => {
              setPickedObjectId(objectEditId);
              openDrill("objects.placement");
            }}
          />
        );
      }
      const onClick = {
        "device.media": () => {
          setMediaTarget({ kind: "device", deviceId });
          setModal("media");
        },
        "device.editVideo": () =>
          device?.media && onOpenEditVideo(sceneIndex, device.media.src, "device", device.id),
        "device.change": () => openDrill("device.change"),
        "device.add": addDevice,
        "objects.add": () => setObjectPickerOpen(true),
        "device.duplicate": duplicateDevice,
        "frame.add": addOverlay,
        "device.position": () => openDrill("device.position"),
        // Both paths drill into the builder; it seeds the first layer for scenes without a block.
        "layeredScreenshot.edit": () => openDrill("layeredScreenshot.edit"),
        "layeredScreenshot.add": () => openDrill("layeredScreenshot.edit"),
        // Both paths drill into the editor; it creates the block on the first media pick.
        "videoWindow.edit": () => openDrill("videoWindow.edit"),
        "videoWindow.add": () => openDrill("videoWindow.edit"),
        "device.remove": () => {
          if (!confirmRemove) {
            setConfirmRemove(true);
            return;
          }
          setConfirmRemove(false);
          pickDevice(null);
          void patchDoc((next) => {
            next.devices = (next.devices ?? []).filter((x) => x.id !== deviceId);
          });
        },
        "motion.transition": () => {
          void listCachedSceneThumbs(project).then(setThumbs);
          openDrill("motion.transition");
        },
        "style.theme": () => {
          if (!doc) return;
          setThemeDraft(doc.themeId ?? "");
          openDrill("style.theme");
        },
        "style.background": () => {
          setBgTabOverride(null);
          setBgTarget("scene");
          openDrill("style.background");
        },
        "style.shadow": () => openDrill("style.shadow"),
        "frame.cutout": () => openDrill("frame.cutout"),
        "frame.panel": () => openDrill("frame.panel"),
        "frame.chip": () => openDrill("frame.chip"),
        "frame.decorations": () => openDrill("frame.decorations"),
        "frame.icon": () => openDrill("frame.icon"),
        "frame.text": () => openDrill("frame.text"),
      }[row.id];
      const value = {
        "text.motion": doc?.textAnimation ? describeSpec(doc.textAnimation) : "Theme default",
        "device.change": device
          ? DEVICE_CATALOG[
              (device.model in DEVICE_CATALOG ? device.model : "iphone-15-pro") as DeviceId
            ].name
          : undefined,
        "device.position": doc?.deviceLayout
          ? LAYOUT_PRESET_LABELS[doc.deviceLayout.preset].label
          : device
            ? (device.placement?.rotationDeg ?? [0, 0, 0]).map((n) => `${Math.round(n)}°`).join(" ")
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
                scene3d: "3D",
                image: "Image",
                video: "Video",
              }[doc.background.type]
          : undefined,
        "style.shadow": device
          ? SHADOW_OPTIONS.find((o) => o.id === (device.shadow ?? "soft"))?.label
          : undefined,
        "frame.cutout": sceneFrame ? FRAME_SHAPE_LABELS[sceneFrame.cutout.shape] : undefined,
        "frame.panel": sceneFrame ? panelFillLabel(sceneFrame.background) : undefined,
        "frame.chip": sceneFrame ? (sceneFrame.chip?.label ?? "None") : undefined,
        "frame.decorations": sceneFrame
          ? sceneFrame.decorations?.length
            ? String(sceneFrame.decorations.length)
            : "None"
          : undefined,
        "frame.icon": sceneFrame ? (sceneFrame.icon ?? "None") : undefined,
        "frame.text": sceneFrame
          ? (ALIGN_OPTIONS.find((a) => a.id === (sceneFrame.textAlign ?? "left"))?.label ?? "Left")
          : undefined,
      }[row.id];
      return (
        <ActionRow
          key={row.id}
          icon={<SceneRowIcon id={row.id} />}
          label={row.id === "device.remove" && confirmRemove ? "Really remove?" : row.label}
          value={value}
          chevron={row.chevron}
          danger={row.danger}
          selected={row.id === "device.media" && modal === "media"}
          onClick={onClick}
        />
      );
    });

  if (drillIn === "camera") {
    return (
      <CameraSectionBody
        project={project}
        sceneIndex={sceneIndex}
        onDocChanged={onDocChanged}
        onBack={closeDrill}
        patchDoc={patchDoc}
      />
    );
  }
  if (drillIn === "lighting" && doc) {
    // The after target hands the section a doc VIEW whose `lighting` is side B's, with write wrappers transplanting the field back; the section itself never learns about comparisons.
    const forAfter = lightingTarget === "compareB" && !!doc.compare;
    return (
      <LightingSectionBody
        doc={forAfter ? { ...doc, lighting: doc.compare?.b?.lighting } : doc}
        theme={
          forAfter
            ? (project.compareBThemes[sceneIndex] ?? sceneTheme ?? project.theme)
            : (sceneTheme ?? project.theme)
        }
        projectId={project.id}
        projectLighting={project.projectLighting}
        slot={scene}
        onBack={closeDrill}
        patchDoc={forAfter ? patchLightingDoc : patchDoc}
        commitFromBaseline={forAfter ? commitLightingFromBaseline : commitFromBaseline}
      />
    );
  }
  const groupSection =
    drillIn && drillIn !== "camera" && drillIn !== "lighting"
      ? sections.find((s) => s.id === drillIn)
      : undefined;
  if (groupSection) {
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} onClick={closeDrill} />
        <div className="inspector-drill-title">
          {groupSection.id === "device"
            ? groupSection.label
            : (SCREEN_TITLES[groupSection.id] ?? groupSection.label)}
        </div>
        {groupSection.id === "device" && devices.length > 1 && (
          <SegmentedRow
            className="subtabs-compact"
            options={devicePillOptions}
            value={deviceId ?? devices[0].id}
            onChange={pickDevice}
          />
        )}
        <div className="inspector-drill-body inspector-rows">{renderSectionRows(groupSection)}</div>
        {mediaModal}
        {objectPickerOpen && (
          <ObjectPicker onPick={addObjectFromPicker} onCancel={() => setObjectPickerOpen(false)} />
        )}
      </div>
    );
  }

  const deviceName = device
    ? DEVICE_CATALOG[(device.model in DEVICE_CATALOG ? device.model : "iphone-15-pro") as DeviceId]
        .name
    : undefined;
  const bgLabel = doc
    ? doc.background === undefined
      ? "Theme default"
      : {
          none: "None",
          color: "Colour",
          gradient: "Gradient",
          shader: "Animated",
          scene3d: "3D",
          image: "Image",
          video: "Video",
        }[doc.background.type]
    : undefined;
  // The Scene tab's top level, in three divided sections: what the scene HAS (with the
  // Change/Edit video pair adjacent), what can be ADDED, then the scene settings; the
  // Delete row keeps its own bottom section. Gating mirrors sceneSections; icons reuse
  // the SceneRowIcon glyphs.
  interface TopEntry {
    key: string;
    label: string;
    icon: string;
    value?: string;
    /** False for instant in-place actions that open nothing (Add device). */
    chevron?: boolean;
    onClick: () => void;
  }
  const contentEntries: TopEntry[] = [];
  const addEntries: TopEntry[] = [];
  const settingEntries: TopEntry[] = [];
  if (doc)
    contentEntries.push({
      key: "text",
      label: "Text",
      icon: "text.edit",
      onClick: () => openDrill("text"),
    });
  const deviceVideo = device?.media?.kind === "video" ? device.media.src : undefined;
  const windowVideo = doc?.videoWindow?.media.src;
  if (device)
    contentEntries.push({
      key: "device",
      label: devices.length > 1 ? "Devices" : "Device",
      icon: "device.change",
      value: devices.length > 1 ? `${devices.length}` : deviceName,
      onClick: () => openDrill("device"),
    });
  else if (doc)
    addEntries.push({
      key: "device.add",
      label: "Add device",
      icon: "device.add",
      chevron: false,
      onClick: addDevice,
    });
  if (doc?.layeredScreenshot)
    contentEntries.push({
      key: "stack",
      label: "Screenshot stack",
      icon: "layeredScreenshot.edit",
      onClick: () => openDrill("layeredScreenshot.edit"),
    });
  else if (doc)
    addEntries.push({
      key: "stack",
      label: "Add screenshot stack",
      icon: "layeredScreenshot.edit",
      onClick: () => openDrill("layeredScreenshot.edit"),
    });
  if (doc?.videoWindow)
    contentEntries.push({
      key: "vw",
      label: "Video window",
      icon: "videoWindow.edit",
      onClick: () => openDrill("videoWindow.edit"),
    });
  else if (doc)
    addEntries.push({
      key: "vw",
      label: "Add video window",
      icon: "videoWindow.edit",
      onClick: () => openDrill("videoWindow.edit"),
    });
  if (doc?.compare)
    contentEntries.push({
      key: "compare",
      label: "Comparison",
      icon: "compare.edit",
      onClick: () => openDrill("compare.edit"),
    });
  else if (doc)
    addEntries.push({
      key: "compare.add",
      label: "Add comparison",
      icon: "compare.edit",
      onClick: addCompare,
    });
  if (doc?.chart)
    contentEntries.push({
      key: "chart",
      label: "Chart",
      icon: "chart.edit",
      value: chartRowValue(doc.chart),
      onClick: () => openDrill("chart.edit"),
    });
  else if (doc)
    addEntries.push({
      key: "chart.add",
      label: "Add chart",
      icon: "chart.add",
      chevron: false,
      onClick: addChart,
    });
  if (objects.length > 0)
    contentEntries.push({
      key: "objects",
      label: objects.length > 1 ? "Objects" : "Object",
      icon: "objects.edit",
      value: objects.length > 1 ? `${objects.length}` : objectRowLabel(objects[0].objectId),
      onClick: () => openDrill("objects"),
    });
  else if (doc)
    addEntries.push({
      key: "objects.add",
      label: "Add object",
      icon: "objects.add",
      onClick: () => setObjectPickerOpen(true),
    });
  // The video pair closes the content section, always adjacent: Change video first (the
  // device's picker wins when a scene has both surfaces), its edit right under.
  if (device || doc?.videoWindow)
    contentEntries.push({
      key: "changeVideo",
      label: "Change video",
      icon: "device.media",
      onClick: device
        ? () => {
            setMediaTarget({ kind: "device", deviceId });
            setModal("media");
          }
        : () => openDrill("videoWindow.media"),
    });
  if (deviceVideo)
    contentEntries.push({
      key: "editVideo.device",
      label: windowVideo ? "Edit device video" : "Edit video",
      icon: "device.editVideo",
      chevron: false,
      onClick: () => onOpenEditVideo(sceneIndex, deviceVideo, "device", device?.id),
    });
  else if (windowVideo)
    contentEntries.push({
      key: "editVideo.vw",
      label: "Edit video",
      icon: "device.editVideo",
      chevron: false,
      onClick: () => onOpenEditVideo(sceneIndex, windowVideo, "videoWindow"),
    });
  if (deviceVideo && windowVideo)
    contentEntries.push({
      key: "editVideo.vw",
      label: "Edit recording",
      icon: "device.editVideo",
      chevron: false,
      onClick: () => onOpenEditVideo(sceneIndex, windowVideo, "videoWindow"),
    });
  if (project.deckFrame !== undefined || doc?.frame?.cutout !== undefined)
    contentEntries.push({
      key: "frame",
      label: "Overlay",
      icon: "frame",
      onClick: () => openDrill("frame"),
    });
  else if (doc)
    addEntries.push({
      key: "frame.add",
      label: "Add overlay",
      icon: "frame.add",
      chevron: false,
      onClick: addOverlay,
    });
  if (doc) {
    const themeId = doc.themeId ?? "";
    settingEntries.push({
      key: "theme",
      label: "Theme",
      icon: "style.theme",
      value: sceneTheme?.name,
      onClick: () => {
        setThemeDraft(themeId);
        openDrill("style.theme");
      },
    });
    settingEntries.push({
      key: "background",
      label: "Background",
      icon: "style.background",
      value: bgLabel,
      onClick: () => {
        setBgTabOverride(null);
        setBgTarget("scene");
        openDrill("style.background");
      },
    });
  }
  settingEntries.push({
    key: "camera",
    label: "Animations",
    icon: "camera.animate",
    onClick: () => openDrill("camera"),
  });
  if (doc)
    settingEntries.push({
      key: "lighting",
      label: "Lighting",
      icon: "lighting",
      onClick: () => {
        setLightingTarget("scene");
        openDrill("lighting");
      },
    });
  if (project.slots.length > 1) {
    settingEntries.push({
      key: "transition",
      label: "Transition",
      icon: "motion.transition",
      value: transitionValue,
      onClick: () => {
        void listCachedSceneThumbs(project).then(setThumbs);
        openDrill("motion.transition");
      },
    });
  }
  const renderEntry = (entry: TopEntry) => (
    <ActionRow
      key={entry.key}
      icon={<SceneRowIcon id={entry.icon} />}
      label={entry.label}
      value={entry.value}
      chevron={entry.chevron ?? true}
      onClick={entry.onClick}
    />
  );

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
          This scene has no scene document yet, so its text, media and style can't be edited here.
          Ask Claude to add one in the terminal, or edit the scene file directly.
        </p>
      )}
      {contentEntries.length > 0 && (
        <>
          <div className="inspector-rows">{contentEntries.map(renderEntry)}</div>
          <div className="inspector-section-divider" />
        </>
      )}
      {addEntries.length > 0 && (
        <>
          <div className="inspector-rows inspector-section-body">{addEntries.map(renderEntry)}</div>
          <div className="inspector-section-divider" />
        </>
      )}
      <div className="inspector-rows inspector-section-body">
        {settingEntries.map(renderEntry)}
        <DurationRow
          durationMs={scene.durationMs}
          mode={durationMode}
          onCommit={(ms) => void commitDuration(ms)}
        />
      </div>
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
      {objectPickerOpen && (
        <ObjectPicker onPick={addObjectFromPicker} onCancel={() => setObjectPickerOpen(false)} />
      )}
    </>
  );
}
