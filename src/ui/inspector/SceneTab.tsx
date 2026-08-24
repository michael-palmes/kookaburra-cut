import { ask } from "@tauri-apps/plugin-dialog";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { useCameraEditStore } from "../../engine/cameraEditStore";
import { useChartEditStore } from "../../engine/chartEditStore";
import { useClockStore } from "../../engine/clock";
import { COMPARE_GRIP_CATALOG, COMPARE_MASK_CATALOG } from "../../engine/compareCatalog";
import { useCompareEditStore } from "../../engine/compareEditStore";
import { COMPARE_PRESETS } from "../../engine/comparePresets";
import { useDecorationEditStore } from "../../engine/decorationEditStore";
import { useSceneIsBanded } from "../../engine/depthStageRegistry";
import { useDeviceEditStore } from "../../engine/deviceEditStore";
import { isExporting, subscribeExporting } from "../../engine/exportState";
import { useFormat } from "../../engine/format";
import { mergeFrameSpec } from "../../engine/frameSchema";
import type { GizmoMode } from "../../engine/gizmoMode";
import type { GizmoDomain } from "../../engine/gizmoRegistry";
import { useGizmoSectionOpen } from "../../engine/gizmoSections";
import { pushHistory } from "../../engine/history";
import { imageEditCommitMatches, useImageEditStore } from "../../engine/imageEditStore";
import { useImageReconciliationStore } from "../../engine/imageReconciliationStore";
import { useLayeredScreenshotEditStore } from "../../engine/layeredScreenshotEditStore";
import { useLightingEditStore } from "../../engine/lightingEditStore";
import { deriveManagedTextModel, resolveManagedTextGroups } from "../../engine/managedText";
import { formatMediaDuration, fsUrl, type MediaMeta, mediaMeta } from "../../engine/media";
import { useObjectEditStore } from "../../engine/objectEditStore";
import { optionPreviewClip, optionPreviewStill } from "../../engine/optionPreviews";
import {
  type LoadedProject,
  resolveAssetPath,
  sceneFileStem,
  workspaceProjectPath,
} from "../../engine/project";
import { readProjectManifestSnapshot, updateSceneTransition } from "../../engine/projectEdit";
import { defaultOrbitPose } from "../../engine/sceneCamera";
import { type CameraDoc, nearestKey, type RigDoc, setKeyPose } from "../../engine/sceneCameraEdit";
import { applyBackgroundToAllScenes, type EditRepointSlot } from "../../engine/sceneDoc";
import {
  type DeviceLayoutPreset,
  isSceneImageSource,
  type SceneDoc,
  type SceneDocCameraPose,
  type SceneDocCompareGrip,
  type SceneDocDeviceLayoutDelta,
  type SceneDocMediaSpec,
  type SceneDocRigPose,
  type SceneMediaKind,
  type SceneTextAlign,
  TEXT_LINE_HEIGHT_MAX,
  TEXT_LINE_HEIGHT_MIN,
} from "../../engine/sceneDocSchema";
import {
  createSceneMedia,
  DEFAULT_SCENE_MEDIA_WINDOW_RADIUS,
  editSceneDocMedia,
  nextSceneMediaId,
  resolveSceneDocMedia,
} from "../../engine/sceneMedia";
import { defaultRigPose } from "../../engine/sceneRig";
import { canRigConvertToOrbit, orbitToRig, rigToOrbit } from "../../engine/sceneRigConvert";
import { useLargestSceneText, useSceneTextRegistry } from "../../engine/sceneTextRegistry";
import { listCachedSceneThumbs } from "../../engine/sceneThumbs";
import { captureCurrentFrame } from "../../engine/snapshots";
import {
  useSceneHostStageBackdrop,
  useSceneStageBackdrop,
  useSceneStageFloorY,
} from "../../engine/stageRegistry";
import { ensureFontRefsPinned } from "../../engine/systemFonts";
import { useTextEditStore } from "../../engine/textEditStore";
import {
  codedTextLookNames,
  codedTextMotionNames,
  nonSceneTextKeys,
  textKeyColorDefaults,
  useTextKeyRegistry,
  virtualManagedTextRegistrations,
} from "../../engine/textKeyRegistry";
import { TRANSITION_CATALOG } from "../../engine/transitionCatalog";
import { DEFAULT_LOOP_BLEND_MS } from "../../present/cameraLoop";
import { useUiStore } from "../../store/uiStore";
import { formatFontString, parseFontString } from "../../theme/fontRef";
import { preloadAppFonts } from "../../theme/fonts";
import type { Theme, ThemeBackdrop, ThemeBackground } from "../../theme/tokens";
import {
  DEFAULT_DEVICE_ID,
  DEVICE_CATALOG,
  isDeviceId,
  resolveAvailableDeviceId,
  resolveAvailableDeviceSpec,
} from "../../toolkit/device/catalog";
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
import { ComparisonSideIcon } from "../ComparisonSideIcon";
import { ContextMenu, type ContextMenuState } from "../ContextMenu";
import { useCameraDoc } from "../cameraDoc";
import { ColourPicker } from "../colour/ColourPicker";
import { formatSceneLength, formatSceneLengthMs, parseSceneLengthMs } from "../durationText";
import { FontPicker } from "../FontPicker";
import { useFreeCameraWarning } from "../freeCameraWarning";
import { GradientPickerModal } from "../GradientPicker";
import {
  deriveSceneOverview,
  drillStackForScene,
  objectRowLabel,
  type SceneOverviewContentType,
  type SceneOverviewRowModel,
  type SceneSectionModel,
  sceneSections,
} from "../inspectorOptions";
import {
  chartInspectorScreenForRoute,
  chartSeriesInspectorRoute,
  sceneInspectorScreenTitle,
  textIconInspectorRoute,
  textIconInspectorScreenForRoute,
} from "../inspectorTitles";
import { HEADER_EMOJIS } from "../SceneTextFields";
import { detectWindowRecording } from "../windowRecordingDetect";
import { ArrangeDevicesDrill } from "./ArrangeDevicesDrill";
import { ChartDrillIn, ChartPlacementDrillIn, newChartBlock } from "./ChartSection";
import { clickInspectorRemoveAction, contentDeleteRoute } from "./contentDeleteKey";
import { nextNumberedContentId } from "./contentIds";
import {
  type ContentDocActionPlan,
  type ContentMenuAction,
  contentMenuActions,
  planContentDelete,
  planContentDuplicate,
} from "./contentMenuActions";
import { modalOwnsKeyboard } from "./InspectorNavigationShell";
import { type LightingInspectorScreen, LightingInspectorSection } from "./LightingInspectorSection";
import {
  comparisonLightingEditorDoc,
  type LightingAnimationScope,
  mutateComparisonLightingTarget,
} from "./lightingEditorModel";
import { ManagedTextDrill, type ManagedTextWrite, TextControlIcon } from "./ManagedTextDrill";
import { MediaDrillIn, type MediaMutation, type MediaMutationOptions } from "./MediaDrillIn";
import {
  applyManagedTextStructuralAction,
  type ManagedTextStructuralAction,
  type ManagedTextTakeoverRequest,
  managedFrameIconValue,
  managedTextAlignment,
  managedTextVirtualOptionsForFrame,
  performManagedTextStructuralAction,
  selectedManagedTextGroup,
  setLegacyManagedTextIcon,
  setManagedFrameIcon,
  setManagedTextAlignment,
  setManagedTextIcon,
} from "./managedTextEditorModel";
import {
  defaultSceneMediaHost,
  duplicateSceneMedia,
  isMediaDrillRoute,
  LEGACY_MEDIA_DRILL_ROUTE,
  legacyMediaRowId,
  MEDIA_DRILL_ROUTE,
  mediaRowId,
  promoteLegacyMedia,
  reconcileMediaEditor,
  removeSceneMedia,
  replaceSceneDoc,
} from "./mediaEditorModel";
import {
  TextIconEmojiPickerDrill,
  TextIconImagePickerDrill,
  textIconPickerMountKey,
} from "./TextIconPickerDrill";
import { TextLookDrill } from "./TextLookDrill";
import { TextMotionDrill } from "./TextMotionDrill";
import { loadTextIconRecents, storeTextIconRecent } from "./textIconRecents";

/** Sideways step between newly added phones. */
const DEVICE_STEP_X = 1.4;

const LAYOUT_PRESET_LABELS: Record<DeviceLayoutPreset, { label: string; title: string }> = {
  row: { label: "Row", title: "A flat line-up facing the camera" },
  "toe-in": { label: "Toe-in", title: "A row with outer devices turned toward centre" },
  arc: { label: "Arc", title: "A shallow arc, outer devices receding" },
  cascade: { label: "Cascade", title: "Fanned cards stepping across and back" },
  hero: { label: "Hero", title: "Device 1 forward, the rest flanking behind" },
  "depth-pair": { label: "Depth", title: "Two devices split front and back" },
};

const LIGHTING_ROUTES: Record<string, LightingInspectorScreen> = {
  lighting: "overview",
  "lighting.environment": "environment",
  "lighting.sun": "sun",
  "lighting.fixtures": "fixtures",
  "lighting.shadows": "shadows",
  "lighting.animation": "animation",
};

const LIGHTING_ROUTE_FOR_SCREEN: Record<LightingInspectorScreen, string> = {
  overview: "lighting",
  environment: "lighting.environment",
  sun: "lighting.sun",
  fixtures: "lighting.fixtures",
  shadows: "lighting.shadows",
  animation: "lighting.animation",
};

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

import { LayeredScreenshotBuilder } from "../LayeredScreenshotBuilder";
import { laneSelectionActive } from "../laneSelection";
import { MediaBrowser } from "../MediaBrowser";
import { mediaCardMenu } from "../mediaCardMenu";
import { ObjectPicker } from "../ObjectPicker";
import { OptionCard } from "../OptionCard";
import { TextFieldRow } from "../SceneTextFields";
import { SHADOW_OPTIONS } from "../SceneWizards";
import { backgroundOptions, toggleDrift } from "../stageOptions";
import { DebouncedRange } from "../TextAnimationPicker";
import {
  builtinThemeChoices,
  listThemeChoices,
  recordSuccessfulThemeUse,
  ThemeBrowser,
  type ThemeChoice,
} from "../ThemePicker";
import { TransitionModal } from "../TransitionPicker";
import { describeSpec } from "../textAnimationOptions";
import { isEditableTextTarget, isTypingIn } from "../textEditFocus";
import { useThemeCardMenu } from "../themeCardMenu";
import { useEscapeClose } from "../useEscapeClose";
import { useSceneDocPatch } from "../useSceneDocPatch";
import { CameraPresetRow } from "./CameraPresetRow";
import { CameraRigFields, seedRig } from "./CameraRigFields";
import { CompareSideSelector } from "./CompareSideSelector";
import {
  CompareGripIcon,
  CompareMaskIcon,
  CompareNoneIcon,
  ComparePresetIcon,
  CompareSwatchIcon,
  CompareToggleIcon,
} from "./compareIcons";
import {
  activeCompareSide,
  type CompareSide,
  compareEditTarget,
  compareThemeIdForSide,
  deviceSideRouting,
  hasComparison,
  setThemeForSide,
} from "./compareSideRouting";
import {
  clearCompareTrack,
  mutateCompareBackgroundTarget,
  nearestCompareKey,
  setCompareDividerAngle,
  setCompareDividerValue,
} from "./comparisonTarget";
import { changeFirstClassDeviceModel, DeviceDrillIn, DeviceModelDrillIn } from "./DeviceDrillIn";
import { DofFields } from "./DofFields";
import {
  deviceSelectionFallback,
  deviceSelectionOwnsAction,
  duplicateDevice as duplicateDeviceInDoc,
  removeDevice as removeDeviceFromDoc,
  replaceDeviceMedia,
} from "./deviceEditorModel";
import {
  ActionRow,
  DrillBack,
  DrillGroup,
  DrillHeaderAction,
  GizmoModeIcon,
  middleTruncate,
  NumberField,
  type SegmentedOption,
  SegmentedRow,
  ToggleFieldset,
  ToggleRow,
  useDragScrub,
} from "./rows";
import {
  deferSceneOverviewPickerAction,
  type SceneOverviewContextRequest,
  SceneOverviewEntityRow,
  SceneOverviewGroupHeader,
  SceneOverviewPicker,
  type SceneOverviewPickerItem,
  SceneOverviewSectionHeader,
  SceneOverviewSettingRow,
  shouldCloseSceneOverviewPickerOnBlur,
} from "./SceneOverview";

/** The inspector's Scene tab: collapsible sections over the playhead's dominant scene, every edit riding the same `useSceneDocPatch` funnel the EditBar uses. Section/row structure comes from the pinned `sceneSections` model. The header thumb is read from `listCachedSceneThumbs` only, never a capture, to avoid the clock-borrow playhead-blip class. */

/** The divider colour as the picker shows it, mirroring `compareSpecOf`: an authored `#rrggbb` passes through, a theme token resolves against the scene's theme, and anything else falls back to the accent. */
function resolveCompareColour(colour: string | undefined, theme: Theme | undefined): string {
  if (colour && /^#[0-9a-f]{6}$/i.test(colour)) return colour.toLowerCase();
  const colours = theme?.colors as unknown as Record<string, string> | undefined;
  return (colour && colours?.[colour]) || theme?.colors.accent || "#6f93a8";
}

/** The theme tokens the After tint offers, each shown as its resolved swatch. */
const COMPARE_TINT_TOKENS = ["accent", "text", "muted"] as const;
type CompareTint = "none" | (typeof COMPARE_TINT_TOKENS)[number];

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
    case "content.edit":
      return (
        <svg
          width="17"
          height="17"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 16l.7-3.3L13.2 4.2a1.4 1.4 0 012 0l.6.6a1.4 1.4 0 010 2l-8.5 8.5L4 16z" />
          <path d="M12.2 5.2l2.6 2.6M4.7 12.7l2.6 2.6" />
        </svg>
      );
    case "content.duplicate":
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
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
          <rect x="7.5" y="7.5" width="9" height="9" rx="1.5" />
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
    case "content.delete":
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

/** Inline m:ss.cs length field (typing takes m:ss or plain seconds; committing flips the scene to manual), the EditBar's DurationField, restyled for the panel. */
function DurationRow({
  durationMs,
  mode,
  onCommit,
}: {
  durationMs: number;
  mode: string | null;
  onCommit: (ms: number) => void;
}) {
  const [text, setText] = useState(formatSceneLengthMs(durationMs));
  const inputRef = useRef<HTMLInputElement>(null);
  const { dragging, onPointerDown } = useDragScrub({
    value: durationMs / 1000,
    decimals: 2,
    min: 0.1,
    dragScale: 0.05,
    onText: setText,
    format: formatSceneLength,
    inputRef,
    onCommit: (seconds) => onCommit(Math.round(seconds * 1000)),
  });
  useEffect(() => {
    if (!dragging && !isTypingIn(inputRef.current)) setText(formatSceneLengthMs(durationMs));
  }, [durationMs, dragging]);
  const commit = () => {
    const ms = parseSceneLengthMs(text);
    if (ms === null) {
      setText(formatSceneLengthMs(durationMs));
      return;
    }
    if (ms !== durationMs) onCommit(ms);
    else setText(formatSceneLengthMs(durationMs));
  };
  return (
    <div
      className={`inspector-duration-row${dragging ? " scrubbing" : ""}`}
      title="Scene length, m:ss or seconds (switches to manual)"
    >
      <span className="action-row-icon">
        <SceneRowIcon id="motion.duration" />
      </span>
      <span className="action-row-label">Duration</span>
      {mode && <span className="action-row-value">{mode}</span>}
      <input
        ref={inputRef}
        className="modal-input inspector-num inspector-seconds inspector-num-drag"
        data-space-plays=""
        value={text}
        aria-label="Scene length in minutes and seconds"
        onPointerDown={onPointerDown}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(formatSceneLengthMs(durationMs));
        }}
      />
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
        ariaLabel="Camera mode"
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
      <DrillBack label="Scene" title="Camera" onClick={onBack} />
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
                ariaLabel="Animated track"
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

/** Applies a picked source to one media entry and defaults the scene length to follow a clip (a manual length stays put, the device-picker rule); `meta` seeds the stored aspect so a video keeps its size before frames arrive, and `recording` (when detection ran) sets the window-recording crop to match the new source. */
function applyPickedMediaSource(
  next: SceneDoc,
  entryId: string,
  src: string,
  kind: SceneMediaKind,
  meta: MediaMeta | null,
  recording?: boolean,
) {
  const media = resolveSceneDocMedia(next);
  const entry = media.find((candidate) => candidate.id === entryId);
  if (!entry) return;
  entry.src = src;
  entry.kind = kind;
  if (kind === "video") {
    const video = { ...entry.video };
    if (meta && meta.width > 0 && meta.height > 0) video.aspect = meta.width / meta.height;
    else delete video.aspect;
    entry.video = video;
  } else {
    delete entry.video;
  }
  // A detected macOS capture gets the window chrome that carries the crop, whichever kind it is; a negative verdict only clears an existing flag.
  if (recording === true) {
    entry.window = {
      radius: DEFAULT_SCENE_MEDIA_WINDOW_RADIUS,
      ...entry.window,
      recording: true,
    };
  } else if (recording === false && entry.window) {
    entry.window.recording = false;
  }
  editSceneDocMedia(next, () => media);
  // Any video entry can drive the scene's length, pinned by its own id.
  if (kind === "video" && next.duration?.mode !== "manual") {
    next.duration = { mode: "follow-media", source: "media", sourceMediaId: entryId };
  }
}

/** The probed meta for one project asset, refetched whenever the media library changes; null until it lands, and never a stale answer for a previous src. */
function useAssetMeta(
  slug: string | null | undefined,
  src: string | undefined,
  refreshToken: number,
): MediaMeta | null {
  const [probed, setProbed] = useState<{ src: string; meta: MediaMeta } | null>(null);
  useEffect(() => {
    void refreshToken;
    if (!slug || !src) return;
    let active = true;
    void mediaMeta(slug, src)
      .then((meta) => {
        if (active) setProbed({ src, meta });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [refreshToken, slug, src]);
  return probed && probed.src === src ? probed.meta : null;
}

/** What the shared media source group shows for one source: the still itself or a clip's poster, the pixel aspect its thumbnail is cut to, and a detail line of dimensions (a clip leading with its duration). */
function mediaSourceSummary(
  projectId: string,
  src: string | undefined,
  kind: SceneMediaKind | undefined,
  meta: MediaMeta | null,
): { previewUrl?: string; aspectRatio?: number; detail?: string } {
  if (!src || !kind) return {};
  const sized = meta && meta.width > 0 && meta.height > 0 ? meta : null;
  const dimensions = sized ? `${sized.width}×${sized.height}` : undefined;
  return {
    previewUrl:
      kind === "image"
        ? inspectorAssetUrl(projectId, src)
        : meta?.posterPath
          ? fsUrl(meta.posterPath)
          : undefined,
    aspectRatio: sized ? sized.width / sized.height : undefined,
    detail:
      kind === "video"
        ? [meta ? formatMediaDuration(meta.durationMs) : undefined, dimensions]
            .filter(Boolean)
            .join(" · ") || "Video"
        : (dimensions ?? "Image"),
  };
}

function inspectorAssetUrl(projectId: string, src: string): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(src)) return src;
  try {
    return fsUrl(resolveAssetPath(projectId, src));
  } catch {
    return src;
  }
}

interface LegacyImagePromotionSession {
  decorationId: string;
  baseline: SceneDoc;
  resolvedDecorations: FrameDecorationSpec[];
  mediaId: string | null;
  draftEntry?: SceneDocMediaSpec;
}

type SceneMediaTarget =
  | { kind: "device"; deviceId?: string }
  | { kind: "media"; mediaKind: SceneMediaKind; replaceId?: string; legacyId?: string }
  | { kind: "decoration"; replaceId?: string };

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
    slot?: EditRepointSlot,
    targetId?: string,
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
  const activeFormat = useFormat();
  const activeStageFloorY = useSceneStageFloorY(sceneIndex);
  const sceneFrame = project.sceneFrames[sceneIndex];
  const {
    slug,
    doc,
    scene,
    error,
    setError,
    patchDoc,
    patchDocResult,
    commitFromBaseline,
    commitFromBaselineResult,
    commitRebasedFromBaselineResult,
    commitDuration,
  } = useSceneDocPatch(
    project,
    sceneIndex,
    onDocChanged,
    onTimingChanged,
    activeFormat,
    activeStageFloorY,
  );
  const drillIn = useUiStore((s) => s.inspector.drillIn);
  const drillStack = useUiStore((s) => s.inspector.drillStack);
  // The back bar names the screen it pops to: the parent group (or a detail with children), else the row list.
  const backLabel =
    drillStack.length > 1
      ? (sceneInspectorScreenTitle(drillStack[drillStack.length - 2], {
          deviceCount: doc?.devices?.length,
        }) ?? "Scene")
      : "Scene";
  const openDrill = useUiStore((s) => s.openInspectorDrill);
  const jumpDrill = useUiStore((s) => s.jumpInspectorDrill);
  const replaceDrill = useUiStore((s) => s.replaceInspectorDrill);
  const closeDrill = useUiStore((s) => s.closeInspectorDrill);
  const resetDrill = useUiStore((s) => s.resetInspectorDrill);
  const overviewSelection = useUiStore((s) =>
    s.inspector.overviewSelection?.sceneIndex === sceneIndex ? s.inspector.overviewSelection : null,
  );
  const setOverviewSelection = useUiStore((s) => s.setInspectorOverviewSelection);
  const selectedDecoId = useDecorationEditStore((s) =>
    s.sceneIndex === sceneIndex ? s.selectedId : null,
  );
  const selectDeco = useDecorationEditStore((s) => s.select);
  const selectedImageId = useImageEditStore((s) =>
    s.selected?.sceneIndex === sceneIndex ? s.selected.imageId : null,
  );
  const textSectionOpen = useGizmoSectionOpen("text");
  // The text gizmo's selection, reflected both ways: touching a key's fields shows its handles, and a canvas click scrolls the drill to that key.
  const selectedTextKey = useTextEditStore((s) =>
    s.selected?.sceneIndex === sceneIndex ? s.selected.key : null,
  );
  const registeredText = useTextKeyRegistry((state) => state.keys[sceneIndex]);
  const textRegistrations = useMemo(() => {
    void registeredText;
    return virtualManagedTextRegistrations(sceneIndex);
  }, [registeredText, sceneIndex]);
  const excludedTextKeys = useMemo(() => {
    void registeredText;
    return nonSceneTextKeys(sceneIndex);
  }, [registeredText, sceneIndex]);
  const textColourDefaults = useMemo(() => {
    void registeredText;
    return textKeyColorDefaults(sceneIndex);
  }, [registeredText, sceneIndex]);
  const textVirtualOptionsForDoc = useCallback(
    (candidate: SceneDoc) => ({
      ...managedTextVirtualOptionsForFrame(mergeFrameSpec(project.deckFrame, candidate.frame)),
      ...(excludedTextKeys.length > 0 ? { excludedKeys: excludedTextKeys } : {}),
    }),
    [project.deckFrame, excludedTextKeys],
  );
  const managedTextModel = useMemo(
    () =>
      doc ? deriveManagedTextModel(doc, textRegistrations, textVirtualOptionsForDoc(doc)) : null,
    [doc, textRegistrations, textVirtualOptionsForDoc],
  );
  const managedTextGroups = useMemo(
    () =>
      managedTextModel
        ? resolveManagedTextGroups(
            managedTextModel.items,
            doc?.managedText?.groups,
            managedTextModel.chromeKeys,
          )
        : [],
    [doc?.managedText?.groups, managedTextModel],
  );
  const explicitlySelectedTextGroupKey = overviewSelection
    ? overviewSelection.domain === "text"
      ? (managedTextGroups.find((group) => overviewSelection.rowId === `text:${group.key}`)?.key ??
        null)
      : null
    : (managedTextGroups.find((group) => group.itemKeys.includes(selectedTextKey ?? ""))?.key ??
      null);
  const selectedTextGroupKey =
    selectedManagedTextGroup(managedTextGroups, selectedTextKey, explicitlySelectedTextGroupKey)
      ?.key ?? null;
  const managedTextKeys = useMemo(
    () => managedTextGroups.flatMap((group) => group.itemKeys),
    [managedTextGroups],
  );
  useEffect(() => {
    const store = useTextEditStore.getState();
    if (!textSectionOpen) {
      if (store.selected?.sceneIndex === sceneIndex) store.select(null);
      return;
    }
    const keys = managedTextKeys;
    if (keys.length === 0) {
      if (store.selected?.sceneIndex === sceneIndex) store.select(null);
      return;
    }
    const group = managedTextGroups.find((candidate) => candidate.key === selectedTextGroupKey);
    const preferredKeys = group ? group.itemKeys : keys;
    if (preferredKeys.length === 0) {
      if (store.selected?.sceneIndex === sceneIndex) store.select(null);
      return;
    }
    if (store.selected?.sceneIndex !== sceneIndex || !preferredKeys.includes(store.selected.key)) {
      store.select({ sceneIndex, key: preferredKeys[0] ?? "" });
    }
  }, [managedTextGroups, managedTextKeys, sceneIndex, selectedTextGroupKey, textSectionOpen]);
  const textFieldRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!selectedTextKey) return;
    const el = textFieldRefs.current[selectedTextKey];
    // Skip when the selection came from focusing a field, so typing never scrolls the panel.
    if (!el || el.contains(document.activeElement)) return;
    el.scrollIntoView({ block: "nearest" });
  }, [selectedTextKey]);
  const [imagePickError, setImagePickError] = useState<string | null>(null);
  const [mediaTarget, setMediaTarget] = useState<SceneMediaTarget>({ kind: "device" });
  const openMediaPicker = useCallback(
    (target: SceneMediaTarget) => {
      setImagePickError(null);
      setMediaTarget(target);
      openDrill("media.picker");
    },
    [openDrill],
  );
  const decoMediaRequestId = useDecorationEditStore((s) => s.mediaRequestId);
  const requestDecoMedia = useDecorationEditStore((s) => s.requestMedia);
  useEffect(() => {
    if (!decoMediaRequestId) return;
    openMediaPicker({ kind: "decoration", replaceId: decoMediaRequestId });
    requestDecoMedia(null);
  }, [decoMediaRequestId, openMediaPicker, requestDecoMedia]);
  // Which device the device rows act on; null (or a stale id) falls back to the first device. Store-held (the objectEditStore idiom) so a preview gizmo can attach to the same selection.
  const pickedDeviceId = useDeviceEditStore((s) =>
    s.selected?.sceneIndex === sceneIndex ? s.selected.deviceId : null,
  );
  const pickDevice = useCallback(
    (id: string | null) =>
      useDeviceEditStore.getState().select(id ? { sceneIndex, deviceId: id } : null),
    [sceneIndex],
  );
  // Outlines, click-to-select and the handles all follow the open section, not one deep drill.
  const devicesSectionOpen = useGizmoSectionOpen("devices");
  const mediaSectionOpen = useGizmoSectionOpen("media");
  const objectsSectionOpen = useGizmoSectionOpen("objects");
  const chartSectionOpen = useGizmoSectionOpen("chart");
  // Which staged object the placement drill targets.
  const [pickedObjectId, setPickedObjectId] = useState<string | null>(null);
  const gizmoMode = useObjectEditStore((s) => s.gizmoMode);
  // The one comparison side the Device, Theme, Background and Lighting surfaces share (reset on scene change), plus the After media screen's target device.
  const [compareSide, setCompareSide] = useState<CompareSide>("a");
  const [compareMediaDeviceId, setCompareMediaDeviceId] = useState<string | null>(null);
  // Snapshot at the start of a comparison slider drag: live ticks write history-less, release records one entry.
  const compareDragBaseline = useRef<SceneDoc | null>(null);
  // The scene-local time the running gesture edits at, so a drag stays on the key it started on even under playback.
  const compareGestureMs = useRef<number | null>(null);
  // The grip a switched-off handle wore, so switching it back on restores the style and size instead of the bare default.
  const compareGripMemory = useRef<SceneDocCompareGrip | null>(null);
  const compareSlot = project.slots[sceneIndex];
  const compareKeys = doc?.compare?.track?.keys;
  const compareLocalMs = () =>
    Math.min(
      compareSlot?.durationMs ?? 0,
      Math.max(0, useClockStore.getState().currentMs - (compareSlot?.startMs ?? 0)),
    );
  // Re-render only when the key under the playhead changes, never per tick (the camera-section idiom); the writes snapshot the live clock instead.
  const compareTargetKeyId = useClockStore((s) => {
    if (!compareKeys?.length || !compareSlot) return null;
    const local = Math.min(compareSlot.durationMs, Math.max(0, s.currentMs - compareSlot.startMs));
    return nearestCompareKey(compareKeys, local)?.id ?? null;
  });
  // Which document the background and lighting drills edit, read off the shared side: the scene itself, or the comparison's after side. A scene with no comparison has no After to pick, so this can never point at one.
  const compareSideActive = activeCompareSide(doc, compareSide);
  const editingAfter = compareSideActive === "b";
  const bgTarget = compareEditTarget(doc, compareSide);
  const lightingTarget = bgTarget;
  const [lightingAnimationScope, setLightingAnimationScope] = useState<LightingAnimationScope>({
    kind: "rig",
  });
  const [thumbs, setThumbs] = useState<Record<string, string> | null>(null);
  const [contentPickerOpen, setContentPickerOpen] = useState(false);
  const [contentActionBusy, setContentActionBusy] = useState(false);
  const [contentMenu, setContentMenu] = useState<(ContextMenuState & { key: string }) | null>(null);
  const [pendingDeviceInspectorOpen, setPendingDeviceInspectorOpen] = useState<{
    projectId: string;
    sceneIndex: number;
    sceneFile: string | null;
    deviceId: string;
    navigationSequence: number;
  } | null>(null);
  const contentPickerAnchorRef = useRef<HTMLDivElement>(null);
  const contentPickerButtonRef = useRef<HTMLButtonElement>(null);
  const contentPickerActionFrameRef = useRef<number | null>(null);
  const contentPickerPointerDownRef = useRef(false);
  const contentAddActivatorRef = useRef<HTMLElement | null>(null);
  const imageSourceButtonRef = useRef<HTMLButtonElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const overviewRootRef = useRef<HTMLDivElement>(null);
  // Assigned during the overview render, which the drill returns skip; the mount-once Delete handler can only reach the plan path through a ref.
  const deleteOverviewSelectionRef = useRef<(() => void) | null>(null);
  const sceneIndexRef = useRef(sceneIndex);
  const projectIdRef = useRef(project.id);
  const sceneFileRef = useRef(project.sceneFiles[sceneIndex] ?? null);
  const contentPickerSceneIdentity = `${project.id}\u0000${sceneIndex}\u0000${project.sceneFiles[sceneIndex] ?? ""}`;
  const docRef = useRef(doc);
  const resolvedDecorationsRef = useRef(project.sceneFrames[sceneIndex]?.decorations);
  const patchDocResultRef = useRef(patchDocResult);
  const textTakeoverRef = useRef<symbol | null>(null);
  const textIconWriteRef = useRef<symbol | null>(null);
  const [textIconWriteBusy, setTextIconWriteBusy] = useState(false);
  const [textIconRecentState, setTextIconRecentState] = useState(() => ({
    projectId: project.id,
    values: loadTextIconRecents(project.id),
  }));
  const textIconRecents =
    textIconRecentState.projectId === project.id
      ? textIconRecentState.values
      : loadTextIconRecents(project.id);
  const [textTakeoverBusy, setTextTakeoverBusy] = useState(false);
  const comparisonLightingBaselineARef = useRef<SceneDoc["lighting"] | null>(null);
  useEffect(() => {
    setLightingAnimationScope({ kind: "rig" });
    comparisonLightingBaselineARef.current = null;
    useLightingEditStore.getState().setTarget(lightingTarget);
  }, [lightingTarget]);
  const legacyImagePromotionRef = useRef<LegacyImagePromotionSession | null>(null);
  const legacyImageOperationRef = useRef<symbol | null>(null);
  const [legacyImageNotice, setLegacyImageNotice] = useState<string | null>(null);
  const [legacyImageBusy, setLegacyImageBusy] = useState(false);
  const contentActionPendingRef = useRef<{
    token: symbol;
    projectId: string;
    sceneIndex: number;
    sceneFile: string | null;
  } | null>(null);
  sceneIndexRef.current = sceneIndex;
  projectIdRef.current = project.id;
  sceneFileRef.current = project.sceneFiles[sceneIndex] ?? null;
  docRef.current = doc;
  resolvedDecorationsRef.current = project.sceneFrames[sceneIndex]?.decorations;
  patchDocResultRef.current = patchDocResult;

  useEffect(() => {
    void contentPickerSceneIdentity;
    contentActionPendingRef.current = null;
    setContentActionBusy(false);
    return () => {
      if (contentPickerActionFrameRef.current !== null) {
        window.cancelAnimationFrame(contentPickerActionFrameRef.current);
        contentPickerActionFrameRef.current = null;
      }
      contentPickerPointerDownRef.current = false;
      contentAddActivatorRef.current = null;
    };
  }, [contentPickerSceneIdentity]);

  useEffect(() => {
    if (!pendingDeviceInspectorOpen) return;
    const currentUi = useUiStore.getState();
    const identityMatches =
      project.id === pendingDeviceInspectorOpen.projectId &&
      sceneIndex === pendingDeviceInspectorOpen.sceneIndex &&
      (project.sceneFiles[sceneIndex] ?? null) === pendingDeviceInspectorOpen.sceneFile;
    const navigationMatches =
      currentUi.inspector.tab === "scene" &&
      currentUi.inspector.drillIn === null &&
      currentUi.inspectorNavigation.sequence === pendingDeviceInspectorOpen.navigationSequence;
    if (!identityMatches || !navigationMatches) {
      setPendingDeviceInspectorOpen(null);
      return;
    }
    if (!doc?.devices?.some((candidate) => candidate.id === pendingDeviceInspectorOpen.deviceId)) {
      return;
    }
    if (
      !deviceSelectionOwnsAction(
        useDeviceEditStore.getState().selected,
        pendingDeviceInspectorOpen.sceneIndex,
        pendingDeviceInspectorOpen.deviceId,
      )
    ) {
      setPendingDeviceInspectorOpen(null);
      return;
    }
    setPendingDeviceInspectorOpen(null);
    openDrill("device");
  }, [doc, openDrill, pendingDeviceInspectorOpen, project.id, project.sceneFiles, sceneIndex]);

  const openObjectPicker = useCallback(() => {
    openDrill("objects.picker");
  }, [openDrill]);
  const closeObjectPicker = useCallback(() => {
    closeDrill();
  }, [closeDrill]);
  useEffect(() => {
    setTextIconRecentState({ projectId: project.id, values: loadTextIconRecents(project.id) });
    return () => {
      textTakeoverRef.current = null;
    };
  }, [project.id]);
  const confirmManagedTextTakeover = useCallback(
    async ({ action, itemCount }: ManagedTextTakeoverRequest): Promise<boolean> => {
      if (docRef.current?.managedText !== undefined) return true;
      if (itemCount === 0) return true;
      if (textTakeoverRef.current) return false;
      const token = Symbol("managed-text-takeover");
      const expectedProjectId = project.id;
      const expectedSceneIndex = sceneIndex;
      const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
      textTakeoverRef.current = token;
      setTextTakeoverBusy(true);
      try {
        const accepted = await ask(
          `This scene's ${itemCount === 1 ? "text line is" : `${itemCount} text lines are`} controlled by its scene code. ${action.type === "add-item" || action.type === "add-group" ? "Adding text" : action.type === "take-over" ? "Editing this icon" : "This structural edit"} lets the inspector take over the whole text block. Undo restores the exact coded version.`,
          {
            title: "Take over scene text?",
            kind: "warning",
            okLabel: "Take over",
            cancelLabel: "Leave it",
          },
        );
        return (
          accepted &&
          textTakeoverRef.current === token &&
          projectIdRef.current === expectedProjectId &&
          sceneIndexRef.current === expectedSceneIndex &&
          sceneFileRef.current === expectedSceneFile
        );
      } finally {
        if (textTakeoverRef.current === token) textTakeoverRef.current = null;
        setTextTakeoverBusy(false);
      }
    },
    [project.id, project.sceneFiles, sceneIndex],
  );
  const writeManagedText = useCallback<ManagedTextWrite>(
    async (request) => {
      const apply = (next: SceneDoc) => {
        const replacement = request.applyToCurrent(next);
        if (replacement === next && !request.historyFromBaseline) return false;
        replaceSceneDoc(next, replacement);
      };
      if (request.history === false) {
        return patchDocResult(apply, { history: false });
      }
      if (request.historyFromBaseline) {
        return commitRebasedFromBaselineResult(
          request.baseline,
          apply,
          request.history ?? "scene edit",
        );
      }
      return patchDocResult(apply, { history: request.history });
    },
    [commitRebasedFromBaselineResult, patchDocResult],
  );
  useEffect(() => {
    if (drillIn === LEGACY_MEDIA_DRILL_ROUTE) return;
    legacyImagePromotionRef.current = null;
    setLegacyImageNotice(null);
  }, [drillIn]);
  const beginLegacyImageOperation = () => {
    if (legacyImageOperationRef.current) return null;
    const token = Symbol("legacy-image-operation");
    legacyImageOperationRef.current = token;
    setLegacyImageBusy(true);
    return token;
  };
  const endLegacyImageOperation = (token: symbol) => {
    if (legacyImageOperationRef.current !== token) return;
    legacyImageOperationRef.current = null;
    setLegacyImageBusy(false);
  };
  const restoreImageSourceFocus = () => {
    window.requestAnimationFrame(() =>
      imageSourceButtonRef.current?.focus({ preventScroll: true }),
    );
  };
  const closeContentPicker = useCallback((restoreFocus = false) => {
    setContentPickerOpen(false);
    if (restoreFocus) contentPickerButtonRef.current?.focus({ preventScroll: true });
  }, []);
  const captureContentAddActivator = () => {
    contentAddActivatorRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const focusContentAddActivator = () => {
    const activator = contentAddActivatorRef.current;
    contentAddActivatorRef.current = null;
    const target = activator?.isConnected ? activator : contentPickerButtonRef.current;
    target?.focus({ preventScroll: true });
  };
  const restoreContentAddActivatorFocus = () => {
    window.requestAnimationFrame(focusContentAddActivator);
  };
  // The bottom Delete-scene row's two-step confirm (the house self-disarming pattern).
  const [confirmDeleteScene, setConfirmDeleteScene] = useState(false);
  const [confirmApplyAll, setConfirmApplyAll] = useState(false);
  const [mediaRefresh, setMediaRefresh] = useState(0);
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
  /** The mounted stage's resolved backdrop type; null when the scene mounts no SceneStage. */
  const stagedBackdrop = useSceneStageBackdrop(sceneIndex);
  /** The same per comparison host, so the Background drill reads the side it edits instead of Before's stage. */
  const stagedBackdropBefore = useSceneHostStageBackdrop(sceneIndex, undefined);
  const stagedBackdropAfter = useSceneHostStageBackdrop(sceneIndex, "b");
  const bgStagedBackdrop = bgTarget === "compareB" ? stagedBackdropAfter : stagedBackdropBefore;
  const [themeChoices, setThemeChoices] = useState<ThemeChoice[]>(builtinThemeChoices);
  const [themeDraft, setThemeDraft] = useState<string>("");

  const devices = doc?.devices ?? [];
  const device = devices.find((d) => d.id === pickedDeviceId) ?? devices[0];
  const deviceId = device?.id;
  const deviceIds = devices.map((candidate) => candidate.id);
  const deviceIdsKey = deviceIds.join("\u0000");
  // Everything the Device surface shows for the selected device follows the shared side, media meta included.
  const deviceRouting = deviceSideRouting(doc, deviceId ?? "", compareSide);
  const deviceMediaSrc = deviceRouting.media?.src;
  const assetMetaToken = mediaRefresh + mediaRefreshKey;
  const deviceMediaMeta = useAssetMeta(slug, deviceMediaSrc, assetMetaToken);
  const objects = doc?.objects ?? [];
  const stagedObject = objects.find((o) => o.id === pickedObjectId) ?? objects[0];
  const mediaEntries = useMemo(() => resolveSceneDocMedia(doc), [doc]);
  const mediaIds = useMemo(() => mediaEntries.map((entry) => entry.id), [mediaEntries]);
  const selectedMediaEntry =
    selectedImageId === null
      ? mediaEntries[0]
      : mediaEntries.find((entry) => entry.id === selectedImageId);
  const selectedMediaMeta = useAssetMeta(slug, selectedMediaEntry?.src, assetMetaToken);
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
  useEffect(() => {
    return useImageEditStore.subscribe((state) => {
      const commit = state.pendingCommit;
      if (!commit) return;
      useImageEditStore.getState().clearCommit();
      const clearFailedPreview = () => {
        const store = useImageEditStore.getState();
        if (store.previewPlacement && imageEditCommitMatches(store.previewPlacement, commit)) {
          store.clearPreview();
        }
      };
      if (commit.sceneIndex !== sceneIndex) {
        clearFailedPreview();
        return;
      }
      void patchDocResultRef
        .current(
          (next) => {
            const media = resolveSceneDocMedia(next);
            const entry = media.find((candidate) => candidate.id === commit.imageId);
            if (!entry) return false;
            if (commit.kind === "stage") entry.stage = commit.placement;
            else entry.overlay = commit.placement;
            editSceneDocMedia(next, () => media);
          },
          { history: commit.kind === "stage" ? "transform media" : "place media" },
        )
        .then((succeeded) => {
          if (!succeeded) clearFailedPreview();
        });
    });
  }, [sceneIndex]);
  useEffect(() => {
    const store = useImageEditStore.getState();
    const firstMediaId = mediaIds[0];
    if (!mediaSectionOpen) {
      if (store.selected?.sceneIndex === sceneIndex) store.select(null);
      return;
    }
    if (firstMediaId === undefined) return;
    const ensure = () => {
      const current = useImageEditStore.getState();
      const selected = current.selected;
      if (selected?.sceneIndex === sceneIndex) return;
      current.select({ sceneIndex, imageId: firstMediaId });
    };
    ensure();
    return useImageEditStore.subscribe(ensure);
  }, [mediaIds, mediaSectionOpen, sceneIndex]);
  useEffect(() => {
    const inspector = useUiStore.getState().inspector;
    const currentSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const decorations =
      doc?.frame?.decorations ?? project.sceneFrames[sceneIndex]?.decorations ?? [];
    const imageDecorationIds = decorations
      .filter((decoration) => decoration.src !== undefined)
      .map((decoration) => decoration.id);
    const activePromotionId = legacyImagePromotionRef.current?.decorationId;
    if (activePromotionId && !imageDecorationIds.includes(activePromotionId)) {
      imageDecorationIds.push(activePromotionId);
    }
    const reconciliation = reconcileMediaEditor({
      drillIn: inspector.drillIn,
      overviewRowId: inspector.overviewSelection?.rowId ?? null,
      selectedMediaId: selectedImageId,
      selectedDecorationId: selectedDecoId,
      mediaIds,
      imageDecorationIds,
      origins: useImageReconciliationStore.getState().originsFor(project.id, currentSceneFile),
    });
    if (reconciliation.kind === "switch-to-legacy") {
      useImageEditStore.getState().select(null);
      const decorationStore = useDecorationEditStore.getState();
      decorationStore.setScene(sceneIndex);
      decorationStore.select(reconciliation.decorationId);
      setOverviewSelection({
        sceneIndex,
        rowId: reconciliation.overviewRowId,
        domain: "decorations",
      });
      if (reconciliation.replaceDrill) replaceDrill(LEGACY_MEDIA_DRILL_ROUTE);
      return;
    }
    if (reconciliation.kind === "switch-to-media") {
      useDecorationEditStore.getState().select(null);
      useImageEditStore.getState().select({ sceneIndex, imageId: reconciliation.mediaId });
      setOverviewSelection({
        sceneIndex,
        rowId: reconciliation.overviewRowId,
        domain: "media",
      });
      if (reconciliation.replaceDrill) replaceDrill(MEDIA_DRILL_ROUTE);
      return;
    }
    if (reconciliation.kind === "select-media") {
      useDecorationEditStore.getState().select(null);
      useImageEditStore.getState().select({ sceneIndex, imageId: reconciliation.mediaId });
      setOverviewSelection({
        sceneIndex,
        rowId: reconciliation.overviewRowId,
        domain: "media",
      });
      return;
    }
    if (reconciliation.kind === "close-stale-editor") {
      if (reconciliation.editor === "media") useImageEditStore.getState().select(null);
      else useDecorationEditStore.getState().select(null);
      setOverviewSelection(null);
      closeDrill();
    }
  }, [
    closeDrill,
    doc?.frame?.decorations,
    mediaIds,
    project.id,
    project.sceneFiles,
    replaceDrill,
    project.sceneFrames,
    sceneIndex,
    selectedDecoId,
    selectedImageId,
    setOverviewSelection,
  ]);
  useEffect(() => () => useImageEditStore.getState().select(null), []);
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
  useEffect(() => {
    if (drillIn !== null || !overviewSelection) return;
    const rowId =
      overviewSelection.domain === "devices" && pickedDeviceId
        ? `device:${pickedDeviceId}`
        : overviewSelection.domain === "objects" && selectedObjectId
          ? `object:${selectedObjectId}`
          : overviewSelection.domain === "media" && selectedImageId
            ? mediaRowId(selectedImageId)
            : overviewSelection.domain === "text" && selectedTextGroupKey
              ? `text:${selectedTextGroupKey}`
              : overviewSelection.domain === "decorations" && selectedDecoId
                ? legacyMediaRowId(selectedDecoId)
                : null;
    if (rowId && rowId !== overviewSelection.rowId) {
      setOverviewSelection({ sceneIndex, rowId, domain: overviewSelection.domain });
    }
  }, [
    drillIn,
    overviewSelection,
    pickedDeviceId,
    sceneIndex,
    selectedDecoId,
    selectedImageId,
    selectedObjectId,
    selectedTextGroupKey,
    setOverviewSelection,
  ]);
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
      if (commit.sceneIndex !== sceneIndex) {
        useDeviceEditStore.getState().acknowledgeCommit(commit, false);
        return;
      }
      void patchDocResultRef
        .current(
          (next) => {
            const target = next.devices?.find((device) => device.id === commit.deviceId);
            if (!target || (commit.kind === "delta" && !next.deviceLayout)) return false;
            if (commit.kind === "delta") {
              mutateDelta(next, commit.deviceId, (delta) => Object.assign(delta, commit.delta));
            } else {
              mutatePlacement(next, commit.deviceId, (placement) =>
                Object.assign(placement, commit.placement),
              );
            }
            if (commit.clearGround) {
              target.placement = { ...target.placement };
              delete target.placement.ground;
            }
            return true;
          },
          { history: "transform device" },
        )
        .then((succeeded) => useDeviceEditStore.getState().acknowledgeCommit(commit, succeeded));
    });
  }, [sceneIndex]);
  // A store subscription restores an empty selection after export without rejecting a just-minted id before its document render lands.
  useEffect(() => {
    if (!devicesSectionOpen || deviceId === undefined) return;
    const renderedDeviceIds = deviceIdsKey.split("\u0000");
    const ensure = () => {
      if (isExporting()) return;
      const store = useDeviceEditStore.getState();
      const fallback = deviceSelectionFallback(
        store.selected,
        sceneIndex,
        renderedDeviceIds,
        false,
      );
      if (fallback) store.select({ sceneIndex, deviceId: fallback });
    };
    ensure();
    const unsubscribeDevice = useDeviceEditStore.subscribe(ensure);
    const unsubscribeExport = subscribeExporting(ensure);
    return () => {
      unsubscribeDevice();
      unsubscribeExport();
    };
  }, [deviceIdsKey, devicesSectionOpen, deviceId, sceneIndex]);
  // Stale-id repair runs only after React has rendered the authoritative device list, so Add and Duplicate can select their pending minted ids safely.
  useEffect(() => {
    if (!devicesSectionOpen || deviceId === undefined || isExporting()) return;
    const store = useDeviceEditStore.getState();
    const fallback = deviceSelectionFallback(
      store.selected,
      sceneIndex,
      deviceIdsKey.split("\u0000"),
      true,
    );
    if (fallback) store.select({ sceneIndex, deviceId: fallback });
  }, [deviceIdsKey, devicesSectionOpen, deviceId, sceneIndex]);
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
    textTakeoverRef.current = null;
    setTextTakeoverBusy(false);
    setImagePickError(null);
    legacyImagePromotionRef.current = null;
    legacyImageOperationRef.current = null;
    setLegacyImageBusy(false);
    setLegacyImageNotice(null);
    pickDevice(null);
    useImageEditStore.getState().select(null);
    setCompareSide("a");
    setCompareMediaDeviceId(null);
    compareGestureMs.current = null;
    compareDragBaseline.current = null;
    compareGripMemory.current = null;
    setOverviewSelection(null);
    setContentPickerOpen(false);
    setContentMenu(null);
    setLightingAnimationScope({ kind: "rig" });
    setThemeDraft(doc?.themeId ?? "");
    const kept = drillStackForScene(drillStack, {
      hasDoc: !!doc,
      textKeys: managedTextModel?.items.map((item) => item.key) ?? [],
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
  }, [sceneIndex, resetDrill, jumpDrill, setOverviewSelection]);

  useLayoutEffect(() => {
    void sceneIndex;
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
  }, [sceneIndex]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: every document replacement invalidates any armed menu action
  useEffect(() => setContentMenu(null), [doc]);

  // Delete removes the selected content: inside a content drill through that drill's own trash, at the overview through the row's delete plan. The lanes bind Delete too, so a live keyframe selection wins.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTextTarget(e.target as HTMLElement | null)) return;
      if (isExporting() || modalOwnsKeyboard() || laneSelectionActive()) return;
      const route = contentDeleteRoute(useUiStore.getState().inspector);
      if (route === "drill") {
        if (clickInspectorRemoveAction()) e.preventDefault();
        return;
      }
      if (route !== "overview") return;
      e.preventDefault();
      deleteOverviewSelectionRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  useEscapeClose(() => closeContentPicker(true), drillIn === null && contentPickerOpen);
  useEffect(() => {
    if (drillIn !== null || !contentPickerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      contentPickerAnchorRef.current
        ?.querySelector<HTMLButtonElement>(
          '.inspector-scene-overview-picker-item:not([aria-disabled="true"])',
        )
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contentPickerOpen, drillIn]);
  useEffect(() => {
    if (drillIn !== null || !contentPickerOpen) return;
    const clearInternalPointer = () => {
      contentPickerPointerDownRef.current = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && contentPickerAnchorRef.current?.contains(target)) return;
      clearInternalPointer();
      closeContentPicker();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", clearInternalPointer, true);
    window.addEventListener("pointercancel", clearInternalPointer, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", clearInternalPointer, true);
      window.removeEventListener("pointercancel", clearInternalPointer, true);
    };
  }, [closeContentPicker, contentPickerOpen, drillIn]);

  // Re-list theme choices when the drill opens or ThemeMode closes over it: Manage keeps the drill open, so edits must show in place.
  useEffect(() => {
    void themesRefreshKey; // re-list on ThemeMode close
    if (drillIn === "style.theme") void listThemeChoices().then(setThemeChoices);
  }, [drillIn, themesRefreshKey]);

  /** Apply a theme to the side the Theme drill is showing: Before writes the scene's own theme, After the comparison's `compare.b.themeId`. */
  const applySceneThemeChoice = (themeId: string) => {
    if (!editingAfter) setThemeDraft(themeId);
    void recordSuccessfulThemeUse(themeId, () =>
      patchDoc((next) => setThemeForSide(next, compareSide, themeId)).then(onTimingChanged),
    );
  };

  // The theme-card right-click menu; Apply here means the selected side's override.
  const themeMenu = useThemeCardMenu({
    onApply: applySceneThemeChoice,
    onManage: onOpenTheme,
    onEditInClaude: onEditThemeInClaude,
    onThemeEdited,
    onChanged: () => void listThemeChoices().then(setThemeChoices),
  });

  if (!slug) return null;

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

  const addDevice = () => {
    if (contentActionPendingRef.current) return;
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedUi = useUiStore.getState();
    const expectedDrillStack = [...expectedUi.inspector.drillStack];
    const expectedNavigationSequence = expectedUi.inspectorNavigation.sequence;
    const actionToken = Symbol("add-device");
    contentActionPendingRef.current = {
      token: actionToken,
      projectId: expectedProjectId,
      sceneIndex: expectedSceneIndex,
      sceneFile: expectedSceneFile,
    };
    setContentActionBusy(true);
    let createdId: string | null = null;
    void patchDocResult(
      (next) => {
        const currentDevices = next.devices ?? [];
        const id = nextNumberedContentId(
          "d",
          currentDevices.map((candidate) => candidate.id),
        );
        const k = currentDevices.length;
        const x = k === 0 ? 0 : DEVICE_STEP_X * Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1);
        createdId = id;
        next.devices = [
          ...currentDevices,
          {
            id,
            model: DEFAULT_DEVICE_ID,
            colour: DEVICE_CATALOG[DEFAULT_DEVICE_ID].defaultColour,
            placement: { position: [x, -0.3, 0], rotationDeg: [0, 0, 0], scale: 1 },
            motion: { preset: "none" },
            shadow: "soft",
          },
        ];
      },
      { history: "add device" },
    )
      .then((succeeded) => {
        const id = createdId;
        const inspector = useUiStore.getState().inspector;
        if (
          !succeeded ||
          !id ||
          projectIdRef.current !== expectedProjectId ||
          sceneIndexRef.current !== expectedSceneIndex ||
          sceneFileRef.current !== expectedSceneFile ||
          inspector.tab !== "scene" ||
          useUiStore.getState().inspectorNavigation.sequence !== expectedNavigationSequence ||
          inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
        ) {
          contentAddActivatorRef.current = null;
          return;
        }
        pickDevice(id);
        setOverviewSelection({
          sceneIndex: expectedSceneIndex,
          rowId: `device:${id}`,
          domain: "devices",
        });
        focusContentAddActivator();
        if (expectedDrillStack.length === 0) {
          setPendingDeviceInspectorOpen({
            projectId: expectedProjectId,
            sceneIndex: expectedSceneIndex,
            sceneFile: expectedSceneFile,
            deviceId: id,
            navigationSequence: expectedNavigationSequence,
          });
        }
      })
      .finally(() => {
        if (contentActionPendingRef.current?.token === actionToken) {
          contentActionPendingRef.current = null;
          setContentActionBusy(false);
        }
      });
  };
  const duplicateSceneDevice = (sourceId: string) => {
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedDrillStack = [...useUiStore.getState().inspector.drillStack];
    let createdId: string | null = null;
    void patchDocResult(
      (next) => {
        createdId = duplicateDeviceInDoc(next, sourceId);
        return createdId !== null;
      },
      { history: "duplicate device" },
    ).then((succeeded) => {
      const id = createdId;
      const inspector = useUiStore.getState().inspector;
      if (
        !succeeded ||
        !id ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        !deviceSelectionOwnsAction(
          useDeviceEditStore.getState().selected,
          expectedSceneIndex,
          sourceId,
        ) ||
        inspector.tab !== "scene" ||
        inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
      ) {
        return;
      }
      pickDevice(id);
    });
  };
  const duplicateDevice = () => {
    if (deviceId) duplicateSceneDevice(deviceId);
  };
  const removeSceneDevice = (sourceId: string) => {
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    let nextDeviceId: string | null = null;
    void patchDocResult(
      (next) => {
        if (!next.devices?.some((candidate) => candidate.id === sourceId)) return false;
        nextDeviceId = removeDeviceFromDoc(next, sourceId);
        return true;
      },
      { history: "remove device" },
    ).then((succeeded) => {
      if (
        !succeeded ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        !deviceSelectionOwnsAction(
          useDeviceEditStore.getState().selected,
          expectedSceneIndex,
          sourceId,
        )
      ) {
        return;
      }
      if (nextDeviceId) pickDevice(nextDeviceId);
      else pickDevice(null);
      const inspector = useUiStore.getState().inspector;
      if (nextDeviceId === null && inspector.tab === "scene" && inspector.drillIn === "device") {
        closeDrill();
      }
    });
  };
  const addObjectFromPicker = (objectId: string) => {
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedUi = useUiStore.getState();
    const expectedDrillStack = [...expectedUi.inspector.drillStack];
    const expectedNavigationSequence = expectedUi.inspectorNavigation.sequence;
    const selectedDeviceId = deviceId;
    let createdId: string | null = null;
    return patchDocResult(
      (next) => {
        const currentObjects = next.objects ?? [];
        const id = nextNumberedContentId(
          "o",
          currentObjects.map((candidate) => candidate.id),
        );
        const currentDevice =
          next.devices?.find((candidate) => candidate.id === selectedDeviceId) ?? next.devices?.[0];
        const placement = currentDevice
          ? besideDevicePlacement(currentDevice, "right")
          : floorCentrePlacement();
        createdId = id;
        next.objects = [...currentObjects, { id, objectId, placement }];
      },
      { history: "add object" },
    ).then((succeeded) => {
      const id = createdId;
      const inspector = useUiStore.getState().inspector;
      if (
        !succeeded ||
        !id ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        inspector.tab !== "scene" ||
        useUiStore.getState().inspectorNavigation.sequence !== expectedNavigationSequence ||
        inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
      ) {
        return;
      }
      setPickedObjectId(id);
      setOverviewSelection({
        sceneIndex: expectedSceneIndex,
        rowId: `object:${id}`,
        domain: "objects",
      });
      useObjectEditStore.getState().select({ sceneIndex: expectedSceneIndex, objectId: id });
      replaceDrill("objects.placement");
    });
  };
  /** Mutate the drill's staged object in place; a no-op when the scene has none. */
  const patchObject = (fn: (o: NonNullable<SceneDoc["objects"]>[number]) => void) =>
    void patchDoc((next) => {
      const o = next.objects?.find((x) => x.id === stagedObjectId);
      if (o) fn(o);
    });

  const duplicateSceneObject = (sourceId: string) => {
    const currentDoc = docRef.current;
    if (!currentDoc) return;
    const row: SceneOverviewRowModel = {
      id: `object:${sourceId}`,
      type: "object",
      label: "Object",
      selectionTarget: { kind: "object", id: sourceId },
      openRoute: "objects.placement",
      readOnly: false,
    };
    const plan = planContentDuplicate(row, { doc: currentDoc });
    if (!plan) return;
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedDrillStack = [...useUiStore.getState().inspector.drillStack];
    void patchDocResult(plan.apply, { history: plan.history }).then((succeeded) => {
      const selection = plan.nextSelection;
      const inspector = useUiStore.getState().inspector;
      const selected = useObjectEditStore.getState().selected;
      if (
        !succeeded ||
        selection?.kind !== "object" ||
        !plan.nextRowId ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        selected?.sceneIndex !== expectedSceneIndex ||
        selected.objectId !== sourceId ||
        inspector.tab !== "scene" ||
        inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
      ) {
        return;
      }
      setPickedObjectId(selection.id);
      useObjectEditStore
        .getState()
        .select({ sceneIndex: expectedSceneIndex, objectId: selection.id });
      setOverviewSelection({
        sceneIndex: expectedSceneIndex,
        rowId: plan.nextRowId,
        domain: "objects",
      });
    });
  };

  const removeSceneObject = (sourceId: string) => {
    const currentDoc = docRef.current;
    if (!currentDoc) return;
    const row: SceneOverviewRowModel = {
      id: `object:${sourceId}`,
      type: "object",
      label: "Object",
      selectionTarget: { kind: "object", id: sourceId },
      openRoute: "objects.placement",
      readOnly: false,
    };
    const plan = planContentDelete(row, { doc: currentDoc });
    if (!plan) return;
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    void patchDocResult(plan.apply, { history: plan.history }).then((succeeded) => {
      const selected = useObjectEditStore.getState().selected;
      if (
        !succeeded ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        selected?.sceneIndex !== expectedSceneIndex ||
        selected.objectId !== sourceId
      ) {
        return;
      }
      setPickedObjectId(null);
      useObjectEditStore.getState().select(null);
      setOverviewSelection(null);
      const inspector = useUiStore.getState().inspector;
      if (inspector.tab === "scene" && inspector.drillIn === "objects.placement") closeDrill();
    });
  };

  const removeScreenshotStack = () => {
    const currentDoc = docRef.current;
    if (!currentDoc) return;
    const row: SceneOverviewRowModel = {
      id: "screenshotStack",
      type: "screenshotStack",
      label: "Screenshot stack",
      selectionTarget: { kind: "screenshotStack" },
      openRoute: "layeredScreenshot.edit",
      readOnly: false,
    };
    const plan = planContentDelete(row, { doc: currentDoc });
    if (!plan) return;
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    void patchDocResult(plan.apply, { history: plan.history }).then((succeeded) => {
      const inspector = useUiStore.getState().inspector;
      if (
        !succeeded ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        inspector.tab !== "scene" ||
        inspector.drillIn !== "layeredScreenshot.edit"
      ) {
        return;
      }
      useLayeredScreenshotEditStore.getState().reset();
      setOverviewSelection(null);
      closeDrill();
    });
  };

  const addCompare = () => {
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedUi = useUiStore.getState();
    const expectedDrillStack = [...expectedUi.inspector.drillStack];
    const expectedNavigationSequence = expectedUi.inspectorNavigation.sequence;
    void patchDocResult(
      (next) => {
        if (next.compare) return false;
        next.compare = {
          b: {},
          mask: { type: "linear", angleDeg: 90 },
          value: 0.5,
          chrome: { line: { width: 4, colour: "accent" }, chips: true },
        };
      },
      { history: "add comparison" },
    ).then((succeeded) => {
      const state = useUiStore.getState();
      if (
        !succeeded ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        state.inspector.tab !== "scene" ||
        state.inspectorNavigation.sequence !== expectedNavigationSequence ||
        state.inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
      ) {
        contentAddActivatorRef.current = null;
        return;
      }
      setOverviewSelection({ sceneIndex: expectedSceneIndex, rowId: "comparison", domain: null });
      focusContentAddActivator();
      openDrill("compare.edit");
    });
  };
  const addChart = () => {
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedUi = useUiStore.getState();
    const expectedDrillStack = [...expectedUi.inspector.drillStack];
    const expectedNavigationSequence = expectedUi.inspectorNavigation.sequence;
    void patchDocResult(
      (next) => {
        if (next.chart) return false;
        next.chart = newChartBlock();
      },
      { history: "add chart" },
    ).then((succeeded) => {
      const state = useUiStore.getState();
      if (
        !succeeded ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        state.inspector.tab !== "scene" ||
        state.inspectorNavigation.sequence !== expectedNavigationSequence ||
        state.inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
      ) {
        contentAddActivatorRef.current = null;
        return;
      }
      setOverviewSelection({ sceneIndex: expectedSceneIndex, rowId: "chart", domain: "chart" });
      useChartEditStore.getState().select({ sceneIndex: expectedSceneIndex });
      focusContentAddActivator();
      jumpDrill(["chart.edit"]);
    });
  };
  const addChartSeries = () => {
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedUi = useUiStore.getState();
    const expectedDrillStack = [...expectedUi.inspector.drillStack];
    const expectedNavigationSequence = expectedUi.inspectorNavigation.sequence;
    let createdId: string | null = null;
    void patchDocResult(
      (next) => {
        if (!next.chart) return false;
        const rows = next.chart.data.series;
        const used = new Set(rows.map((series) => series.id));
        let n = rows.length + 1;
        while (used.has(`s${n}`)) n += 1;
        createdId = `s${n}`;
        next.chart.data = {
          ...next.chart.data,
          series: [
            ...rows,
            {
              id: createdId,
              name: `Series ${rows.length + 1}`,
              values: next.chart.data.categories.map(() => 0),
            },
          ],
        };
      },
      { history: "chart series" },
    ).then((succeeded) => {
      const id = createdId;
      const currentUi = useUiStore.getState();
      if (
        !succeeded ||
        !id ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        currentUi.inspectorNavigation.sequence !== expectedNavigationSequence ||
        currentUi.inspector.tab !== "scene" ||
        currentUi.inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
      ) {
        return;
      }
      openDrill(chartSeriesInspectorRoute(id));
    });
  };
  const removeChartSeries = (seriesId: string) => {
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedUi = useUiStore.getState();
    const expectedDrillStack = [...expectedUi.inspector.drillStack];
    const expectedNavigationSequence = expectedUi.inspectorNavigation.sequence;
    void patchDocResult(
      (next) => {
        if (!next.chart || next.chart.data.series.length <= 1) return false;
        const series = [...next.chart.data.series];
        const index = series.findIndex((candidate) => candidate.id === seriesId);
        if (index < 0) return false;
        series.splice(index, 1);
        next.chart.data = { ...next.chart.data, series };
      },
      { history: "chart series" },
    ).then((succeeded) => {
      const currentUi = useUiStore.getState();
      if (
        !succeeded ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        currentUi.inspectorNavigation.sequence !== expectedNavigationSequence ||
        currentUi.inspector.tab !== "scene" ||
        currentUi.inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
      ) {
        return;
      }
      closeDrill();
    });
  };
  const addOverlay = () =>
    void patchDoc((next) => {
      // The Rust scaffolder's Cutout start defaults, byte for byte; replaces wholesale so stale opt-out junk can't linger. No starter chip: the slide pass paints the panel and its cutout whether or not the panel carries content.
      next.frame = { cutout: { shape: "rounded-rect", side: "start" } };
    });
  // The row edits this scene's EXIT (boundary index = the outgoing scene); the last scene remaps to its entrance so the row always means something.
  const boundaryIndex = Math.max(0, Math.min(sceneIndex, project.slots.length - 2));
  const transitionSpec = project.slots[boundaryIndex + 1]?.transitionIn;
  const transitionValue =
    project.slots.length > 1
      ? transitionSpec
        ? `${TRANSITION_CATALOG.find((entry) => entry.type === transitionSpec.type)?.label ?? transitionSpec.type} · ${(transitionSpec.durationMs / 1000).toFixed(1)} s`
        : "None"
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

  /** Route a background-drill mutation at its target: the scene's own background, or the comparison's after side. For the after side, side B's values swap in before the mutation and transplant out after, so the drill's reads and writes work unchanged and every OTHER field still mutates the real doc. Staging rides along, because the drill's colour and gradient picks write the backdrop too. */
  const patchBgDoc = (mutate: (next: SceneDoc) => void, opts?: Parameters<typeof patchDoc>[1]) => {
    if (bgTarget !== "compareB") return patchDoc(mutate, opts);
    return patchDoc((next) => mutateCompareBackgroundTarget(next, mutate), opts);
  };
  /** The lighting drill's target routing, same transplant rule over `lighting`. */
  const patchLightingDoc = (
    mutate: (next: SceneDoc) => void,
    opts?: Parameters<typeof patchDoc>[1],
  ) => {
    if (lightingTarget !== "compareB") return patchDoc(mutate, opts);
    return patchDoc((next) => {
      const own = next.lighting;
      if (opts?.history === false && comparisonLightingBaselineARef.current === null) {
        comparisonLightingBaselineARef.current = structuredClone(own);
      }
      mutateComparisonLightingTarget(next, mutate);
    }, opts);
  };
  const patchLightingDocResult = (
    mutate: (next: SceneDoc) => unknown,
    opts?: Parameters<typeof patchDocResult>[1],
  ) => {
    if (lightingTarget !== "compareB") return patchDocResult(mutate, opts);
    return patchDocResult((next) => mutateComparisonLightingTarget(next, mutate), opts);
  };
  const commitLightingFromBaseline = (baseline: SceneDoc, mutate: (next: SceneDoc) => void) => {
    if (lightingTarget !== "compareB") return commitFromBaseline(baseline, mutate);
    const realBaseline = structuredClone(baseline);
    realBaseline.lighting = structuredClone(
      comparisonLightingBaselineARef.current ?? docRef.current?.lighting,
    );
    comparisonLightingBaselineARef.current = null;
    return commitFromBaseline(realBaseline, (next) => {
      mutateComparisonLightingTarget(next, mutate);
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
        if (bgStagedBackdrop !== null && bgStagedBackdrop !== "none") {
          next.backdrop = { type: "none" };
        }
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
      if (bgStagedBackdrop !== null && bgStagedBackdrop !== "none") {
        next.backdrop = { type: "none" };
      }
    });
  };

  const header = (
    <div className="inspector-scene-head inspector-scene-identity">
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

  const promoteLegacyImageOnce = async (
    decorationId: string,
    mutate: MediaMutation,
    history: string,
  ): Promise<string | null> => {
    const resolved = structuredClone(resolvedDecorationsRef.current ?? []);
    let promotedId: string | null = null;
    const succeeded = await patchDocResultRef.current(
      (next) => {
        const result = promoteLegacyMedia(next, resolved, decorationId, mutate);
        if (!result) return false;
        replaceSceneDoc(next, result.doc);
        promotedId = result.mediaId;
      },
      { history },
    );
    if (!succeeded || !promotedId) {
      setLegacyImageNotice(
        "This inherited image could not be taken over. Choose a still PNG, JPEG or WebP source first.",
      );
      return null;
    }
    setLegacyImageNotice(null);
    return promotedId;
  };

  const finishLegacyImagePromotion = (
    mediaId: string,
    decorationId: string,
    operationToken: symbol,
    expectedProjectId: string,
    expectedSceneIndex: number,
    expectedSceneFile: string | null,
  ) => {
    const inspector = useUiStore.getState().inspector;
    useImageReconciliationStore.getState().recordOrigin(expectedProjectId, expectedSceneFile, {
      kind: "legacy-promotion",
      decorationId,
      imageId: mediaId,
    });
    if (
      projectIdRef.current !== expectedProjectId ||
      sceneIndexRef.current !== expectedSceneIndex ||
      sceneFileRef.current !== expectedSceneFile
    ) {
      return;
    }
    const decorationState = useDecorationEditStore.getState();
    if (
      legacyImageOperationRef.current !== operationToken ||
      decorationState.sceneIndex !== expectedSceneIndex ||
      decorationState.selectedId !== decorationId
    ) {
      return;
    }
    if (inspector.tab !== "scene" || inspector.drillIn !== LEGACY_MEDIA_DRILL_ROUTE) return;
    useDecorationEditStore.getState().select(null);
    useImageEditStore.getState().select({ sceneIndex: expectedSceneIndex, imageId: mediaId });
    setOverviewSelection({
      sceneIndex: expectedSceneIndex,
      rowId: mediaRowId(mediaId),
      domain: "media",
    });
    replaceDrill(MEDIA_DRILL_ROUTE);
  };

  const addPickedMedia = (src: string, kind: SceneMediaKind, meta: MediaMeta | null) => {
    if (contentActionPendingRef.current) return;
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedUi = useUiStore.getState();
    const expectedDrillStack = [...expectedUi.inspector.drillStack];
    const expectedNavigationSequence = expectedUi.inspectorNavigation.sequence;
    const host = defaultSceneMediaHost(kind, sceneFrame !== undefined);
    const actionToken = Symbol("add-media");
    contentActionPendingRef.current = {
      token: actionToken,
      projectId: expectedProjectId,
      sceneIndex: expectedSceneIndex,
      sceneFile: expectedSceneFile,
    };
    setContentActionBusy(true);
    let createdId: string | null = null;
    // Detection runs on the cached poster before the patch, so the recording crop lands in the same undoable entry as the pick.
    void detectWindowRecording(meta)
      .then((recording) =>
        patchDocResult(
          (next) => {
            const id = nextSceneMediaId(
              kind,
              resolveSceneDocMedia(next).map((entry) => entry.id),
            );
            createdId = id;
            editSceneDocMedia(next, (entries) => [
              ...entries,
              createSceneMedia(id, src, kind, host),
            ]);
            applyPickedMediaSource(next, id, src, kind, meta, recording);
            const added = resolveSceneDocMedia(next).find((entry) => entry.id === id);
            if (added?.window) {
              // A freshly added window starts rimless, the look the video-window add flow always shipped.
              added.window.border ??= {
                enabled: false,
                color: "#ffffff",
                width: 0.0035,
                opacity: 0.12,
              };
              editSceneDocMedia(next, (entries) => entries);
              // Staged scenery sits in front of the window shadow plane and clips it: stand staging down in the same undoable entry.
              if (stagedBackdrop !== null && stagedBackdrop !== "none") {
                next.backdrop = { type: "none" };
              }
            }
          },
          { history: "add media", resync: kind === "video" },
        ),
      )
      .then((succeeded) => {
        const id = createdId;
        const state = useUiStore.getState();
        const stillOwnsAction =
          projectIdRef.current === expectedProjectId &&
          sceneIndexRef.current === expectedSceneIndex &&
          sceneFileRef.current === expectedSceneFile &&
          state.inspector.tab === "scene" &&
          state.inspectorNavigation.sequence === expectedNavigationSequence &&
          state.inspector.drillStack.join("\u0000") === expectedDrillStack.join("\u0000");
        if (!succeeded || !id || !stillOwnsAction) {
          if (stillOwnsAction) setImagePickError("Couldn’t add the media.");
          else contentAddActivatorRef.current = null;
          return;
        }
        setOverviewSelection({
          sceneIndex: expectedSceneIndex,
          rowId: mediaRowId(id),
          domain: "media",
        });
        useImageEditStore.getState().select({ sceneIndex: expectedSceneIndex, imageId: id });
        focusContentAddActivator();
        jumpDrill([MEDIA_DRILL_ROUTE]);
      })
      .finally(() => {
        if (contentActionPendingRef.current?.token === actionToken) {
          contentActionPendingRef.current = null;
          setContentActionBusy(false);
        }
      });
  };

  const pickSceneMedia = (rel: string, meta: MediaMeta | null) => {
    if (mediaTarget.kind === "media") {
      const kind = mediaTarget.mediaKind;
      if (meta && meta.kind !== kind) return;
      if (kind === "image" && !isSceneImageSource(rel)) {
        setImagePickError("Scene images support still PNG, JPEG and WebP files.");
        return;
      }
      setImagePickError(null);
      if (mediaTarget.legacyId) {
        const operationToken = beginLegacyImageOperation();
        if (!operationToken) return;
        const legacyId = mediaTarget.legacyId;
        const expectedProjectId = project.id;
        const expectedSceneIndex = sceneIndex;
        const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
        closeDrill();
        restoreImageSourceFocus();
        void promoteLegacyImageOnce(
          legacyId,
          (entry) => {
            entry.src = rel;
          },
          "replace media source",
        )
          .then((mediaId) => {
            if (mediaId) {
              finishLegacyImagePromotion(
                mediaId,
                legacyId,
                operationToken,
                expectedProjectId,
                expectedSceneIndex,
                expectedSceneFile,
              );
            }
          })
          .finally(() => endLegacyImageOperation(operationToken));
        return;
      }
      if (mediaTarget.replaceId) {
        const replaceId = mediaTarget.replaceId;
        closeDrill();
        restoreImageSourceFocus();
        // Detection runs on the cached poster before the patch, so the recording crop lands in the same undoable entry as the pick.
        void detectWindowRecording(meta).then((recording) =>
          patchDoc((next) => applyPickedMediaSource(next, replaceId, rel, kind, meta, recording), {
            resync: kind === "video",
          }),
        );
      } else {
        addPickedMedia(rel, kind, meta);
      }
      return;
    }
    closeDrill();
    if (mediaTarget.kind === "device") {
      const isVideo = meta?.kind !== "image";
      const targetId = mediaTarget.deviceId ?? deviceId;
      void patchDoc(
        (next) => {
          if (!targetId) return;
          replaceDeviceMedia(next, targetId, { src: rel, kind: isVideo ? "video" : "image" });
        },
        { resync: true },
      );
      return;
    }
    const resolvedDecorations = structuredClone(sceneFrame?.decorations ?? []);
    const { replaceId } = mediaTarget;
    void patchDoc((next) => {
      const current = next.frame?.decorations ?? resolvedDecorations;
      const nextDecos: FrameDecorationSpec[] = replaceId
        ? current.map((decoration) =>
            decoration.id === replaceId
              ? {
                  ...decoration,
                  src: rel,
                  text: undefined,
                  colour: undefined,
                  face: undefined,
                }
              : decoration,
          )
        : [
            ...current,
            {
              id: nextDecorationId(rel, new Set(current.map((decoration) => decoration.id))),
              src: rel,
              position: [0.45, -0.5],
              size: 0.15,
              shape: "none",
              layer: "above",
            },
          ];
      next.frame = { ...(next.frame ?? {}), decorations: nextDecos };
    });
  };
  if (drillIn === "media.picker") {
    const targetDeviceId =
      mediaTarget.kind === "device" ? (mediaTarget.deviceId ?? deviceId) : null;
    const targetDevice = targetDeviceId
      ? devices.find((candidate) => candidate.id === targetDeviceId)
      : undefined;
    const selectedRel =
      mediaTarget.kind === "device"
        ? (targetDevice?.media?.src ?? null)
        : mediaTarget.kind === "media"
          ? mediaTarget.replaceId
            ? (mediaEntries.find((candidate) => candidate.id === mediaTarget.replaceId)?.src ??
              null)
            : mediaTarget.legacyId
              ? (sceneFrame?.decorations?.find((candidate) => candidate.id === mediaTarget.legacyId)
                  ?.src ?? null)
              : null
          : mediaTarget.replaceId
            ? (sceneFrame?.decorations?.find((candidate) => candidate.id === mediaTarget.replaceId)
                ?.src ?? null)
            : null;
    const mediaPickerKind = mediaTarget.kind === "media" ? mediaTarget.mediaKind : "image";
    const closeMediaPicker = () => {
      const restoreEntryFocus =
        mediaTarget.kind === "media" &&
        (mediaTarget.replaceId !== undefined || mediaTarget.legacyId !== undefined);
      setImagePickError(null);
      closeDrill();
      if (restoreEntryFocus) restoreImageSourceFocus();
      else if (mediaTarget.kind === "media") restoreContentAddActivatorFocus();
    };
    return (
      <div className="inspector-drill">
        <DrillBack
          label={backLabel}
          title={
            mediaTarget.kind === "device"
              ? "Screen media"
              : mediaPickerKind === "video"
                ? "Choose video"
                : "Choose image"
          }
          onClick={closeMediaPicker}
        />
        <div className="inspector-drill-body">
          {mediaTarget.kind === "media" && imagePickError && (
            <p className="modal-error">{imagePickError}</p>
          )}
          <div className="inspector-media-host">
            <MediaBrowser
              inspectorPreview
              slug={slug}
              projectPath={workspaceProjectPath(slug) ?? ""}
              kinds={mediaTarget.kind === "device" ? undefined : [mediaPickerKind]}
              kindToggle={mediaTarget.kind === "device"}
              kindDefault={targetDevice?.media?.kind === "image" ? "image" : "video"}
              globalToggle
              refreshKey={mediaRefreshKey + mediaRefresh}
              selectedRel={selectedRel}
              onPick={pickSceneMedia}
              cardMenu={mediaCardMenu({
                slug,
                primaryLabel: "Select",
                onPrimary: pickSceneMedia,
                onChanged: () => setMediaRefresh((n) => n + 1),
                onError: setError,
                onEdit:
                  mediaTarget.kind === "media" && mediaTarget.replaceId
                    ? (rel) => {
                        const entryId = mediaTarget.replaceId;
                        const entry = mediaEntries.find((candidate) => candidate.id === entryId);
                        if (!entry || entry.src !== rel) return false;
                        onOpenEditVideo(sceneIndex, rel, "media", entry.id);
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

  // ── Drill-in views ────────────────────────────────────────────────────────
  if (drillIn === "style.theme" && doc) {
    // The value the browser shows: the scene's own theme, or the After override reading through to Before.
    const shownThemeId = editingAfter ? compareThemeIdForSide(doc, compareSide) : themeDraft;
    // Applies on selection; the shown id doubles as the same-id de-dupe.
    const applySceneTheme = (id: string) => {
      if (id === shownThemeId) return;
      // Theme resolution bakes at load; the write chains the nonce reload.
      applySceneThemeChoice(id);
    };
    return (
      <div className="inspector-drill">
        <DrillBack
          label={backLabel}
          title={hasComparison(doc) ? "Theme" : "Scene theme"}
          onClick={() => closeDrill()}
        />
        {hasComparison(doc) && (
          <CompareSideSelector value={compareSideActive} onChange={setCompareSide} />
        )}
        <div className="inspector-drill-body">
          <div className="font-slot-row">
            <button
              type="button"
              className={`chip chip-with-icon${shownThemeId === "" ? " selected" : ""}`}
              onClick={() => applySceneTheme("")}
            >
              {editingAfter && <ComparisonSideIcon side="before" size={14} />}
              {editingAfter ? "Match the before side" : "Project theme"}
            </button>
          </div>
          <ThemeBrowser
            layout="compact"
            choices={themeChoices}
            value={shownThemeId}
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
        <DrillBack label={backLabel} title="Cutout" onClick={() => closeDrill()} />
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
        <DrillBack label={backLabel} title="Panel background" onClick={() => closeDrill()} />
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
              {sceneFrame.cutout.shape === "none"
                ? "No panel fill: the scene fills the whole frame and the overlay's text, chip and decorations sit over it."
                : "No panel fill: the scene stays in its cutout, the panel takes the scene's own backdrop colour, and the overlay's text, chip and decorations sit over it."}
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
        <DrillBack label={backLabel} title="Panel image" onClick={() => closeDrill()} />
        <div className="inspector-drill-body">
          <div className="inspector-media-host">
            <MediaBrowser
              inspectorPreview
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
        <DrillBack label={backLabel} title="Chip" onClick={() => closeDrill()} />
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
    const writeDecos = (update: (current: FrameDecorationSpec[]) => FrameDecorationSpec[]) =>
      void patchDoc((next) => {
        const current = structuredClone(next.frame?.decorations ?? decos);
        const nextDecos = update(current);
        next.frame = { ...(next.frame ?? {}), decorations: nextDecos };
      });
    const patchDeco = (id: string, change: Partial<FrameDecorationSpec>) =>
      writeDecos((current) =>
        current.map((decoration) =>
          decoration.id === id ? { ...decoration, ...change } : decoration,
        ),
      );
    const openImagePicker = (replaceId?: string) => {
      openMediaPicker({ kind: "decoration", replaceId });
    };
    // Switching to text keeps the placement and drops the image-only fields; switching back rides the picker, since an image decoration needs a `src` to exist.
    const makeText = (d: FrameDecorationSpec) =>
      patchDeco(d.id, { text: d.text ?? "Text", src: undefined, shape: undefined });
    const addText = () =>
      writeDecos((current) => [
        ...current,
        {
          id: uniqueDecorationId("text", new Set(current.map((decoration) => decoration.id))),
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
        <DrillBack label={backLabel} title="Decorations" onClick={() => closeDrill()} />
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
                    onClick={() =>
                      writeDecos((current) =>
                        current.filter((decoration) => decoration.id !== d.id),
                      )
                    }
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
      </div>
    );
  }
  if (drillIn === "frame.icon" && doc && sceneFrame) {
    const icon = managedFrameIconValue(doc, sceneFrame);
    const resolvedFrameFor = (source: SceneDoc) => mergeFrameSpec(project.deckFrame, source.frame);
    const commitFrameIcon = async (value: string) => {
      if (textIconWriteRef.current) return;
      const next = setManagedFrameIcon(doc, value, resolvedFrameFor(doc));
      if (!next) return;
      const token = Symbol("panel-icon-write");
      textIconWriteRef.current = token;
      setTextIconWriteBusy(true);
      const expectedProjectId = project.id;
      const expectedSceneIndex = sceneIndex;
      const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
      const expectedRoute = drillIn;
      let succeeded: boolean | undefined;
      try {
        succeeded = await writeManagedText({
          preview: next,
          history: "change panel icon",
          baseline: doc,
          applyToCurrent: (current) =>
            setManagedFrameIcon(current, value, resolvedFrameFor(current)) ?? current,
        });
      } finally {
        if (textIconWriteRef.current === token) {
          textIconWriteRef.current = null;
          setTextIconWriteBusy(false);
        }
      }
      if (
        succeeded === false ||
        projectIdRef.current !== expectedProjectId ||
        sceneIndexRef.current !== expectedSceneIndex ||
        sceneFileRef.current !== expectedSceneFile ||
        useUiStore.getState().inspector.drillIn !== expectedRoute
      ) {
        return;
      }
      if (value) {
        setTextIconRecentState({
          projectId: expectedProjectId,
          values: storeTextIconRecent(expectedProjectId, value),
        });
      }
    };
    const preview = icon.startsWith("assets/") ? inspectorAssetUrl(project.id, icon) : undefined;
    return (
      <div className="inspector-drill text-inspector-drill">
        <DrillBack label={backLabel} title="Panel icon" onClick={closeDrill} />
        <div className="inspector-drill-scroll text-inspector-scroll">
          {error && (
            <p className="inspector-error" role="alert">
              {error}
            </p>
          )}
          <div
            className="text-inspector-icon-preview"
            role="img"
            aria-label={icon ? `Panel icon preview: ${icon}` : "No panel icon selected"}
          >
            {preview ? <img src={preview} alt="" /> : <span>{icon || "No icon"}</span>}
          </div>
          <fieldset className="text-inspector-icon-recents" disabled={textIconWriteBusy}>
            <legend>Quick emoji</legend>
            <div className="text-inspector-icon-recent-grid text-inspector-icon-quick-grid">
              {HEADER_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`Use emoji ${emoji}`}
                  aria-pressed={icon === emoji}
                  onClick={() => void commitFrameIcon(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="text-inspector-icon-actions">
            <button
              type="button"
              className="btn small"
              disabled={textIconWriteBusy}
              onClick={() => openDrill(textIconInspectorRoute("emoji", "frameIcon"))}
            >
              All emoji
            </button>
            <button
              type="button"
              className="btn small"
              disabled={textIconWriteBusy}
              onClick={() => openDrill(textIconInspectorRoute("image", "frameIcon"))}
            >
              Image…
            </button>
            <button
              type="button"
              className="btn small"
              disabled={textIconWriteBusy || !icon}
              onClick={() => void commitFrameIcon("")}
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (drillIn === "frame.text" && sceneFrame) {
    const claimed = sceneFrame.claimsSceneText !== false;
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} title="Scene text" onClick={() => closeDrill()} />
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
        <DrillBack label={backLabel} title="Device shadow" onClick={() => closeDrill()} />
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
        <DrillBack
          label={backLabel}
          title={kind === "video" ? "Background video" : "Background image"}
          onClick={() => closeDrill()}
        />
        <div className="inspector-drill-body">
          <div className="inspector-media-host">
            <MediaBrowser
              inspectorPreview
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
    // Staging state from the registry, read off the host for the side being edited: null = that side mounts no SceneStage (hide the toggle, never warn).
    const stagingOn = bgStagedBackdrop !== null && bgStagedBackdrop !== "none";
    // After follows Before's backdrop until it overrides one, exactly as the side resolves at render.
    const bgBackdrop =
      bgTarget === "compareB" ? (doc.compare?.b?.backdrop ?? doc.backdrop) : doc.backdrop;
    const resolvedBackdrop = bgBackdrop ?? sceneTheme?.backdrop;
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
        <DrillBack label={backLabel} title="Background" onClick={() => closeDrill()} />
        {hasComparison(doc) && (
          <CompareSideSelector
            value={compareSideActive}
            onChange={(side) => {
              setBgTabOverride(null);
              setBackingTabOverride(null);
              setCompareSide(side);
            }}
          />
        )}
        <div className="inspector-drill-body">
          {bgTab === "shader" && selectedShaderPreset && (
            <div className="popover-row">
              <button
                type="button"
                className="btn"
                title={`Back to the ${selectedShaderPreset.name} preset's colours and motion`}
                onClick={() => applyShaderPreset(selectedShaderPreset)}
              >
                Reset {selectedShaderPreset.name}
              </button>
            </div>
          )}
          {docTab === "default" ? (
            <p className="modal-hint">
              {editingAfter
                ? "Following the before side. Pick a fill type to give the after side its own."
                : "Following the theme's background. Pick a fill type to override it for this scene."}
            </p>
          ) : (
            <div className="popover-row">
              <button type="button" className="btn" onClick={() => commitBackground(undefined)}>
                {editingAfter && <ComparisonSideIcon side="before" size={14} />}
                {editingAfter ? "Match the before side" : "Reset to theme default"}
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
          {bgStagedBackdrop !== null && (
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
                      bgBackdrop === undefined ? "theme" : (resolvedBackdrop?.type ?? "none");
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
        <DrillBack
          label={backLabel}
          title={`Transition out of scene ${boundaryIndex + 1}`}
          onClick={() => closeDrill()}
        />
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
  const textIconScreen = textIconInspectorScreenForRoute(drillIn);
  if (textIconScreen && doc) {
    const item =
      textIconScreen.itemKey === "frameIcon" && sceneFrame
        ? {
            key: "frameIcon",
            type: "icon" as const,
            icon: managedFrameIconValue(doc, sceneFrame),
          }
        : managedTextModel?.items.find(
            (candidate) => candidate.key === textIconScreen.itemKey && candidate.type === "icon",
          );
    if (!item) {
      return (
        <div className="inspector-drill">
          <DrillBack label={backLabel} title="Icon" onClick={closeDrill} />
          <p className="inspector-stub-note">This icon is no longer in the scene.</p>
        </div>
      );
    }
    const expectedRoute = drillIn ?? "";
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const itemIconValue = item.icon ?? item.text ?? "";
    const isCurrentIconRoute = () =>
      projectIdRef.current === expectedProjectId &&
      sceneIndexRef.current === expectedSceneIndex &&
      sceneFileRef.current === expectedSceneFile &&
      useUiStore.getState().inspector.drillIn === expectedRoute;
    const updateIcon = (source: SceneDoc, value: string) =>
      item.key === "frameIcon"
        ? setManagedFrameIcon(source, value, mergeFrameSpec(project.deckFrame, source.frame))
        : source.managedText !== undefined
          ? setManagedTextIcon(
              source,
              item.key,
              value,
              textRegistrations,
              textVirtualOptionsForDoc(source),
            )
          : setLegacyManagedTextIcon(
              source,
              item.key,
              value,
              mergeFrameSpec(project.deckFrame, source.frame),
            );
    const commitIcon = async (value: string) => {
      if (!isCurrentIconRoute() || textIconWriteRef.current) return;
      const expectedNavigationSequence = useUiStore.getState().inspectorNavigation.sequence;
      const next = updateIcon(doc, value);
      const token = Symbol("text-icon-write");
      textIconWriteRef.current = token;
      setTextIconWriteBusy(true);
      if (next) {
        try {
          const succeeded = await writeManagedText({
            preview: next,
            history: "change text icon",
            baseline: doc,
            applyToCurrent: (current) => updateIcon(current, value) ?? current,
          });
          if (succeeded === false) return;
        } finally {
          if (textIconWriteRef.current === token) {
            textIconWriteRef.current = null;
            setTextIconWriteBusy(false);
          }
        }
      } else {
        textIconWriteRef.current = null;
        setTextIconWriteBusy(false);
      }
      if (
        !isCurrentIconRoute() ||
        useUiStore.getState().inspectorNavigation.sequence !== expectedNavigationSequence
      ) {
        return;
      }
      setTextIconRecentState({
        projectId: expectedProjectId,
        values: storeTextIconRecent(expectedProjectId, value),
      });
      closeDrill();
    };
    return textIconScreen.kind === "emoji" ? (
      <TextIconEmojiPickerDrill
        key={textIconPickerMountKey(
          project.id,
          expectedSceneFile ?? expectedSceneIndex,
          expectedRoute,
        )}
        initialValue={itemIconValue}
        backLabel={backLabel}
        notice={error}
        disabled={textIconWriteBusy}
        onBack={closeDrill}
        onPick={(value) => void commitIcon(value)}
        onError={setError}
      />
    ) : (
      <TextIconImagePickerDrill
        key={textIconPickerMountKey(
          project.id,
          expectedSceneFile ?? expectedSceneIndex,
          expectedRoute,
        )}
        slug={slug}
        projectPath={workspaceProjectPath(slug) ?? ""}
        refreshKey={mediaRefreshKey + mediaRefresh}
        selectedRel={itemIconValue.startsWith("assets/") ? itemIconValue : null}
        backLabel={backLabel}
        disabled={textIconWriteBusy}
        onBack={closeDrill}
        onPick={(value) => void commitIcon(value)}
      />
    );
  }
  if (drillIn === "text" && doc) {
    const resolvedTextFrame = (source: SceneDoc) => mergeFrameSpec(project.deckFrame, source.frame);
    return (
      <ManagedTextDrill
        key={`${project.id}\u0000${project.sceneFiles[sceneIndex] ?? sceneIndex}\u0000text`}
        doc={doc}
        registrations={textRegistrations}
        virtualOptions={textVirtualOptionsForDoc(doc)}
        virtualOptionsForDoc={textVirtualOptionsForDoc}
        selectedGroupKey={selectedTextGroupKey}
        selectedItemKey={selectedTextKey}
        backLabel={backLabel}
        onBack={closeDrill}
        onSelectGroup={(groupKey) => {
          setOverviewSelection(
            groupKey ? { sceneIndex, rowId: `text:${groupKey}`, domain: "text" } : null,
          );
        }}
        onSelectItem={(itemKey) => {
          useTextEditStore.getState().select(itemKey ? { sceneIndex, key: itemKey } : null);
        }}
        onOpenMotion={(itemKey) => openDrill(`text.motion:${itemKey}`)}
        onOpenLook={(itemKey) => openDrill(`text.look:${itemKey}`)}
        onEditFont={(itemKey) => openDrill(`text.font:${itemKey}`)}
        theme={sceneTheme ?? project.theme}
        colourDefaults={textColourDefaults}
        confirmTakeover={confirmManagedTextTakeover}
        writeDoc={writeManagedText}
        recentIcons={textIconRecents}
        resolveIconPreview={(value) =>
          value.startsWith("assets/") ? inspectorAssetUrl(project.id, value) : undefined
        }
        onOpenEmoji={(itemKey) => {
          openDrill(textIconInspectorRoute("emoji", itemKey));
          return undefined;
        }}
        onChooseImage={(itemKey) => {
          openDrill(textIconInspectorRoute("image", itemKey));
          return undefined;
        }}
        onIconCommitted={(value) =>
          setTextIconRecentState({
            projectId: project.id,
            values: storeTextIconRecent(project.id, value),
          })
        }
        alignment={managedTextAlignment(doc, resolvedTextFrame(doc))}
        mutateAlignment={(source, align) =>
          setManagedTextAlignment(source, align, resolvedTextFrame(source))
        }
        mutateIcon={(source, itemKey, value) =>
          setLegacyManagedTextIcon(source, itemKey, value, resolvedTextFrame(source))
        }
        notice={error}
        disabled={textTakeoverBusy}
      />
    );
  }
  if (drillIn?.startsWith("text.motion:") && doc) {
    const key = drillIn.slice("text.motion:".length);
    const item = managedTextModel?.items.find((candidate) => candidate.key === key);
    if (!item) {
      return (
        <div className="inspector-drill">
          <DrillBack label={backLabel} title="Text motion" onClick={closeDrill} />
          <p className="inspector-stub-note">This text line is no longer in the scene.</p>
        </div>
      );
    }
    const label =
      item.type === "bullets"
        ? "Bullets"
        : item.type === "icon"
          ? "Icon"
          : item.text?.trim() || (item.type === "title" ? "Title" : "Subtitle");
    return (
      <TextMotionDrill
        key={`${project.id}\u0000${project.sceneFiles[sceneIndex] ?? sceneIndex}\u0000${item.key}`}
        doc={doc}
        itemKey={item.key}
        itemType={item.type}
        itemLabel={label}
        resolvedItemMotion={managedTextModel?.textAnimationOverrides?.[item.key]}
        codedMotionNames={codedTextMotionNames(sceneIndex)}
        backLabel={backLabel}
        onBack={closeDrill}
        writeDoc={writeManagedText}
      />
    );
  }
  if (drillIn?.startsWith("text.look:") && doc) {
    const key = drillIn.slice("text.look:".length);
    const item = managedTextModel?.items.find((candidate) => candidate.key === key);
    if (!item) {
      return (
        <div className="inspector-drill">
          <DrillBack label={backLabel} title="Text style" onClick={closeDrill} />
          <p className="inspector-stub-note">This text line is no longer in the scene.</p>
        </div>
      );
    }
    const label =
      item.type === "bullets"
        ? "Bullets"
        : item.type === "icon"
          ? "Icon"
          : item.text?.trim() || (item.type === "title" ? "Title" : "Subtitle");
    return (
      <TextLookDrill
        key={`${project.id}\u0000${project.sceneFiles[sceneIndex] ?? sceneIndex}\u0000${item.key}\u0000look`}
        doc={doc}
        itemKey={item.key}
        itemType={item.type}
        itemLabel={label}
        resolvedItemLook={managedTextModel?.textLookOverrides?.[item.key]}
        codedLookNames={codedTextLookNames(sceneIndex)}
        theme={sceneTheme ?? project.theme}
        backLabel={backLabel}
        onBack={closeDrill}
        writeDoc={writeManagedText}
      />
    );
  }
  if (drillIn?.startsWith("text.font:") && doc) {
    const key = drillIn.slice("text.font:".length);
    const item = managedTextModel?.items.find((candidate) => candidate.key === key);
    if (!item || item.type === "icon") {
      return (
        <div className="inspector-drill">
          <DrillBack label={backLabel} title="Text font" onClick={closeDrill} />
          <p className="inspector-stub-note">This text font is no longer available.</p>
        </div>
      );
    }
    const firstLine = item.text?.trim().split(/\r?\n/, 1)[0];
    const label =
      item.type === "bullets"
        ? "Bullets"
        : firstLine
          ? `${firstLine.slice(0, 30)}${firstLine.length > 30 ? "…" : ""}`
          : item.type === "subtitle"
            ? "Subtitle"
            : "Title";
    const themeFace = (sceneTheme ?? project.theme).typography[
      item.type === "subtitle" || item.type === "bullets" ? "body" : "headline"
    ];
    const override = doc.textStyle?.[`${key}Font`];
    const virtualFont = managedTextModel?.textStyle?.[`${key}Font`];
    const themeFont = formatFontString(themeFace);
    const currentRef =
      typeof override === "string"
        ? parseFontString(override)
        : typeof virtualFont === "string"
          ? parseFontString(virtualFont)
          : themeFace;
    const commitFont = (value: string | undefined) =>
      patchDocResult(
        (next) => {
          const style = { ...(next.textStyle ?? {}) };
          if (value === undefined) delete style[`${key}Font`];
          else style[`${key}Font`] = value;
          next.textStyle = Object.keys(style).length > 0 ? style : undefined;
        },
        { history: `${label.toLowerCase()} font` },
      );
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedRoute = drillIn;
    return (
      <div className="inspector-drill">
        <DrillBack
          label={backLabel}
          title={`${label.charAt(0).toUpperCase() + label.slice(1)} font`}
          onClick={() => closeDrill()}
        />
        <div className="inspector-drill-body">
          {(typeof override === "string" || typeof virtualFont === "string") &&
            (typeof override === "string" ? override : virtualFont) !== themeFont && (
              <button
                type="button"
                className="btn text-font-reset"
                onClick={() =>
                  void commitFont(typeof virtualFont === "string" ? themeFont : undefined)
                }
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
                const succeeded = await commitFont(formatFontString(ref));
                // A recent chip is a committed choice, so step straight back to Edit text.
                if (
                  succeeded &&
                  opts?.fromRecent &&
                  projectIdRef.current === expectedProjectId &&
                  sceneIndexRef.current === expectedSceneIndex &&
                  sceneFileRef.current === expectedSceneFile &&
                  useUiStore.getState().inspector.drillIn === expectedRoute
                ) {
                  closeDrill();
                }
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
        <DrillBack label={backLabel} title="Decoration font" onClick={() => closeDrill()} />
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
        <DrillBack label={backLabel} title="After screen" onClick={() => closeDrill()} />
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
          <div className="inspector-media-host">
            <MediaBrowser
              inspectorPreview
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
    // A gesture that ends where it started commits nothing: put the baseline's comparison back and release it, so the NEXT commit can never build on a stale snapshot.
    const cmpAbort = () => {
      const baseline = compareDragBaseline.current;
      compareDragBaseline.current = null;
      compareGestureMs.current = null;
      if (!baseline) return;
      void patchDoc(
        (next) => {
          next.compare = structuredClone(baseline.compare);
        },
        { history: false },
      );
    };
    const maskType = cmp.mask?.type ?? "linear";
    const maskEntry = COMPARE_MASK_CATALOG.find((e) => e.id === maskType);
    const hasKeys = (cmp.track?.keys.length ?? 0) > 0;
    // The lane's committed draft outranks the doc in the compositor, so rewriting the keys releases it.
    const releaseTrackDraft = () => {
      const lane = useCompareEditStore.getState();
      lane.setDraft(null);
      lane.select(null, null);
    };
    const applyPreset = (preset: (typeof COMPARE_PRESETS)[number]) => {
      const track = preset.build(scene.durationMs);
      releaseTrackDraft();
      void patchDoc((next) => {
        if (!next.compare) return;
        next.compare.track = track;
      });
    };
    const clearKeys = () => {
      releaseTrackDraft();
      void patchDoc(clearCompareTrack, { history: "clear divider keys" });
    };
    const staticAngleDeg = cmp.mask?.angleDeg ?? 90;
    // The Divider and Angle fields edit the key nearest the playhead (the static value and angle with none), frozen mid-gesture on the key the writes are pinned to so a running clock can't hop them, and never release the lane's draft: the patched project clears a committed one on its own.
    const targetKey =
      (compareGestureMs.current !== null
        ? nearestCompareKey(cmp.track?.keys, compareGestureMs.current)
        : cmp.track?.keys.find((k) => k.id === compareTargetKeyId)) ?? null;
    const dividerValue = targetKey?.pose.value ?? cmp.value ?? 0.5;
    const dividerAngleDeg = targetKey?.pose.angleDeg ?? staticAngleDeg;
    const gestureMs = () => (compareGestureMs.current ??= compareLocalMs());
    const releaseGestureMs = () => {
      const ms = gestureMs();
      compareGestureMs.current = null;
      return ms;
    };
    const keyHint = hasKeys ? "Edits the divider key nearest the playhead" : undefined;
    const grip = cmp.chrome?.grip;
    const gripObject = typeof grip === "object" ? grip : undefined;
    const lineColour = resolveCompareColour(cmp.chrome?.line?.colour, sceneTheme);
    // Each token wears its resolved colour, so the choice is the swatch rather than the word.
    const tintOptions: SegmentedOption<CompareTint>[] = [
      { value: "none", label: "None", title: "No tint", icon: <CompareNoneIcon size={14} /> },
      ...COMPARE_TINT_TOKENS.map((token) => ({
        value: token,
        label: `${token[0].toUpperCase()}${token.slice(1)}`,
        title: `Tint the after side with the theme's ${token} colour`,
        icon: <CompareSwatchIcon colour={resolveCompareColour(token, sceneTheme)} size={14} />,
      })),
    ];
    return (
      <div className="inspector-drill">
        <DrillBack
          label={backLabel}
          title="Comparison"
          onClick={closeDrill}
          actions={
            <DrillHeaderAction
              kind="remove"
              label="Remove comparison"
              onClick={() => {
                void patchDoc((next) => {
                  next.compare = undefined;
                  if (next.animatedTrack === "compare") next.animatedTrack = undefined;
                });
                closeDrill();
              }}
            />
          }
        />
        <div className="inspector-drill-body">
          <SegmentedRow
            ariaLabel="Comparison mask"
            className="subtabs-compact"
            options={COMPARE_MASK_CATALOG.map((e) => ({
              value: e.id,
              label: e.label,
              title: e.hint,
              icon: <CompareMaskIcon id={e.id} size={14} />,
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
              <span className="popover-inline slider-row-label" title={keyHint}>
                Angle
              </span>
              <NumberField
                label="Divider angle"
                value={dividerAngleDeg}
                decimals={0}
                min={0}
                max={360}
                step={1}
                onInput={(v) => {
                  const ms = gestureMs();
                  cmpLive((c) => setCompareDividerAngle(c, ms, v));
                }}
                onCommit={(v) => {
                  const ms = releaseGestureMs();
                  cmpCommit((c) => setCompareDividerAngle(c, ms, v));
                }}
                onDragEnd={(committed) => {
                  if (!committed) cmpAbort();
                }}
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
          {maskEntry?.hasSoftness && (
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
          )}
          <div className="popover-row">
            <span className="popover-inline slider-row-label" title={keyHint}>
              Divider
            </span>
            <DebouncedRange
              value={dividerValue}
              min={0}
              max={1}
              step={0.01}
              label="Divider position"
              onInput={(v) => {
                const ms = gestureMs();
                cmpLive((c) => setCompareDividerValue(c, ms, v));
              }}
              onCommit={(v) => {
                const ms = releaseGestureMs();
                cmpCommit((c) => setCompareDividerValue(c, ms, v));
              }}
            />
          </div>
          <DrillGroup label="Motion presets" hint="Writes keys you can hand-tune in the lane.">
            <div className="wizard-presets">
              <button
                type="button"
                className="chip compare-preset-chip"
                title="Clears the keys and brings back the static Divider slider"
                disabled={!hasKeys}
                onClick={clearKeys}
              >
                <ComparePresetIcon id="manual" size={14} />
                Manual
              </button>
              {COMPARE_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="chip compare-preset-chip"
                  title={p.hint}
                  onClick={() => applyPreset(p)}
                >
                  <ComparePresetIcon id={p.id} size={14} />
                  {p.label}
                </button>
              ))}
            </div>
          </DrillGroup>
          {(maskEntry?.hasLine || maskEntry?.hasGrip) && (
            <DrillGroup label="Divider line">
              {maskEntry?.hasLine && (
                <ToggleRow
                  icon={<CompareToggleIcon id="line" size={17} />}
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
              )}
              {maskEntry?.hasLine && cmp.chrome?.line && (
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
                  <div className="popover-row text-inspector-colour-row">
                    <span className="action-row-icon">
                      <TextControlIcon type="colour" />
                    </span>
                    <span className="popover-inline">Colour</span>
                    <span className="action-row-value">{lineColour.toUpperCase()}</span>
                    <ColourPicker
                      value={lineColour}
                      defaultValue={resolveCompareColour("accent", sceneTheme)}
                      label="Divider colour"
                      theme={sceneTheme}
                      onCommit={(hex) =>
                        patchCompare((c) => {
                          if (c.chrome?.line) c.chrome.line.colour = hex;
                        })
                      }
                      // Reset restores the accent TOKEN, so the divider follows the theme again.
                      onReset={
                        cmp.chrome.line.colour && cmp.chrome.line.colour !== "accent"
                          ? () =>
                              patchCompare((c) => {
                                if (c.chrome?.line) c.chrome.line.colour = "accent";
                              })
                          : undefined
                      }
                    />
                  </div>
                </>
              )}
              {maskEntry?.hasGrip && (
                <ToggleRow
                  icon={<CompareToggleIcon id="grip" size={17} />}
                  label="Grip handle"
                  description="The slider grip riding the divider."
                  checked={!!grip}
                  onChange={(on) => {
                    if (!on && gripObject) compareGripMemory.current = structuredClone(gripObject);
                    const remembered = on ? compareGripMemory.current : null;
                    patchCompare((c) => {
                      c.chrome = {
                        ...c.chrome,
                        grip: on ? (remembered ? structuredClone(remembered) : true) : undefined,
                      };
                    });
                  }}
                />
              )}
              {maskEntry?.hasGrip && grip && (
                <SegmentedRow
                  ariaLabel="Grip style"
                  className="subtabs-compact"
                  options={COMPARE_GRIP_CATALOG.map((e) => ({
                    value: e.id,
                    label: e.label,
                    title: e.hint,
                    icon: <CompareGripIcon id={e.id} size={14} />,
                  }))}
                  value={gripObject?.style ?? "chevrons"}
                  onChange={(style) =>
                    patchCompare((c) => {
                      const current =
                        typeof c.chrome?.grip === "object" ? c.chrome.grip : undefined;
                      c.chrome = {
                        ...c.chrome,
                        grip:
                          style === "chevrons" && current?.size === undefined
                            ? true
                            : { ...current, style },
                      };
                    })
                  }
                />
              )}
            </DrillGroup>
          )}
          <DrillGroup label="Labels">
            <ToggleRow
              icon={<CompareToggleIcon id="chips" size={17} />}
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
              ariaLabel="After tint"
              className="subtabs-compact"
              options={tintOptions}
              value={(cmp.chrome?.tint?.b ?? "none") as CompareTint}
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
          <p className="inspector-stub-note">
            Use the Before and After toggles in Device, Theme, Background and Lighting to edit each
            side.
          </p>
        </div>
      </div>
    );
  }
  if (drillIn === LEGACY_MEDIA_DRILL_ROUTE && doc && sceneFrame) {
    const activeSession = legacyImagePromotionRef.current;
    const legacyId =
      activeSession?.decorationId ??
      selectedDecoId ??
      sceneFrame.decorations?.find((decoration) => decoration.src)?.id ??
      null;
    const resolvedDecoration = sceneFrame.decorations?.find(
      (decoration) => decoration.id === legacyId && decoration.src !== undefined,
    );
    let displayEntry = activeSession?.mediaId
      ? mediaEntries.find((entry) => entry.id === activeSession.mediaId)
      : undefined;
    if (!displayEntry && resolvedDecoration?.src) {
      displayEntry = createSceneMedia(
        `legacy:${resolvedDecoration.id}`,
        resolvedDecoration.src,
        "image",
        "overlay",
      );
      displayEntry.overlay = {
        position: [...resolvedDecoration.position],
        size: resolvedDecoration.size,
        rotationDeg: resolvedDecoration.rotationDeg ?? 0,
        shape: resolvedDecoration.shape ?? "none",
        layer: resolvedDecoration.layer ?? "above",
        stackOrder: resolvedDecoration.stackOrder,
      };
    }
    // The shell edits ONE entry: the promoted one when it exists, else a throwaway view of the inherited decoration.
    const syntheticDoc: SceneDoc = { ...doc, media: displayEntry ? [displayEntry] : [] };
    delete syntheticDoc.images;
    delete syntheticDoc.videoWindow;
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const mutateLegacyImage = async (
      mutate: MediaMutation,
      options: MediaMutationOptions,
    ): Promise<void> => {
      if (!legacyId || legacyImageOperationRef.current) return;
      let session = legacyImagePromotionRef.current;
      if (!session || session.decorationId !== legacyId) {
        session = {
          decorationId: legacyId,
          baseline: structuredClone(docRef.current ?? doc),
          resolvedDecorations: structuredClone(resolvedDecorationsRef.current ?? []),
          mediaId: null,
        };
        legacyImagePromotionRef.current = session;
      }
      if (options.history === false) {
        const succeeded = await patchDocResultRef.current(
          (next) => {
            if (session.mediaId) {
              const media = resolveSceneDocMedia(next);
              const entry = media.find((candidate) => candidate.id === session.mediaId);
              if (!entry) return false;
              mutate(entry);
              editSceneDocMedia(next, () => media);
              session.draftEntry = structuredClone(entry);
              return;
            }
            const result = promoteLegacyMedia(
              next,
              session.resolvedDecorations,
              session.decorationId,
              mutate,
            );
            if (!result) return false;
            replaceSceneDoc(next, result.doc);
            session.mediaId = result.mediaId;
            session.draftEntry = structuredClone(
              resolveSceneDocMedia(result.doc).find((entry) => entry.id === result.mediaId),
            );
          },
          { history: false },
        );
        if (!succeeded || !session.mediaId) {
          if (!succeeded && session.mediaId) {
            const live = resolveSceneDocMedia(docRef.current).find(
              (entry) => entry.id === session.mediaId,
            );
            session.draftEntry = live ? structuredClone(live) : undefined;
            if (!live) session.mediaId = null;
          }
          setLegacyImageNotice(
            "This inherited image could not be taken over. Choose a still PNG, JPEG or WebP source first.",
          );
        } else {
          setLegacyImageNotice(null);
        }
        return;
      }

      const operationToken = beginLegacyImageOperation();
      if (!operationToken) return;
      const baselineSession = session;
      let promotedId: string | null = null;
      try {
        const succeeded = await commitFromBaselineResult(baselineSession.baseline, (next) => {
          const result = promoteLegacyMedia(
            next,
            baselineSession.resolvedDecorations,
            baselineSession.decorationId,
            (entry) => {
              if (baselineSession.draftEntry) {
                const id = entry.id;
                Object.assign(entry, structuredClone(baselineSession.draftEntry), { id });
              }
              mutate(entry);
            },
          );
          if (!result) return false;
          replaceSceneDoc(next, result.doc);
          promotedId = result.mediaId;
          baselineSession.draftEntry = structuredClone(
            resolveSceneDocMedia(result.doc).find((entry) => entry.id === result.mediaId),
          );
        });
        if (!succeeded || !promotedId) {
          const live = baselineSession.mediaId
            ? resolveSceneDocMedia(docRef.current).find(
                (entry) => entry.id === baselineSession.mediaId,
              )
            : undefined;
          if (live) {
            baselineSession.draftEntry = structuredClone(live);
          } else {
            baselineSession.mediaId = null;
            baselineSession.draftEntry = undefined;
          }
          legacyImagePromotionRef.current = baselineSession;
          setLegacyImageNotice(
            "This inherited image could not be taken over. Choose a still PNG, JPEG or WebP source first.",
          );
          return;
        }
        legacyImagePromotionRef.current = null;
        setLegacyImageNotice(null);
        finishLegacyImagePromotion(
          promotedId,
          baselineSession.decorationId,
          operationToken,
          expectedProjectId,
          expectedSceneIndex,
          expectedSceneFile,
        );
      } finally {
        endLegacyImageOperation(operationToken);
      }
    };
    const duplicateLegacyImage = () => {
      if (!legacyId || legacyImageOperationRef.current) return;
      const row: SceneOverviewRowModel = {
        id: legacyMediaRowId(legacyId),
        type: "image",
        label: resolvedDecoration?.src?.split("/").at(-1) ?? "Image",
        selectionTarget: { kind: "legacyImage", id: legacyId },
        openRoute: LEGACY_MEDIA_DRILL_ROUTE,
        readOnly: true,
      };
      const plan = planContentDuplicate(row, {
        doc: docRef.current ?? doc,
        resolvedDecorations: resolvedDecorationsRef.current,
      });
      if (!plan) return;
      const operationToken = beginLegacyImageOperation();
      if (!operationToken) return;
      void patchDocResultRef
        .current(plan.apply, { history: plan.history })
        .then((succeeded) => {
          const selection = plan.nextSelection;
          const inspector = useUiStore.getState().inspector;
          if (succeeded) {
            for (const origin of plan.imageOrigins ?? []) {
              useImageReconciliationStore
                .getState()
                .recordOrigin(expectedProjectId, expectedSceneFile, origin);
            }
          }
          if (
            !succeeded ||
            legacyImageOperationRef.current !== operationToken ||
            selection?.kind !== "media" ||
            projectIdRef.current !== expectedProjectId ||
            sceneIndexRef.current !== expectedSceneIndex ||
            sceneFileRef.current !== expectedSceneFile ||
            inspector.drillIn !== LEGACY_MEDIA_DRILL_ROUTE ||
            useDecorationEditStore.getState().selectedId !== legacyId
          ) {
            return;
          }
          legacyImagePromotionRef.current = null;
          useDecorationEditStore.getState().select(null);
          useImageEditStore
            .getState()
            .select({ sceneIndex: expectedSceneIndex, imageId: selection.id });
          setOverviewSelection({
            sceneIndex: expectedSceneIndex,
            rowId: plan.nextRowId ?? mediaRowId(selection.id),
            domain: "media",
          });
          replaceDrill(MEDIA_DRILL_ROUTE);
        })
        .finally(() => endLegacyImageOperation(operationToken));
    };
    const removeLegacyImage = () => {
      if (!legacyId || legacyImageOperationRef.current) return;
      const row: SceneOverviewRowModel = {
        id: legacyMediaRowId(legacyId),
        type: "image",
        label: resolvedDecoration?.src?.split("/").at(-1) ?? "Image",
        selectionTarget: { kind: "legacyImage", id: legacyId },
        openRoute: LEGACY_MEDIA_DRILL_ROUTE,
        readOnly: true,
      };
      const plan = planContentDelete(row, {
        doc: docRef.current ?? doc,
        resolvedDecorations: resolvedDecorationsRef.current,
      });
      if (!plan) return;
      const operationToken = beginLegacyImageOperation();
      if (!operationToken) return;
      void patchDocResultRef
        .current(plan.apply, { history: plan.history })
        .then((succeeded) => {
          const inspector = useUiStore.getState().inspector;
          if (
            !succeeded ||
            legacyImageOperationRef.current !== operationToken ||
            projectIdRef.current !== expectedProjectId ||
            sceneIndexRef.current !== expectedSceneIndex ||
            sceneFileRef.current !== expectedSceneFile ||
            inspector.drillIn !== LEGACY_MEDIA_DRILL_ROUTE ||
            useDecorationEditStore.getState().selectedId !== legacyId
          ) {
            return;
          }
          useDecorationEditStore.getState().select(null);
          closeDrill();
        })
        .finally(() => endLegacyImageOperation(operationToken));
    };
    const unsupportedSource = displayEntry ? !isSceneImageSource(displayEntry.src) : false;
    return (
      <MediaDrillIn
        key={`${project.id}\u0000${expectedSceneFile ?? expectedSceneIndex}\u0000legacy:${legacyId ?? "missing"}`}
        doc={syntheticDoc}
        mediaId={displayEntry?.id ?? ""}
        sourcePreviewUrl={
          displayEntry ? inspectorAssetUrl(project.id, displayEntry.src) : undefined
        }
        overlayAvailable
        backLabel={backLabel}
        onBack={closeDrill}
        onSelectMedia={() => {}}
        onChangeSource={() => {
          if (!legacyId || legacyImageBusy) return;
          openMediaPicker({ kind: "media", mediaKind: "image", legacyId });
        }}
        mutateMedia={mutateLegacyImage}
        sourceButtonRef={imageSourceButtonRef}
        sourceDisabled={legacyImageBusy}
        settingsDisabled={legacyImageBusy || unsupportedSource}
        duplicateDisabled={legacyImageBusy || unsupportedSource}
        removeDisabled={legacyImageBusy}
        onDuplicate={duplicateLegacyImage}
        onRemove={removeLegacyImage}
        patchDoc={patchDoc}
        commitFromBaseline={commitFromBaseline}
        notice={
          error ??
          legacyImageNotice ??
          (unsupportedSource
            ? "This inherited source must be changed to a still PNG, JPEG or WebP before other media edits can take over."
            : "This inherited Overlay image remains unchanged until your first edit.")
        }
      />
    );
  }
  if (isMediaDrillRoute(drillIn) && doc) {
    const currentMediaId =
      selectedImageId === null
        ? (mediaEntries[0]?.id ?? null)
        : mediaEntries.some((entry) => entry.id === selectedImageId)
          ? selectedImageId
          : null;
    const currentEntry = mediaEntries.find((entry) => entry.id === currentMediaId);
    const source = mediaSourceSummary(
      project.id,
      currentEntry?.src,
      currentEntry?.kind,
      currentEntry && currentEntry.src === selectedMediaEntry?.src ? selectedMediaMeta : null,
    );
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const stillEditingMedia = () => {
      const inspector = useUiStore.getState().inspector;
      return (
        projectIdRef.current === expectedProjectId &&
        sceneIndexRef.current === expectedSceneIndex &&
        sceneFileRef.current === expectedSceneFile &&
        inspector.tab === "scene" &&
        isMediaDrillRoute(inspector.drillIn)
      );
    };
    const duplicateCurrentMedia = () => {
      if (!currentMediaId) return;
      let duplicateId: string | null = null;
      void patchDocResult(
        (next) => {
          duplicateId = duplicateSceneMedia(next, currentMediaId);
        },
        { history: "duplicate media" },
      ).then((succeeded) => {
        const createdId = duplicateId;
        if (!succeeded || !createdId) return;
        useImageReconciliationStore.getState().recordOrigin(expectedProjectId, expectedSceneFile, {
          kind: "duplicate",
          imageId: createdId,
          sourceImageId: currentMediaId,
        });
        if (!stillEditingMedia()) return;
        const selected = useImageEditStore.getState().selected;
        if (selected?.sceneIndex !== expectedSceneIndex || selected.imageId !== currentMediaId) {
          return;
        }
        useImageEditStore.getState().select({ sceneIndex: expectedSceneIndex, imageId: createdId });
      });
    };
    const removeCurrentMedia = () => {
      if (!currentMediaId) return;
      let nextMediaId: string | null = null;
      void patchDocResult(
        (next) => {
          nextMediaId = removeSceneMedia(next, currentMediaId);
        },
        { history: "remove media" },
      ).then((succeeded) => {
        if (!succeeded || !stillEditingMedia()) return;
        const selected = useImageEditStore.getState().selected;
        if (
          selected &&
          (selected.sceneIndex !== expectedSceneIndex || selected.imageId !== currentMediaId)
        ) {
          return;
        }
        if (nextMediaId) {
          useImageEditStore
            .getState()
            .select({ sceneIndex: expectedSceneIndex, imageId: nextMediaId });
        } else {
          useImageEditStore.getState().select(null);
          closeDrill();
        }
      });
    };
    return (
      <MediaDrillIn
        key={`${project.id}\u0000${expectedSceneFile ?? expectedSceneIndex}\u0000media:${currentMediaId ?? "missing"}`}
        doc={doc}
        mediaId={currentMediaId ?? ""}
        sourcePreviewUrl={source.previewUrl}
        sourceAspectRatio={source.aspectRatio}
        sourceDetail={source.detail}
        overlayAvailable={sceneFrame !== undefined}
        backLabel={backLabel}
        onBack={closeDrill}
        onSelectMedia={(mediaId) =>
          useImageEditStore.getState().select({ sceneIndex, imageId: mediaId })
        }
        onChangeSource={(mediaId) => {
          const entry = mediaEntries.find((candidate) => candidate.id === mediaId);
          openMediaPicker({
            kind: "media",
            mediaKind: entry?.kind ?? "image",
            replaceId: mediaId,
          });
        }}
        onEditSource={(mediaId) => {
          const entry = mediaEntries.find((candidate) => candidate.id === mediaId);
          if (entry) onOpenEditVideo(sceneIndex, entry.src, "media", entry.id);
        }}
        onDuplicate={duplicateCurrentMedia}
        onRemove={removeCurrentMedia}
        sourceButtonRef={imageSourceButtonRef}
        patchDoc={patchDoc}
        commitFromBaseline={commitFromBaseline}
        notice={error}
      />
    );
  }
  if (drillIn === "device.change" && device) {
    return (
      <DeviceModelDrillIn
        model={resolveAvailableDeviceId(device.model)}
        deviceCount={devices.length}
        deviceLabel={`Device ${
          Math.max(
            0,
            devices.findIndex((d) => d.id === deviceId),
          ) + 1
        }`}
        onBack={closeDrill}
        backLabel={backLabel}
        onSelectModel={(model, applyAll) => {
          if (!deviceId) return;
          const expectedProjectId = project.id;
          const expectedSceneIndex = sceneIndex;
          const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
          const expectedDrillStack = [...useUiStore.getState().inspector.drillStack];
          void changeFirstClassDeviceModel(patchDocResult, deviceId, model, applyAll).then(
            (succeeded) => {
              const inspector = useUiStore.getState().inspector;
              if (
                !succeeded ||
                projectIdRef.current !== expectedProjectId ||
                sceneIndexRef.current !== expectedSceneIndex ||
                sceneFileRef.current !== expectedSceneFile ||
                !deviceSelectionOwnsAction(
                  useDeviceEditStore.getState().selected,
                  expectedSceneIndex,
                  deviceId,
                ) ||
                inspector.tab !== "scene" ||
                inspector.drillStack.join("\u0000") !== expectedDrillStack.join("\u0000")
              ) {
                return;
              }
              closeDrill();
            },
          );
        }}
      />
    );
  }
  if (drillIn === "device" && doc && device && deviceId) {
    // Media, meta and both media actions follow the shared side, so an After edit can never re-point Before's source.
    const sideMedia = deviceRouting.media;
    const screen = mediaSourceSummary(project.id, sideMedia?.src, sideMedia?.kind, deviceMediaMeta);
    return (
      <DeviceDrillIn
        key={`${project.id}\u0000${project.sceneFiles[sceneIndex] ?? sceneIndex}\u0000device`}
        doc={doc}
        deviceId={deviceId}
        backLabel={backLabel}
        screenMediaPreviewUrl={screen.previewUrl}
        screenMediaAspectRatio={screen.aspectRatio}
        screenMediaDetail={screen.detail}
        comparison={
          hasComparison(doc) ? { side: compareSideActive, onSideChange: setCompareSide } : undefined
        }
        onBack={closeDrill}
        onSelectDevice={(id) => {
          pickDevice(id);
          setOverviewSelection({ sceneIndex, rowId: `device:${id}`, domain: "devices" });
        }}
        onChangeDevice={(id) => {
          pickDevice(id);
          openDrill("device.change");
        }}
        onChangeScreenMedia={(id) => {
          if (deviceRouting.mediaTarget === "compareDevice") {
            setCompareMediaDeviceId(id);
            openDrill("compare.media");
            return;
          }
          openMediaPicker({ kind: "device", deviceId: id });
        }}
        onEditScreenMedia={
          deviceRouting.editVideoTarget
            ? (id) => {
                const target = deviceSideRouting(doc, id, compareSide);
                if (target.media?.kind === "video" && target.editVideoTarget) {
                  onOpenEditVideo(sceneIndex, target.media.src, target.editVideoTarget, id);
                }
              }
            : undefined
        }
        onOpenArrangement={(id) => {
          pickDevice(id);
          openDrill("device.position");
        }}
        onDuplicate={duplicateSceneDevice}
        onRemove={removeSceneDevice}
        patchDoc={patchDoc}
        patchDocResult={patchDocResult}
        commitFromBaseline={commitFromBaseline}
        notice={error}
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
        onRemove={removeScreenshotStack}
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
        <DrillBack
          label={backLabel}
          title={objectRowLabel(stagedObject.objectId)}
          onClick={closeDrill}
          actions={
            <>
              <DrillHeaderAction
                kind="duplicate"
                label="Duplicate object"
                disabled={contentActionBusy}
                onClick={() => duplicateSceneObject(stagedObject.id)}
              />
              <DrillHeaderAction
                kind="remove"
                label="Remove object"
                disabled={contentActionBusy}
                onClick={() => removeSceneObject(stagedObject.id)}
              />
            </>
          }
        />
        <div className="inspector-section-body object-drill">
          <DrillGroup label="Gizmo">
            <SegmentedRow
              ariaLabel="Object gizmo mode"
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
        </div>
      </>
    );
  }

  if (drillIn === "device.position" && doc && devices.length > 0) {
    return (
      <ArrangeDevicesDrill
        doc={doc}
        sceneIdentity={`${project.id}\u0000${project.sceneFiles[sceneIndex] ?? sceneIndex}`}
        selectedDeviceId={deviceId ?? null}
        backLabel={backLabel}
        onBack={closeDrill}
        onSelectDevice={pickDevice}
        onOpenDevice={(id) => {
          pickDevice(id);
          const stack = useUiStore.getState().inspector.drillStack;
          if (stack.at(-2) === "device") closeDrill();
          else openDrill("device");
        }}
        patchDoc={patchDoc}
        commitFromBaseline={commitFromBaseline}
      />
    );
  }

  const chartInspectorScreen = chartInspectorScreenForRoute(drillIn);
  if (chartInspectorScreen && doc?.chart) {
    return (
      <ChartDrillIn
        doc={doc}
        theme={sceneTheme ?? project.theme}
        hasPanel={sceneFrame !== undefined}
        panelHostsChart={!!sceneFrame?.chart && sceneFrame.chart.enabled !== false}
        screen={chartInspectorScreen}
        backLabel={backLabel}
        onBack={closeDrill}
        onAddSeries={addChartSeries}
        onOpenFont={() => openDrill("chart.font")}
        onOpenSeries={(seriesId) => openDrill(chartSeriesInspectorRoute(seriesId))}
        onRemoveSeries={removeChartSeries}
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

  if (drillIn === "objects.picker") {
    return (
      <div className="inspector-drill">
        <DrillBack label={backLabel} title="Choose object" onClick={closeObjectPicker} />
        <ObjectPicker embedded onPick={addObjectFromPicker} onCancel={closeObjectPicker} />
      </div>
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
        "device.media": () => openMediaPicker({ kind: "device", deviceId }),
        "device.editVideo": () =>
          device?.media && onOpenEditVideo(sceneIndex, device.media.src, "device", device.id),
        "device.change": () => openDrill("device.change"),
        "device.add": addDevice,
        "objects.add": openObjectPicker,
        "device.duplicate": duplicateDevice,
        "frame.add": addOverlay,
        "device.position": () => openDrill("device.position"),
        // Both paths drill into the builder; it seeds the first layer for scenes without a block.
        "layeredScreenshot.edit": () => openDrill("layeredScreenshot.edit"),
        "layeredScreenshot.add": () => openDrill("layeredScreenshot.edit"),
        "device.remove": () => {
          if (deviceId) removeSceneDevice(deviceId);
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
        "device.change": device ? resolveAvailableDeviceSpec(device.model).name : undefined,
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
        "frame.icon":
          doc && sceneFrame ? managedFrameIconValue(doc, sceneFrame) || "None" : undefined,
        "frame.text": sceneFrame
          ? (ALIGN_OPTIONS.find((a) => a.id === (sceneFrame.textAlign ?? "left"))?.label ?? "Left")
          : undefined,
      }[row.id];
      return (
        <ActionRow
          key={row.id}
          icon={<SceneRowIcon id={row.id} />}
          label={row.label}
          value={value}
          chevron={row.chevron}
          danger={row.danger}
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
  const lightingScreen = drillIn ? LIGHTING_ROUTES[drillIn] : undefined;
  if (lightingScreen && doc) {
    // The after target hands the section a doc view whose lighting is side B's, with write wrappers transplanting the field back.
    const forAfter = lightingTarget === "compareB" && !!doc.compare;
    return (
      <LightingInspectorSection
        doc={forAfter ? comparisonLightingEditorDoc(doc) : doc}
        theme={
          forAfter
            ? (project.compareBThemes[sceneIndex] ?? sceneTheme ?? project.theme)
            : (sceneTheme ?? project.theme)
        }
        projectId={project.id}
        projectLighting={project.projectLighting}
        slot={scene}
        backLabel={backLabel}
        screen={lightingScreen}
        onBack={closeDrill}
        onScreenChange={(screen) => {
          if (screen === "overview") closeDrill();
          else openDrill(LIGHTING_ROUTE_FOR_SCREEN[screen]);
        }}
        sideControls={
          hasComparison(doc) ? (
            // Every lighting screen edits the chosen side, so every one carries the selector.
            <>
              <CompareSideSelector value={compareSideActive} onChange={setCompareSide} />
              {forAfter &&
                lightingScreen === "overview" &&
                doc.compare?.b?.lighting !== undefined && (
                  <div className="inspector-drill-reset">
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        void patchDoc(
                          (next) => {
                            if (next.compare?.b) next.compare.b.lighting = undefined;
                          },
                          { history: "match the before side" },
                        )
                      }
                    >
                      <ComparisonSideIcon side="before" size={14} />
                      Match the before side
                    </button>
                  </div>
                )}
            </>
          ) : undefined
        }
        patchDoc={forAfter ? patchLightingDoc : patchDoc}
        patchDocResult={forAfter ? patchLightingDocResult : patchDocResult}
        commitFromBaseline={forAfter ? commitLightingFromBaseline : commitFromBaseline}
        animationScope={lightingAnimationScope}
        onAnimationScopeChange={setLightingAnimationScope}
        onSeek={(globalMs) => useClockStore.getState().setCurrentMs(globalMs)}
      />
    );
  }
  const groupSection =
    drillIn && drillIn !== "camera" && !drillIn.startsWith("lighting")
      ? sections.find((s) => s.id === drillIn)
      : undefined;
  if (groupSection) {
    return (
      <div className="inspector-drill">
        <DrillBack
          label={backLabel}
          title={
            sceneInspectorScreenTitle(groupSection.id, { deviceCount: devices.length }) ??
            groupSection.label
          }
          onClick={closeDrill}
        />
        <div className="inspector-drill-body inspector-rows">{renderSectionRows(groupSection)}</div>
      </div>
    );
  }

  const sceneOverview = deriveSceneOverview({
    doc,
    frame: sceneFrame,
    durationMs: scene.durationMs,
    slotsCount: project.slots.length,
    themeName: sceneTheme?.name ?? project.theme.name,
    transitionValue,
    fallbackText: derivedName ?? undefined,
    textGroups:
      managedTextModel?.ownership === "managed" || (managedTextModel?.items.length ?? 0) > 0
        ? managedTextGroups.filter((group) => !group.implicit || group.items.length > 0)
        : undefined,
  });
  const hasContent = sceneOverview.groups.length > 0 || sceneOverview.standalone.length > 0;

  const overviewDomain = (row: SceneOverviewRowModel): GizmoDomain | null => {
    switch (row.selectionTarget?.kind) {
      case "text":
        return "text";
      case "device":
        return "devices";
      case "media":
        return "media";
      case "legacyImage":
        return "decorations";
      case "object":
        return "objects";
      case "chart":
        return "chart";
      default:
        return null;
    }
  };

  const selectOverviewRow = (row: SceneOverviewRowModel) => {
    setOverviewSelection({ sceneIndex, rowId: row.id, domain: overviewDomain(row) });
    const target = row.selectionTarget;
    if (!target) return;
    switch (target.kind) {
      case "text": {
        const itemKey = managedTextGroups.find((group) => group.key === target.id)?.itemKeys[0];
        useTextEditStore.getState().select(itemKey ? { sceneIndex, key: itemKey } : null);
        break;
      }
      case "device":
        pickDevice(target.id);
        break;
      case "media":
        useImageEditStore.getState().select({ sceneIndex, imageId: target.id });
        break;
      case "legacyImage": {
        const store = useDecorationEditStore.getState();
        store.setScene(sceneIndex);
        store.select(target.id);
        break;
      }
      case "object":
        setPickedObjectId(target.id);
        useObjectEditStore.getState().select({ sceneIndex, objectId: target.id });
        break;
      case "chart":
        useChartEditStore.getState().select({ sceneIndex });
        break;
      case "screenshotStack":
      case "comparison":
        break;
    }
  };

  const openOverviewRow = (row: SceneOverviewRowModel) => {
    selectOverviewRow(row);
    if (contentPickerOpen) flushSync(() => setContentPickerOpen(false));
    if (row.openRoute) openDrill(row.openRoute);
  };

  const selectPlannedContent = (plan: ContentDocActionPlan) => {
    const target = plan.nextSelection;
    if (!target || !plan.nextRowId) return;
    const domain: GizmoDomain | null =
      target.kind === "text"
        ? "text"
        : target.kind === "device"
          ? "devices"
          : target.kind === "media"
            ? "media"
            : target.kind === "legacyImage"
              ? "decorations"
              : target.kind === "object"
                ? "objects"
                : target.kind === "chart"
                  ? "chart"
                  : null;
    setOverviewSelection({ sceneIndex, rowId: plan.nextRowId, domain });
    switch (target.kind) {
      case "text":
        useTextEditStore.getState().select({ sceneIndex, key: target.id });
        break;
      case "device":
        pickDevice(target.id);
        break;
      case "media":
        useImageEditStore.getState().select({ sceneIndex, imageId: target.id });
        break;
      case "legacyImage": {
        const store = useDecorationEditStore.getState();
        store.setScene(sceneIndex);
        store.select(target.id);
        break;
      }
      case "object":
        setPickedObjectId(target.id);
        useObjectEditStore.getState().select({ sceneIndex, objectId: target.id });
        break;
      case "chart":
        useChartEditStore.getState().select({ sceneIndex });
        break;
      case "screenshotStack":
      case "comparison":
        break;
    }
  };

  const clearOverviewRowSelection = (row: SceneOverviewRowModel) => {
    setOverviewSelection(null);
    const target = row.selectionTarget;
    if (!target) return;
    switch (target.kind) {
      case "text":
        useTextEditStore.getState().select(null);
        break;
      case "device":
        pickDevice(null);
        break;
      case "media":
        useImageEditStore.getState().select(null);
        break;
      case "legacyImage":
        useDecorationEditStore.getState().select(null);
        break;
      case "object":
        setPickedObjectId(null);
        useObjectEditStore.getState().select(null);
        break;
      case "chart":
        useChartEditStore.getState().select(null);
        break;
      case "screenshotStack":
        useLayeredScreenshotEditStore.getState().reset();
        break;
      case "comparison":
        break;
    }
  };

  const isCurrentOverview = (
    expectedProjectId: string,
    expectedSceneIndex: number,
    expectedSceneFile: string | null,
  ) => {
    const inspector = useUiStore.getState().inspector;
    return (
      projectIdRef.current === expectedProjectId &&
      sceneIndexRef.current === expectedSceneIndex &&
      sceneFileRef.current === expectedSceneFile &&
      inspector.tab === "scene" &&
      inspector.drillStack.length === 0
    );
  };

  const focusOverviewAfterMutation = (
    expectedProjectId: string,
    expectedSceneIndex: number,
    expectedSceneFile: string | null,
    rowId: string | null,
  ) => {
    window.requestAnimationFrame(() => {
      if (!isCurrentOverview(expectedProjectId, expectedSceneIndex, expectedSceneFile)) return;
      if (!rowId) {
        contentPickerButtonRef.current?.focus({ preventScroll: true });
        return;
      }
      const matchingRow = [
        ...(overviewRootRef.current?.querySelectorAll<HTMLElement>("[data-overview-row-id]") ?? []),
      ].find((element) => element.dataset.overviewRowId === rowId);
      matchingRow
        ?.querySelector<HTMLButtonElement>(".inspector-scene-overview-entity-body")
        ?.focus({ preventScroll: true });
    });
  };

  const applyCurrentContentPlan = async (
    row: SceneOverviewRowModel,
    action: "duplicate" | "delete",
    expectedProjectId: string,
    expectedSceneIndex: number,
    expectedSceneFile: string | null,
  ) => {
    const pending = contentActionPendingRef.current;
    if (
      (pending?.projectId === expectedProjectId &&
        pending.sceneIndex === expectedSceneIndex &&
        pending.sceneFile === expectedSceneFile) ||
      !isCurrentOverview(expectedProjectId, expectedSceneIndex, expectedSceneFile)
    ) {
      return;
    }
    const currentDoc = docRef.current;
    if (!currentDoc) return;
    const context = {
      doc: currentDoc,
      resolvedDecorations: resolvedDecorationsRef.current,
    };
    const plan =
      action === "duplicate" ? planContentDuplicate(row, context) : planContentDelete(row, context);
    if (!plan) return;
    const actionToken = Symbol("content action");
    contentActionPendingRef.current = {
      token: actionToken,
      projectId: expectedProjectId,
      sceneIndex: expectedSceneIndex,
      sceneFile: expectedSceneFile,
    };
    setContentActionBusy(true);
    let succeeded = false;
    try {
      succeeded = await patchDocResultRef.current(plan.apply, { history: plan.history });
    } finally {
      if (contentActionPendingRef.current?.token === actionToken) {
        contentActionPendingRef.current = null;
        setContentActionBusy(false);
      }
    }
    if (succeeded && action === "duplicate") {
      if (plan.imageOrigins) {
        for (const origin of plan.imageOrigins) {
          useImageReconciliationStore
            .getState()
            .recordOrigin(expectedProjectId, expectedSceneFile, origin);
        }
      } else if (row.selectionTarget?.kind === "media" && plan.nextSelection?.kind === "media") {
        useImageReconciliationStore.getState().recordOrigin(expectedProjectId, expectedSceneFile, {
          kind: "duplicate",
          imageId: plan.nextSelection.id,
          sourceImageId: row.selectionTarget.id,
        });
      }
    }
    if (
      !succeeded ||
      !isCurrentOverview(expectedProjectId, expectedSceneIndex, expectedSceneFile)
    ) {
      return;
    }
    const selection = useUiStore.getState().inspector.overviewSelection;
    if (selection?.sceneIndex !== expectedSceneIndex || selection.rowId !== row.id) return;
    if (action === "duplicate") {
      if (!plan.nextSelection || !plan.nextRowId) return;
      selectPlannedContent(plan);
      focusOverviewAfterMutation(
        expectedProjectId,
        expectedSceneIndex,
        expectedSceneFile,
        plan.nextRowId,
      );
      return;
    }
    clearOverviewRowSelection(row);
    focusOverviewAfterMutation(expectedProjectId, expectedSceneIndex, expectedSceneFile, null);
  };

  const applyManagedTextContentAction = async (
    row: SceneOverviewRowModel,
    action: Extract<ManagedTextStructuralAction, { type: "duplicate-group" | "remove-group" }>,
    expectedProjectId: string,
    expectedSceneIndex: number,
    expectedSceneFile: string | null,
  ) => {
    const target = row.selectionTarget;
    const currentDoc = docRef.current;
    if (
      target?.kind !== "text" ||
      !currentDoc ||
      contentActionPendingRef.current ||
      !isCurrentOverview(expectedProjectId, expectedSceneIndex, expectedSceneFile)
    ) {
      return;
    }
    const token = Symbol("managed-text-content-action");
    contentActionPendingRef.current = {
      token,
      projectId: expectedProjectId,
      sceneIndex: expectedSceneIndex,
      sceneFile: expectedSceneFile,
    };
    setContentActionBusy(true);
    let succeeded = false;
    let selectedItemKey: string | null = null;
    let selectedGroupKey: string | null = null;
    try {
      await performManagedTextStructuralAction({
        doc: currentDoc,
        registrations: textRegistrations,
        virtualOptions: textVirtualOptionsForDoc(currentDoc),
        action,
        confirmTakeover: confirmManagedTextTakeover,
        commit: async (result, history) => {
          selectedItemKey = result.selectedItemKey;
          selectedGroupKey = result.selectedGroupKey;
          const outcome = await writeManagedText({
            preview: result.doc,
            baseline: currentDoc,
            history,
            applyToCurrent: (current) => {
              const applied = applyManagedTextStructuralAction(
                current,
                action,
                textRegistrations,
                textVirtualOptionsForDoc(current),
              );
              if (!applied) return current;
              selectedItemKey = applied.selectedItemKey;
              selectedGroupKey = applied.selectedGroupKey;
              return applied.doc;
            },
          });
          succeeded = outcome !== false;
        },
      });
    } finally {
      if (contentActionPendingRef.current?.token === token) {
        contentActionPendingRef.current = null;
        setContentActionBusy(false);
      }
    }
    if (
      !succeeded ||
      !isCurrentOverview(expectedProjectId, expectedSceneIndex, expectedSceneFile)
    ) {
      return;
    }
    const selection = useUiStore.getState().inspector.overviewSelection;
    if (selection?.sceneIndex !== expectedSceneIndex || selection.rowId !== row.id) return;
    if (selectedGroupKey) {
      const rowId = `text:${selectedGroupKey}`;
      useTextEditStore
        .getState()
        .select(selectedItemKey ? { sceneIndex: expectedSceneIndex, key: selectedItemKey } : null);
      setOverviewSelection({ sceneIndex: expectedSceneIndex, rowId, domain: "text" });
      focusOverviewAfterMutation(expectedProjectId, expectedSceneIndex, expectedSceneFile, rowId);
    } else {
      useTextEditStore.getState().select(null);
      setOverviewSelection(null);
      focusOverviewAfterMutation(expectedProjectId, expectedSceneIndex, expectedSceneFile, null);
    }
  };

  // The Delete key's overview route: the same plan the row menu's Delete runs, resolved from the selected row.
  const deleteSelectedOverviewContent = () => {
    const selection = useUiStore.getState().inspector.overviewSelection;
    if (!selection || selection.sceneIndex !== sceneIndex || !doc || contentActionBusy) return;
    const row = [
      ...sceneOverview.groups.flatMap((group) => group.rows),
      ...sceneOverview.standalone,
    ].find((candidate) => candidate.id === selection.rowId);
    if (!row || !contentMenuActions(row).includes("delete")) return;
    const sceneFile = project.sceneFiles[sceneIndex] ?? null;
    if (row.selectionTarget?.kind === "text") {
      void applyManagedTextContentAction(
        row,
        { type: "remove-group", groupKey: row.selectionTarget.id },
        project.id,
        sceneIndex,
        sceneFile,
      );
      return;
    }
    void applyCurrentContentPlan(row, "delete", project.id, sceneIndex, sceneFile);
  };
  deleteOverviewSelectionRef.current = deleteSelectedOverviewContent;

  const addManagedTextOverviewItem = async () => {
    const currentDoc = docRef.current;
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const expectedNavigationSequence = useUiStore.getState().inspectorNavigation.sequence;
    if (
      !currentDoc ||
      contentActionPendingRef.current ||
      !isCurrentOverview(expectedProjectId, expectedSceneIndex, expectedSceneFile)
    ) {
      return;
    }
    const action: ManagedTextStructuralAction = {
      type: "add-group",
      afterKey: explicitlySelectedTextGroupKey ?? undefined,
    };
    const token = Symbol("add-managed-text");
    contentActionPendingRef.current = {
      token,
      projectId: expectedProjectId,
      sceneIndex: expectedSceneIndex,
      sceneFile: expectedSceneFile,
    };
    setContentActionBusy(true);
    let succeeded = false;
    let selectedItemKey: string | null = null;
    let selectedGroupKey: string | null = null;
    try {
      await performManagedTextStructuralAction({
        doc: currentDoc,
        registrations: textRegistrations,
        virtualOptions: textVirtualOptionsForDoc(currentDoc),
        action,
        confirmTakeover: confirmManagedTextTakeover,
        commit: async (result, history) => {
          selectedItemKey = result.selectedItemKey;
          selectedGroupKey = result.selectedGroupKey;
          const outcome = await writeManagedText({
            preview: result.doc,
            baseline: currentDoc,
            history,
            applyToCurrent: (current) => {
              const applied = applyManagedTextStructuralAction(
                current,
                action,
                textRegistrations,
                textVirtualOptionsForDoc(current),
              );
              if (!applied) return current;
              selectedItemKey = applied.selectedItemKey;
              selectedGroupKey = applied.selectedGroupKey;
              return applied.doc;
            },
          });
          succeeded = outcome !== false;
        },
      });
    } finally {
      if (contentActionPendingRef.current?.token === token) {
        contentActionPendingRef.current = null;
        setContentActionBusy(false);
      }
    }
    if (
      !succeeded ||
      !selectedItemKey ||
      !selectedGroupKey ||
      !isCurrentOverview(expectedProjectId, expectedSceneIndex, expectedSceneFile) ||
      useUiStore.getState().inspectorNavigation.sequence !== expectedNavigationSequence
    ) {
      contentAddActivatorRef.current = null;
      return;
    }
    const rowId = `text:${selectedGroupKey}`;
    useTextEditStore.getState().select({ sceneIndex: expectedSceneIndex, key: selectedItemKey });
    setOverviewSelection({ sceneIndex: expectedSceneIndex, rowId, domain: "text" });
    focusContentAddActivator();
    openDrill("text");
  };

  const openContentMenu = (row: SceneOverviewRowModel, request: SceneOverviewContextRequest) => {
    if (!doc) return;
    selectOverviewRow(row);
    const menuProjectId = project.id;
    const menuSceneIndex = sceneIndex;
    const menuSceneFile = project.sceneFiles[sceneIndex] ?? null;
    const context = { doc, resolvedDecorations: sceneFrame?.decorations };
    const duplicatePlan = planContentDuplicate(row, context);
    const deletePlan = planContentDelete(row, context);
    const managedTextTarget = row.selectionTarget?.kind === "text";
    const items: ContextMenuState["items"] = [];
    for (const action of contentMenuActions(row)) {
      const label: Record<ContentMenuAction, string> = {
        edit: "Edit",
        duplicate: "Duplicate",
        delete: "Delete",
      };
      if (action === "edit") {
        items.push({
          id: `${row.id}:edit`,
          label: label[action],
          icon: <SceneRowIcon id="content.edit" />,
          onSelect: () => {
            if (
              projectIdRef.current === menuProjectId &&
              sceneIndexRef.current === menuSceneIndex &&
              sceneFileRef.current === menuSceneFile
            ) {
              openOverviewRow(row);
            }
          },
        });
      } else if (action === "duplicate" && (duplicatePlan || managedTextTarget)) {
        items.push({
          id: `${row.id}:duplicate`,
          label: label[action],
          icon: <SceneRowIcon id="content.duplicate" />,
          disabled: contentActionBusy,
          title: contentActionBusy ? "Another content change is finishing" : undefined,
          onSelect: () => {
            if (row.selectionTarget?.kind === "text") {
              void applyManagedTextContentAction(
                row,
                { type: "duplicate-group", groupKey: row.selectionTarget.id },
                menuProjectId,
                menuSceneIndex,
                menuSceneFile,
              );
            } else {
              void applyCurrentContentPlan(
                row,
                "duplicate",
                menuProjectId,
                menuSceneIndex,
                menuSceneFile,
              );
            }
          },
        });
      } else if (action === "delete" && (deletePlan || managedTextTarget)) {
        if (items.length > 0) items.push("separator");
        items.push({
          id: `${row.id}:delete`,
          label: label[action],
          icon: <SceneRowIcon id="content.delete" />,
          danger: true,
          confirmLabel: "Really delete?",
          disabled: contentActionBusy,
          title: contentActionBusy ? "Another content change is finishing" : undefined,
          onSelect: () => {
            if (row.selectionTarget?.kind === "text") {
              void applyManagedTextContentAction(
                row,
                { type: "remove-group", groupKey: row.selectionTarget.id },
                menuProjectId,
                menuSceneIndex,
                menuSceneFile,
              );
            } else {
              void applyCurrentContentPlan(
                row,
                "delete",
                menuProjectId,
                menuSceneIndex,
                menuSceneFile,
              );
            }
          },
        });
      }
    }
    setContentMenu({
      key: `${sceneIndex}:${row.id}`,
      ariaLabel: `Actions for ${row.label}`,
      x: request.x,
      y: request.y,
      returnFocus: request.returnFocus,
      items,
    });
  };

  const addOptionFor = (type: SceneOverviewContentType) =>
    sceneOverview.addOptions.find((option) => option.id === type);

  const addOverviewContent = (type: SceneOverviewContentType) => {
    const option = addOptionFor(type);
    if (!option || option.disabled || contentActionBusy) return;
    const run = () => {
      switch (type) {
        case "device":
          captureContentAddActivator();
          addDevice();
          break;
        case "text":
          captureContentAddActivator();
          void addManagedTextOverviewItem();
          break;
        case "image":
          captureContentAddActivator();
          openMediaPicker({ kind: "media", mediaKind: "image" });
          break;
        case "video":
          captureContentAddActivator();
          openMediaPicker({ kind: "media", mediaKind: "video" });
          break;
        case "object":
          openObjectPicker();
          break;
        case "chart":
          captureContentAddActivator();
          addChart();
          break;
        case "screenshotStack":
          openDrill("layeredScreenshot.edit");
          break;
        case "comparison":
          captureContentAddActivator();
          addCompare();
          break;
      }
    };
    if (!contentPickerOpen) {
      run();
      return;
    }
    const expectedProjectId = project.id;
    const expectedSceneIndex = sceneIndex;
    const expectedSceneFile = project.sceneFiles[sceneIndex] ?? null;
    deferSceneOverviewPickerAction({
      close: () => setContentPickerOpen(false),
      restoreFocus: () => contentPickerButtonRef.current?.focus({ preventScroll: true }),
      schedule: (action) => {
        if (contentPickerActionFrameRef.current !== null) {
          window.cancelAnimationFrame(contentPickerActionFrameRef.current);
        }
        contentPickerActionFrameRef.current = window.requestAnimationFrame(() => {
          contentPickerActionFrameRef.current = null;
          action();
        });
      },
      action: () => {
        const inspector = useUiStore.getState().inspector;
        if (
          projectIdRef.current !== expectedProjectId ||
          sceneIndexRef.current !== expectedSceneIndex ||
          sceneFileRef.current !== expectedSceneFile ||
          inspector.tab !== "scene" ||
          inspector.drillIn !== null
        ) {
          return;
        }
        run();
      },
    });
  };

  const overviewContentIcon = (type: SceneOverviewContentType): ReactNode => {
    switch (type) {
      case "text":
        return <SceneRowIcon id="text.edit" />;
      case "device":
        return <SceneRowIcon id="device.change" />;
      case "image":
        return <SceneRowIcon id="frame.decorations" />;
      case "video":
        return <SceneRowIcon id="videoWindow.edit" />;
      case "object":
        return <SceneRowIcon id="objects.edit" />;
      case "chart":
        return <SceneRowIcon id="chart.edit" />;
      case "screenshotStack":
        return <SceneRowIcon id="layeredScreenshot.edit" />;
      case "comparison":
        return <SceneRowIcon id="compare.edit" />;
    }
  };

  const overviewRowLeading = (row: SceneOverviewRowModel): ReactNode => {
    const mediaSrc = row.thumbnail ?? row.mediaHint?.src;
    if (mediaSrc && (row.thumbnail || row.mediaHint?.kind === "image")) {
      const src = inspectorAssetUrl(project.id, mediaSrc);
      return (
        <img
          className="inspector-scene-overview-thumbnail"
          src={src}
          width={20}
          height={14}
          alt=""
          draggable={false}
        />
      );
    }
    const target = row.selectionTarget;
    if (target?.kind === "device") {
      const matched = devices.find((candidate) => candidate.id === target.id);
      if (matched) return <DevicePillIcon model={matched.model} />;
    }
    return overviewContentIcon(row.type as SceneOverviewContentType);
  };

  const overviewSettingIcon = (row: SceneOverviewRowModel): ReactNode => {
    switch (row.type) {
      case "overlay":
        return <SceneRowIcon id="frame" />;
      case "theme":
        return <SceneRowIcon id="style.theme" />;
      case "background":
        return <SceneRowIcon id="style.background" />;
      case "camera":
        return <SceneRowIcon id="camera.animate" />;
      case "lighting":
        return <SceneRowIcon id="lighting" />;
      case "transition":
        return <SceneRowIcon id="motion.transition" />;
      default:
        return <SceneRowIcon id="motion.duration" />;
    }
  };

  const openOverviewSetting = (row: SceneOverviewRowModel) => {
    if (!row.openRoute) return;
    if (contentPickerOpen) flushSync(() => setContentPickerOpen(false));
    switch (row.type) {
      case "overlay":
        if (!sceneFrame) addOverlay();
        break;
      case "theme":
        setThemeDraft(doc?.themeId ?? "");
        break;
      case "background":
        setBgTabOverride(null);
        break;
      case "transition":
        void listCachedSceneThumbs(project).then(setThumbs);
        break;
    }
    openDrill(row.openRoute);
  };

  const pickerItems: SceneOverviewPickerItem[] = sceneOverview.addOptions.map((option) => ({
    id: option.id,
    label: option.label,
    icon: overviewContentIcon(option.id),
    disabledReason: contentActionBusy
      ? "Another content change is finishing"
      : option.disabledReason,
    onPick: () => addOverviewContent(option.id),
  }));

  const settingDisabledReason = (row: SceneOverviewRowModel): string | undefined => {
    if (row.openRoute) return undefined;
    if (row.type === "transition") return "Add another scene first";
    return "Scene document unavailable";
  };

  const renderOverviewEntity = (row: SceneOverviewRowModel) => (
    <SceneOverviewEntityRow
      key={row.id}
      rowId={row.id}
      domain={row.selectionTarget?.kind ?? row.type}
      label={row.label}
      value={row.value}
      leading={overviewRowLeading(row)}
      selected={overviewSelection?.rowId === row.id}
      onOpen={() => openOverviewRow(row)}
      onContextMenu={(request) => openContentMenu(row, request)}
    />
  );

  return (
    <div
      ref={overviewRootRef}
      className="inspector-scene-overview"
      aria-busy={contentActionBusy || undefined}
    >
      {header}
      <section className="inspector-scene-overview-section inspector-scene-overview-content">
        <div
          className="inspector-scene-overview-content-head"
          ref={contentPickerAnchorRef}
          onPointerDownCapture={() => {
            contentPickerPointerDownRef.current = true;
          }}
          onBlurCapture={(event) => {
            const anchor = event.currentTarget;
            const next = event.relatedTarget;
            const focusStaysInside = next instanceof Node && anchor.contains(next);
            if (
              shouldCloseSceneOverviewPickerOnBlur({
                focusStaysInside,
                internalPointerDown: contentPickerPointerDownRef.current,
              })
            ) {
              closeContentPicker();
            }
          }}
        >
          <SceneOverviewSectionHeader
            label="Content"
            addLabel={contentPickerOpen ? "Close content picker" : "Add content"}
            addText="Add"
            expanded={contentPickerOpen}
            controls="scene-content-picker"
            addButtonRef={contentPickerButtonRef}
            addDisabled={contentActionBusy}
            addTitle={contentActionBusy ? "Another content change is finishing" : undefined}
            onAdd={() => setContentPickerOpen((open) => !open)}
          />
          {contentPickerOpen && (
            <SceneOverviewPicker id="scene-content-picker" items={pickerItems} />
          )}
        </div>
        <div className="inspector-scene-overview-content-scroll" ref={contentScrollRef}>
          {unrenderableChars.size > 0 && (
            <p className="inspector-text-warning">
              {`Some characters can't render in this scene's fonts: ${[...unrenderableChars].join("  ")}`}
            </p>
          )}
          {!doc && (
            <p className="inspector-stub-note">
              This scene has no scene document yet, so its text, media and style can't be edited
              here. Ask Claude to add one in the terminal, or edit the scene file directly.
            </p>
          )}
          {!hasContent && (
            <div className="inspector-scene-overview-empty">
              <div className="inspector-scene-overview-empty-title">Nothing in this scene yet</div>
              <div className="inspector-scene-overview-empty-description">
                Add something and it appears here for selection and editing.
              </div>
            </div>
          )}
          <div className="inspector-scene-overview-groups">
            {sceneOverview.groups.map((group) => {
              const addOption = addOptionFor(group.addType);
              return (
                <div
                  key={group.id}
                  className={`inspector-scene-overview-group inspector-scene-overview-group-${group.id}`}
                >
                  <SceneOverviewGroupHeader
                    label={group.label}
                    icon={overviewContentIcon(group.addType)}
                    onOpen={group.id === "devices" ? () => openDrill("device.position") : undefined}
                    openLabel={group.id === "devices" ? "Arrange devices" : undefined}
                    addLabel={`Add ${addOption?.label.toLowerCase() ?? group.label.toLowerCase()}`}
                    addDisabled={contentActionBusy || addOption?.disabled}
                    addTitle={
                      contentActionBusy
                        ? "Another content change is finishing"
                        : addOption?.disabledReason
                    }
                    onAdd={() => addOverviewContent(group.addType)}
                  />
                  <div className="inspector-scene-overview-group-rows">
                    {group.rows.map(renderOverviewEntity)}
                  </div>
                </div>
              );
            })}
          </div>
          {sceneOverview.standalone.length > 0 && (
            <div className="inspector-scene-overview-standalone">
              {sceneOverview.standalone.map(renderOverviewEntity)}
            </div>
          )}
          {error && <p className="inspector-error">{error}</p>}
        </div>
      </section>

      <section className="inspector-scene-overview-section inspector-scene-overview-settings">
        <SceneOverviewSectionHeader label="Scene" />
        <div className="inspector-scene-overview-setting-rows">
          {sceneOverview.settings.map((row) =>
            row.type === "duration" ? (
              <div
                key={row.id}
                className="inspector-scene-overview-duration"
                data-overview-row-id={row.id}
                data-overview-domain="duration"
              >
                <DurationRow
                  durationMs={scene.durationMs}
                  mode={durationMode}
                  onCommit={(ms) => void commitDuration(ms)}
                />
              </div>
            ) : (
              <SceneOverviewSettingRow
                key={row.id}
                rowId={row.id}
                label={row.label}
                value={row.value}
                icon={overviewSettingIcon(row)}
                disabled={row.openRoute === null}
                disabledReason={settingDisabledReason(row)}
                onOpen={() => openOverviewSetting(row)}
              />
            ),
          )}
        </div>
      </section>

      <div className="inspector-scene-overview-delete-footer">
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
      </div>

      {contentMenu && (
        <ContextMenu
          key={contentMenu.key}
          menu={contentMenu}
          onClose={() => setContentMenu(null)}
        />
      )}
    </div>
  );
}
