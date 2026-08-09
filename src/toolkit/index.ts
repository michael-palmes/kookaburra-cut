/** `@kookaburra/toolkit`, the SHIPPED authoring surface; scene files import everything from here. See .agents/skills/kookaburra-scene-authoring for the authoring rules. */

export { useFormat } from "../engine/format";
// Seeded RNG for generative geometry; scenes must never call Math.random.
export { createSeededRandom, type SeededRandom } from "../engine/rng";
// The resolved sidecar chart block: every default baked and the data track sorted.
export type { ResolvedChart } from "../engine/sceneChart";
// Scene-document hooks: the sidecar-driven text map, devices array, layered-screenshot and chart blocks.
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
// Shared-element morph sampling for persistent (hoisted) modules.
export {
  type SharedKeyframe,
  type SharedTransform,
  sampleSharedTransform,
} from "../engine/sharedElement";
// Time / format / theme hooks
export { useTimeline } from "../engine/timeline";
export { useTheme } from "../theme";
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
export { liftColour } from "./colour";
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
export { resolveDeviceLayout } from "./device/layout";
// Icon + text lockups animated as one unit through the text presets.
export { AnimatedGroup, type AnimatedGroupProps } from "./group/AnimatedGroup";
export { type GroupAnimationState, useGroupAnimation } from "./group/context";
// Product/hero glTF geometry on a lit set.
export { HeroObject, type HeroObjectProps } from "./hero/HeroObject";
// Shared light rig for lit primitives (mount once per scene, pass lit={false} to primitives)
export { LightRig } from "./lighting/LightRig";
// Flat image plane for icons/logos/stills: unlit, colour-exact, PNG alpha.
export { ImageCard, type ImageCardProps } from "./media/ImageCard";
export { LayeredScreenshot, type LayeredScreenshotProps } from "./media/LayeredScreenshot";
export { VideoClip, type VideoClipProps } from "./media/VideoClip";
// A macOS screen recording as a floating window over a backing stage, animated in 3D.
export { VideoWindow, type VideoWindowProps } from "./media/VideoWindow";
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
// Generative shapes: all randomness via createSeededRandom, all motion via the clock.
export { ParticleField, type ParticleFieldProps } from "./shapes/ParticleField";
export { Ribbon, type RibbonProps } from "./shapes/Ribbon";
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
export { SceneStage } from "./stage/SceneStage";
export { AnimatedCounter, type AnimatedCounterProps } from "./text/AnimatedCounter";
// Text primitives
export { AnimatedHeadline, type AnimatedHeadlineProps } from "./text/AnimatedHeadline";
// Horizontal app-icon + title/subtitle lockup revealed as one unit.
export { BrandLockup, type BrandLockupProps } from "./text/BrandLockup";
// Text-animation presets: theme `textAnimation` defaults + per-primitive overrides.
export {
  isTextPresetName,
  type StaggerGranularity,
  TEXT_PRESET_NAMES,
  type TextPresetName,
} from "./text/presets";
// Title + optional subtitle with theme-scale sizing and safe-area alignment.
export { TitleBlock, type TitleBlockProps } from "./text/TitleBlock";
// Extruded 3D text.
export { ExtrudedText, type ExtrudedTextProps } from "./text3d/ExtrudedText";
// Transition helpers
export { fade } from "./transitions/fade";
export { slide } from "./transitions/slide";
export type { EaseName, FormatInfo, SceneModule, SceneProps, SceneTime, V3 } from "./types";
