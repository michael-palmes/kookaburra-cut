/** `@kookaburra/toolkit`, the SHIPPED authoring surface; scene files import everything from here. See .agents/skills/kookaburra-scene-authoring for the authoring rules. */

// Named eases (the camera and text presets' curves) for code-authored motion.
export { EASE_NAMES, type EaseOptions, ease, easeFn, isEaseName } from "../engine/ease";
export { frameAtDepth, useFormat } from "../engine/format";
// project.json `shared`: author constants every scene reads.
export { type ProjectShared, useProjectShared } from "../engine/projectShared";
// Seeded RNG for generative geometry; scenes must never call Math.random.
export { createSeededRandom, type SeededRandom } from "../engine/rng";
// The resolved sidecar chart block: every default baked and the data track sorted.
export type { ResolvedChart } from "../engine/sceneChart";
// Scene-document hooks: sidecar-driven text ownership, devices, layered screenshots and charts.
export {
  type SceneDeviceProps,
  useSceneChart,
  useSceneDevices,
  useSceneDoc,
  useSceneLayeredScreenshot,
  useSceneObjects,
  useSceneText,
} from "../engine/sceneDoc";
export type {
  SceneDoc,
  SceneDocDeviceSpec,
  SceneDocDuration,
  SceneDocObjectSpec,
  SceneTextAlign,
} from "../engine/sceneDocSchema";
// What useRoom returns: the room colour, any flood in progress and the room's lighting pose.
export type { RoomFloodSample, RoomSample } from "../engine/sceneRoom";
// Shared-element morph sampling for persistent (hoisted) modules.
export {
  type SharedKeyframe,
  type SharedTransform,
  sampleSharedTransform,
} from "../engine/sharedElement";
// Time / format / theme hooks
export { useTimeline } from "../engine/timeline";
export { useTheme } from "../theme";
// Text metrics from the parsed faces: size a pill or underline to a headline without capturing frames.
export { type MeasureTextOptions, measureText, type TextMetrics } from "../theme/fontMetrics";
export type { Theme } from "../theme/tokens";
// Data charts: `<Chart />` draws the sidecar block, flat or as staged 3D solids; the fallback covers scenes that never mount it.
export { Chart, type ChartProps } from "./chart/Chart";
export { Chart2D, type Chart2DProps } from "./chart/Chart2D";
export { Chart3D } from "./chart/Chart3D";
export { ChartFallback } from "./chart/ChartFallback";
export type {
  ChartAnimationConfig,
  ChartAxisConfig,
  ChartConfig,
  ChartData,
  ChartDimension,
  ChartLabelConfig,
  ChartLayout,
  ChartMount,
  ChartRendererProps,
  ChartReveal,
  ChartRevealFn,
  ChartSeries,
  ChartStyle,
  ChartType,
  ChartValueFormat,
} from "./chart/types";
// Scene registration + types
export { cssOpacity, glowColour, liftColour } from "./colour";
export { defineScene } from "./defineScene";
// The device catalog + Device primitive, the device+media pillar.
export {
  AVAILABLE_DEVICE_IDS,
  DEFAULT_DEVICE_ID,
  DEVICE_AVAILABILITY,
  DEVICE_CATALOG,
  DEVICE_IDS,
  type DeviceColourSpec,
  type DeviceForm,
  type DeviceId,
  type DeviceScreenRect,
  type DeviceSpec,
  deviceColour,
  FALLBACK_DEVICE_ID,
  isDeviceAvailable,
  isDeviceId,
  preloadCatalogModels,
  resolveAvailableDeviceId,
  resolveAvailableDeviceSpec,
} from "./device/catalog";
export {
  Device,
  type DeviceMediaSpec,
  type DeviceMotionPreset,
  type DeviceMotionSpec,
  type DevicePlacement,
  type DeviceProps,
  type DeviceShadowMode,
} from "./device/Device";
// DeviceMockup is the legacy (pre-catalog) device primitive; prefer Device for new scenes.
export { DeviceMockup, type DeviceMockupProps } from "./device/DeviceMockup";
// Screen anchors: pin content to a device's screen from committed measurements of each model.
export {
  type DeviceScreen,
  DeviceScreenAnchor,
  type DeviceScreenAnchorProps,
  useDeviceScreen,
} from "./device/DeviceScreenAnchor";
export { resolveDeviceLayout } from "./device/layout";
export {
  type DeviceScreenDisplay,
  type DeviceScreenHinge,
  type DeviceScreenPose,
  deviceScreenLocal,
  deviceScreenPoint,
  deviceScreenRect,
  mediaPixelToScreenUv,
  SCREEN_LIFT,
  screenUvToMediaPixel,
} from "./device/screenAnchor";
// Icon + text lockups animated as one unit through the text presets.
export { AnimatedGroup, type AnimatedGroupProps } from "./group/AnimatedGroup";
export { type GroupAnimationState, useGroupAnimation } from "./group/context";
// Product/hero glTF geometry on a lit set.
export { HeroObject, type HeroObjectProps } from "./hero/HeroObject";
// Shared light rig for lit primitives (mount once per scene, pass lit={false} to primitives)
export { LightRig } from "./lighting/LightRig";
// Flat image plane for icons/logos/stills: unlit, colour-exact, PNG alpha.
export { type HardShadowSpec, ImageCard, type ImageCardProps } from "./media/ImageCard";
export { LayeredScreenshot, type LayeredScreenshotProps } from "./media/LayeredScreenshot";
export { VideoClip, type VideoClipProps } from "./media/VideoClip";
// A macOS screen recording as a floating window over a backing stage, animated in 3D.
export { VideoWindow, type VideoWindowProps } from "./media/VideoWindow";
// Per-subtree motion blur scale for code-authored motion (sidecar items use their own motionBlur field).
export { MotionBlur } from "./motion/MotionBlur";
// Motion helpers: eased ramps, keyed tracks and the stamp pop, all pure functions of the clock.
export { clamp01, lerp, ramp } from "./motion/math";
// Stamps children in with the stampScale pop; the extension is explicit because "./motion/Stamp" finds stamp.ts on a case-insensitive disk.
export { Stamp, type StampProps } from "./motion/Stamp.tsx";
export { type MotionKey, type SampleKeysOptions, sampleKeys } from "./motion/sampleKeys";
export { type StampScaleOptions, stampScale } from "./motion/stamp";
// The 3D objects library: bundled + workspace manifests, staged by the sidecar `objects` array.
export { ObjectsFallback, StagedObject } from "./objects/ObjectPrimitive";
export { preloadSceneObjects } from "./objects/preload";
export {
  importObject,
  isWorkspaceObjectId,
  listObjects,
  type ResolvedObjectAsset,
  resolveObject,
  resolveObjectAsset,
  WORKSPACE_OBJECT_PREFIX,
} from "./objects/registry";
export {
  type ObjectLicence,
  type ObjectManifest,
  parseObjectManifest,
} from "./objects/schema";
// Dashed rules and brackets, tiled split fields (the sidecar `mosaic`), tap rings (the sidecar `taps`) and a travelling cursor.
export { Cursor, type CursorKey, type CursorProps } from "./shapes/Cursor";
export {
  DashedBracket,
  type DashedBracketProps,
  type DashedBracketSide,
  DashedRule,
  type DashedRuleProps,
} from "./shapes/DashedRule";
// Generative shapes: all randomness via createSeededRandom, all motion via the clock.
export { ParticleField, type ParticleFieldProps } from "./shapes/ParticleField";
export { Ribbon, type RibbonProps } from "./shapes/Ribbon";
// Flat, colour-exact rounded rectangles and pills.
export { Pill, type PillProps, RoundedRect, type RoundedRectProps } from "./shapes/RoundedRect";
export {
  MosaicFallback,
  SplitField,
  type SplitFieldProps,
  type SplitFieldTile,
} from "./shapes/SplitField";
export { TapRing, type TapRingProps, TapsFallback } from "./shapes/TapRing";
export { WireGrid, type WireGridProps } from "./shapes/WireGrid";
export { useSceneStaged } from "./stage/context";
// Theme-driven stage: lights the scene from theme.lighting tokens; staged primitives' bundled lit sets stand down automatically (useSceneStaged).
export {
  DEPTH_BANDS,
  type DepthBand,
  type DepthBandName,
  DepthStage,
  useDepthBand,
  useRigTrack,
} from "./stage/DepthStage";
// Rooms: the scene's backdrop colour cutting or flooding mid-scene (the sidecar `room` block, or composed by hand).
export {
  Room,
  RoomFlood,
  type RoomFloodProps,
  type RoomProps,
  useRoom,
} from "./stage/Room";
export { SceneStage } from "./stage/SceneStage";
// The scene camera's live pose, and the world rectangle it sees at a depth.
export { type SceneCamera, useCameraFrame, useSceneCamera } from "./stage/sceneCamera";
export { AnimatedCounter, type AnimatedCounterProps } from "./text/AnimatedCounter";
// Text primitives
export { AnimatedHeadline, type AnimatedHeadlineProps } from "./text/AnimatedHeadline";
// Horizontal app-icon + title/subtitle lockup revealed as one unit.
export { BrandLockup, type BrandLockupProps } from "./text/BrandLockup";
export { ManagedTextStack, type ManagedTextStackProps } from "./text/ManagedTextStack";
// Chat-style prompt bar whose text types in, with a caret and a send button.
export { PromptBar, type PromptBarProps } from "./text/PromptBar";
// Text-animation presets: theme `textAnimation` defaults + per-primitive overrides.
export {
  isTextPresetName,
  type StaggerGranularity,
  TEXT_PRESET_NAMES,
  type TextPresetName,
} from "./text/presets";
// Title + optional subtitle with theme-scale sizing and safe-area alignment.
export { TitleBlock, type TitleBlockProps } from "./text/TitleBlock";
export { type TextMetricsOptions, useTextMetrics } from "./text/useTextMetrics";
// Extruded 3D text.
export { ExtrudedText, type ExtrudedTextProps } from "./text3d/ExtrudedText";
// Transition helpers
export { fade } from "./transitions/fade";
export { slide } from "./transitions/slide";
export type { EaseName, FormatInfo, SceneModule, SceneProps, SceneTime, V3 } from "./types";
