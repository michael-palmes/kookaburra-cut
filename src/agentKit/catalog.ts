/** The agent kit catalogue: every id an agent may write into a project, read from the live registries so the shipped skill can never drift from the code. `pnpm agent:catalog` writes it to the skill folder; `catalog.test.ts` fails when the committed copy is stale. Contract: docs/agent-kit.md ("The catalogue"). */

import { CAMERA_PRESETS, type PresetContext } from "../engine/cameraPresets";
import { COMPARE_GRIP_CATALOG, COMPARE_MASK_CATALOG } from "../engine/compareCatalog";
import { COMPARE_PRESETS } from "../engine/comparePresets";
import type { DofMode } from "../engine/dof";
import { EASE_FAMILIES, EASE_NAMES } from "../engine/ease";
import { BUNDLED_ENVIRONMENT_IDS, NONE_SOURCE, SOFTBOX_SOURCE } from "../engine/environments";
import { type AspectName, aspectLabel, CAMERA, computeFormat, FORMATS } from "../engine/format";
import { KELVIN_MAX, KELVIN_MIN } from "../engine/kelvin";
import { allowedSpecifiers } from "../engine/moduleRegistry";
import { MOTION_BLUR_AMOUNT_MAX, SAMPLE_PRESETS, SHUTTER_PRESETS } from "../engine/motionBlur";
import { listPresets } from "../engine/presets";
import type { ProjectManifest } from "../engine/project";
import { EXPOSURE_MAX, EXPOSURE_MIN, type ToneMappingId } from "../engine/renderSettings";
import {
  DEVICE_LAYOUT_PRESETS,
  type DeviceLayoutPreset,
  MANAGED_TEXT_MARKERS,
  SCENE_DOC_VERSION,
  SCENE_MEDIA_MOTION_PRESETS,
  type SceneDoc,
  type SceneManagedTextMarker,
  type SceneMediaMotionPreset,
} from "../engine/sceneDocSchema";
import { FIXTURE_MAX_COUNT, MAX_SCENE_LIGHTS, MAX_SHADOW_CASTERS } from "../engine/sceneLighting";
import { TERMINAL_THEME_PRESETS } from "../engine/sceneTerminalTheme";
import type { TransitionEase } from "../engine/sceneTimeline";
import {
  SHUTTER_DEG_DEFAULT,
  SHUTTER_DEG_MAX,
  SHUTTER_SAMPLE_COUNTS,
  SHUTTER_SAMPLES_DEFAULT,
} from "../engine/shutter";
import { listTemplates } from "../engine/templates";
import { FEEL_LABELS, TRANSITION_CATALOG } from "../engine/transitionCatalog";
import { BUILTIN_THEME_CATALOGUE, THEME_CATEGORIES } from "../theme/catalogue";
import { formatFontString } from "../theme/fontRef";
import { BUNDLED_FONTS } from "../theme/fonts";
import { GRADIENT_PRESETS } from "../theme/gradientPresets";
import type {
  EffectsConfig,
  FixtureForm,
  LightSpace,
  LightSpec,
  ThemeBackdrop,
  ThemeBackground,
} from "../theme/tokens";
import * as toolkit from "../toolkit";
import { CHART_ANIMATION_PRESET_IDS, CHART_ANIMATION_PRESETS } from "../toolkit/chart/animation";
import { CHART_PALETTE_SCHEME_IDS, CHART_PALETTE_SCHEMES } from "../toolkit/chart/paletteSchemes";
import {
  CHART_STYLE_DEFAULT_ID,
  CHART_STYLE_PRESET_IDS,
  CHART_STYLE_PRESETS,
} from "../toolkit/chart/stylePresets";
import type { ChartMount } from "../toolkit/chart/types";
import {
  CUSTOM_COLOUR_PREFIX,
  DEVICE_CATALOG,
  DEVICE_IDS,
  FALLBACK_DEVICE_ID,
} from "../toolkit/device/catalog";
import type { DeviceMediaSpec, DeviceMotionPreset } from "../toolkit/device/Device";
import { DEVICE_SHADOW_CHOICES, DEVICE_SHADOW_MODES } from "../toolkit/device/shadowProjector";
import { CHIP_ICON_IDS } from "../toolkit/frame/chipIcons";
import toolkitIndexSource from "../toolkit/index.ts?raw";
import { LIGHTING_PRESETS } from "../toolkit/lighting/presets";
import { builtinObjects } from "../toolkit/objects/registry";
import { BUNDLED_BACKDROP_NAMES } from "../toolkit/stage/backdrops";
import {
  SCENE3D_BACKGROUND_IDS,
  SCENE3D_BACKGROUND_PRESETS,
  SCENE3D_BACKGROUNDS,
  SCENE3D_FAMILY_NAMES,
} from "../toolkit/stage/scene3d";
import {
  SHADER_BACKGROUND_IDS,
  SHADER_BACKGROUND_PRESETS,
  SHADER_BACKGROUNDS,
} from "../toolkit/stage/shaders";
import { resolveTextAnimation, type TextPresetName } from "../toolkit/text/presets";
import { CHART_TYPE_LABELS } from "../ui/inspectorOptions";
import {
  DELIVERY_DEFAULT_MS,
  DELIVERY_OPTIONS,
  TEXT_PRESET_CATALOG,
} from "../ui/textAnimationOptions";
import { TEXT_LOOK_CATALOG } from "../ui/textLookOptions";

/** Bump when the catalogue's SHAPE changes (kb reads it). */
export const AGENT_CATALOG_VERSION = 1;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Entry = Record<string, unknown>;

// ── Hand-written vocabulary the registries do not carry (exhaustive by type, validated against the parsers in catalog.test.ts) ──

/** One line per sidecar top-level key; `Record<keyof SceneDoc>` makes tsc fail when the schema gains a key this table lacks. */
export const SCENE_DOC_KEYS: Record<
  keyof SceneDoc,
  { summary: string; type: string; ref: string; values?: string[]; legacy?: true }
> = {
  version: { summary: "Schema version; always 1.", type: "number", ref: "sidecar" },
  name: { summary: "Display name in pickers and the inspector.", type: "string", ref: "sidecar" },
  duration: {
    summary:
      "manual, or follow-media (the app keeps project.json durationMs equal to a video's length).",
    type: "object",
    ref: "media",
    values: ["manual", "follow-media"],
  },
  text: {
    summary: "Code-owned and embedded copy keyed for useSceneText; mirrors managed items.",
    type: "object<string,string>",
    ref: "text",
  },
  textLayout: {
    summary: "{ align } for TitleBlock and the host title fallback.",
    type: "object",
    ref: "text",
    values: ["left", "center", "right"],
  },
  textStyle: {
    summary:
      "Per text key overrides: <key>Color, Font, Size, OffsetX, OffsetY, LineHeight, RotationDeg.",
    type: "object",
    ref: "text",
  },
  headerIcon: {
    summary: "Emoji or assets/ image drawn above the title on a non-overlay scene.",
    type: "string",
    ref: "text",
  },
  managedText: {
    summary: "Inspector-owned ordered text items (title, subtitle, bullets, icon) and groups.",
    type: "object",
    ref: "text",
  },
  devices: {
    summary: "Devices with screen media, placement, motion and shadow.",
    type: "array",
    ref: "devices",
  },
  media: {
    summary: "Images and videos hosted on the stage, the overlay or as a floating window.",
    type: "array",
    ref: "media",
  },
  images: {
    summary: "Legacy still images; read forward into media. Never author.",
    type: "array",
    ref: "media",
    legacy: true,
  },
  deviceLayout: {
    summary: "Multi-device arrangement preset resolved per aspect.",
    type: "object",
    ref: "devices",
    values: [...DEVICE_LAYOUT_PRESETS],
  },
  deviceTrack: {
    summary: "Keyframed device poses (deltas on the resolved placement).",
    type: "object",
    ref: "devices",
  },
  objects: {
    summary: "Staged 3D objects from the object library.",
    type: "array",
    ref: "devices",
  },
  camera: {
    summary: "Orbit camera track: keys of { target, azimuthDeg, elevationDeg, distance }.",
    type: "object",
    ref: "camera",
  },
  cameraMode: {
    summary: "Which camera block drives the scene; absent is orbit.",
    type: "string",
    ref: "camera",
    values: ["orbit", "rig"],
  },
  cameraRig: {
    summary: "Free-flight camera track: keys of { position, aim, fov, rollDeg }.",
    type: "object",
    ref: "camera",
  },
  themeId: { summary: "Swap the whole theme for this scene.", type: "string", ref: "project" },
  backdrop: {
    summary: "World-space staging: none, floor, gradient or image (needs SceneStage).",
    type: "object",
    ref: "backgrounds",
  },
  background: {
    summary: "Camera-locked fill: none, color, gradient, image, video, shader or scene3d.",
    type: "object",
    ref: "backgrounds",
  },
  textAnimation: {
    summary: "Whole-spec text motion for the scene (what the Text motion panel writes).",
    type: "object",
    ref: "text",
  },
  textAnimationForce: {
    summary: "true makes the sidecar/theme motion beat TSX animation props.",
    type: "boolean",
    ref: "text",
  },
  textAnimationOverrides: {
    summary: "Per text key whole-spec motion exceptions.",
    type: "object",
    ref: "text",
  },
  textLook: { summary: "Whole-spec text style for the scene.", type: "object", ref: "text" },
  textLookForce: {
    summary: "true makes the sidecar/theme look beat TSX look props.",
    type: "boolean",
    ref: "text",
  },
  textLookOverrides: { summary: "Per text key text looks.", type: "object", ref: "text" },
  lighting: {
    summary: "Scene lighting layer: sun, lights, fixtures, environment, shadow, keyframes.",
    type: "object",
    ref: "lighting",
  },
  frame: {
    summary: "Overlay panel with a shaped cutout, chip, icon and decorations.",
    type: "object",
    ref: "sidecar",
  },
  layeredScreenshot: {
    summary: "3D stack of app screens with a rest pose and optional animation.",
    type: "object",
    ref: "media",
  },
  videoWindow: {
    summary: "Legacy floating video window; read forward into media. Never author.",
    type: "object",
    ref: "media",
    legacy: true,
  },
  compare: {
    summary: "Before/after comparison: side B overrides, mask, divider track, chrome.",
    type: "object",
    ref: "devices",
  },
  chart: {
    summary: "One data chart: data, style, axes, labels, build-in, data track.",
    type: "object",
    ref: "charts",
  },
  terminal: {
    summary: "Terminal panel content; exports its captured snapshot.",
    type: "object",
    ref: "media",
  },
  website: {
    summary: "Website panel; exports its captured PNG.",
    type: "object",
    ref: "media",
  },
  animatedTrack: {
    summary: "Which keyed track the scene timeline lane edits; absent is camera.",
    type: "string",
    ref: "sidecar",
    values: ["camera", "layeredScreenshot", "compare", "chart", "lighting"],
  },
  stills: {
    summary: "Stills export: { exclude, marksMs }; absent is one automatic still.",
    type: "object",
    ref: "sidecar",
  },
  motionBlur: {
    summary:
      "Motion blur override { enabled, shutterDeg, camera, objects }; each field replaces the project's render.motionBlur.",
    type: "object",
    ref: "camera",
  },
};

/** One line per project.json key; exhaustive over `ProjectManifest`. */
export const PROJECT_MANIFEST_KEYS: Record<
  keyof ProjectManifest,
  { summary: string; type: string; required?: true; values?: string[] }
> = {
  id: { summary: "Project id (the folder slug).", type: "string", required: true },
  name: { summary: "Display name.", type: "string", required: true },
  version: {
    summary: "Manifest version; write 2 (transitions live on the OUTGOING scene).",
    type: "number",
  },
  themeId: {
    summary: "Theme id: kookaburra-* bundled or ws:<slug> workspace.",
    type: "string",
    required: true,
  },
  formats: {
    summary: "Aspects the project targets; the first is the default preview aspect.",
    type: "array",
    required: true,
    values: Object.keys(FORMATS),
  },
  scenes: {
    summary: "Ordered { file, durationMs, transition?, effects? }; the timeline order.",
    type: "array",
    required: true,
  },
  group: { summary: "Welcome screen group heading.", type: "string" },
  typography: {
    summary: 'Project font overrides { headline, body, chart } as "Family" or "Family@weight".',
    type: "object",
  },
  audio: {
    summary:
      "Soundtrack { file, gainDb, fadeInMs, fadeOutMs, fadeOutCurve, startOffsetMs, markers }.",
    type: "object",
  },
  defaultTransition: {
    summary: "Transition seeded onto new scene boundaries; null means hard cut.",
    type: "object|null",
  },
  render: {
    summary:
      "Display transform { toneMapping, exposure } plus motionBlur { enabled, shutterDeg, samples, camera, objects }; absent is aces at 1, no blur.",
    type: "object",
  },
  lighting: { summary: "Project lighting layer between theme and scene.", type: "object" },
  frame: { summary: "Deck-wide overlay merged into every scene.", type: "object" },
  camera: {
    summary: "Project camera keyframes on the global clock { tMs, position, fov, lookAt }.",
    type: "array",
  },
  persistent: {
    summary: "Module path whose default export mounts once across every scene.",
    type: "string",
  },
  appliedBackground: {
    summary: "Background last applied to all scenes; new scenes inherit it.",
    type: "object",
  },
};

/** One line per device screen media key (`devices[].media`, `coverMedia`, `compare.b` maps); exhaustive over `DeviceMediaSpec`. */
export const DEVICE_MEDIA_KEYS: Record<
  keyof DeviceMediaSpec,
  { summary: string; type: string; values?: string[] }
> = {
  src: {
    summary: "Project-relative image or video path, e.g. assets/demo.mp4.",
    type: "string",
  },
  kind: { summary: "What src is.", type: "string", values: ["video", "image"] },
  startMs: {
    summary:
      "Video: scene-time delay before playback, holding the first played frame; a negative value pre-rolls the clip on the scene clock.",
    type: "number",
  },
  fit: {
    summary: "Always cover: fills the screen and crops the overflow.",
    type: "string",
    values: ["cover"],
  },
  startOn: {
    summary: "Foldable inside display: startMs counts from the moment the fold opens.",
    type: "string",
    values: ["open"],
  },
  inMs: {
    summary:
      "Video: source ms where playback begins (a trim-in); combines with a startMs delay, never with a negative startMs.",
    type: "number",
  },
  outMs: {
    summary:
      "Video: source ms where playback ends, exclusive; must pass inMs by more than 16 ms. Absent plays to the end.",
    type: "number",
  },
  speed: {
    summary:
      "Video: playback rate, above 0 and at most 16 (default 1); frames repeat or skip, never blend. The editor offers 0.25 to 6.",
    type: "number",
  },
  loop: {
    summary:
      "Video: wraps within [inMs, outMs) instead of holding the last frame, through Present holds too.",
    type: "boolean",
  },
  posterMs: {
    summary:
      "Video: source ms shown before playback (during a delay or before a fold opens); default the first played frame.",
    type: "number",
  },
};

const BACKGROUND_TYPES: Record<
  ThemeBackground["type"],
  { summary: string; fields: string[]; theme: boolean }
> = {
  none: { summary: "Cancels the theme background.", fields: [], theme: true },
  color: { summary: "Flat colour fill.", fields: ["color", "parallax"], theme: true },
  gradient: {
    summary: "Theme gradient by name, or an inline spec (spec wins).",
    fields: ["gradient", "spec", "parallax"],
    theme: true,
  },
  image: {
    summary: "Cover-cropped image: assets/ path or a bundled kookaburra:<name>.",
    fields: ["src", "parallax"],
    theme: true,
  },
  video: {
    summary: "Looping video fill; sidecar only. loop false holds the last frame.",
    fields: ["src", "loop", "fit", "parallax"],
    theme: false,
  },
  shader: {
    summary: "Animated GLSL fill on the absolute project clock.",
    fields: ["shader", "colors", "themeColors", "speed", "scale", "params", "parallax", "preset"],
    theme: true,
  },
  scene3d: {
    summary: "World-space 3D look that parallaxes with the camera, over a 2D backing.",
    fields: ["look", "colors", "themeColors", "speed", "params", "backing", "preset"],
    theme: true,
  },
};

const BACKDROP_TYPES: Record<ThemeBackdrop["type"], { summary: string; fields: string[] }> = {
  none: { summary: "No staging.", fields: [] },
  floor: {
    summary: "Cyclorama floor that catches real shadows.",
    fields: ["color", "filletRadius"],
  },
  gradient: { summary: "Gradient plane behind the content.", fields: ["gradient", "spec"] },
  image: { summary: "Image plane behind the content.", fields: ["src", "fit"] },
};

const LIGHT_TYPES: Record<
  LightSpec["type"],
  { summary: string; required: string[]; optional: string[] }
> = {
  directional: {
    summary: "Parallel light aimed at the subject; can cast shadows.",
    required: ["id", "intensity", "placement"],
    optional: ["castShadow", "target"],
  },
  point: {
    summary: "Omni light; never casts shadows.",
    required: ["id", "intensity", "placement"],
    optional: ["distance", "decay"],
  },
  spot: {
    summary: "Cone light; angleDeg is the FULL cone (1..179), penumbra 0..1.",
    required: ["id", "intensity", "placement", "angleDeg", "penumbra"],
    optional: ["distance", "decay", "castShadow", "target"],
  },
  area: {
    summary: "Rect soft light; lights Standard/Physical materials only, no shadows.",
    required: ["id", "intensity", "placement", "width", "height"],
    optional: ["target"],
  },
};

const FIXTURE_FORMS: Record<FixtureForm, { summary: string; size: string }> = {
  tube: { summary: "Fluorescent tube along local X.", size: "[length, diameter]" },
  panel: { summary: "Flat emissive panel.", size: "[width, height]" },
  ring: { summary: "Emissive ring.", size: "[outerDiameter, thickness]" },
  strip: { summary: "Thin emissive bar along local X.", size: "[length, width]" },
  bulb: { summary: "Emissive sphere.", size: "[diameter, unused]" },
  "neon-sign": {
    summary: "Neon tube path; shape line, circle or rect.",
    size: "[width, height]",
  },
  "tube-stand": { summary: "Housed tube on a stand (a practical).", size: "[length, diameter]" },
  "ring-light": { summary: "Housed ring light (a practical).", size: "[outerDiameter, thickness]" },
  "led-strip": { summary: "Housed LED bar (a practical).", size: "[length, width]" },
};

const LIGHT_SPACES: Record<LightSpace, string> = {
  world: "Fixed in the scene; azimuth 0 points from the origin along +Z.",
  camera: "Rides the camera rigidly; no target aims at the subject.",
  subject: "Orbits what the camera looks at; azimuth 0 is a front light.",
};

const TONE_MAPPING: Record<ToneMappingId, string> = {
  aces: "Filmic contrast; the default.",
  agx: "Softer highlight roll-off, truer saturated colour.",
  neutral: "Minimal hue shift, product-accurate colour.",
  linear: "No curve; flat, clips highlights.",
};

const EFFECTS: Record<keyof EffectsConfig, { summary: string; fields: Record<string, string> }> = {
  bloom: {
    summary: "Glow on bright pixels; fixtures need it to read hot.",
    fields: {
      intensity: "0 turns it off",
      luminanceThreshold: "brightness where glow starts",
      luminanceSmoothing: "softness of the threshold",
    },
  },
  vignette: {
    summary: "Darkened corners.",
    fields: { offset: "how far in the falloff starts", darkness: "0 turns it off" },
  },
  lut: {
    summary: "3D LUT colour grade; every LUT in a project must share one LUT_3D_SIZE.",
    fields: { url: "project-relative .cube path", intensity: "0..1 blend" },
  },
  grain: { summary: "Seeded film grain.", fields: { intensity: "0 turns it off" } },
};

const DOF_MODES: Record<DofMode, { label: string; summary: string; fields: string[] }> = {
  depth: {
    label: "Depth",
    summary: "Blur by distance from a focus plane.",
    fields: ["blur", "range", "focus", "squeeze"],
  },
  tilt: {
    label: "Tilt-shift",
    summary: "Blur outside a screen-space band.",
    fields: ["blur", "band", "offset", "angleDeg"],
  },
  soft: {
    label: "Dream",
    summary: "Soft diffusion with a highlight glow.",
    fields: ["blur", "glow"],
  },
  radial: {
    label: "Burst",
    summary: "Zoom streaks from a centre point.",
    fields: ["blur", "centerX", "centerY"],
  },
  directional: {
    label: "Swipe",
    summary: "A smear along one angle.",
    fields: ["blur", "angleDeg"],
  },
  split: {
    label: "Split",
    summary: "Two focus distances across a divider.",
    fields: ["blur", "range", "focus", "focusB", "offset", "angleDeg", "squeeze"],
  },
};

const TRANSITION_EASES: Record<TransitionEase, string> = {
  linear: "Constant progress (the default when absent).",
  smooth: "Smoothstep in and out.",
  snappy: "Fast start, gentle landing.",
};

const DEVICE_MOTION: Record<
  DeviceMotionPreset,
  { label: string; summary: string; params: string[] }
> = {
  none: { label: "None", summary: "Holds the placement.", params: [] },
  "push-in": {
    label: "Push-in settle",
    summary: "Starts at 86% and angled, eases to full framing (default 1200 ms).",
    params: ["durationMs"],
  },
  turntable: {
    label: "Slow turntable",
    summary: "Continuous spin about Y (default 18 deg/s); sways in Present holds.",
    params: ["degPerSec"],
  },
  float: {
    label: "Float",
    summary: "Rises and settles above its rest pose (default 0.12 units at 0.4 Hz).",
    params: ["amplitude", "hz"],
  },
  "tilt-reveal": {
    label: "Tilt reveal",
    summary: "Swings flush from a tilted start (default 1000 ms).",
    params: ["durationMs"],
  },
};

const MEDIA_MOTION: Record<
  SceneMediaMotionPreset,
  { label: string; summary: string; kinds: string[] }
> = {
  none: { label: "None", summary: "No motion.", kinds: ["image", "video"] },
  turntable: { label: "Turn", summary: "Slow turntable.", kinds: ["image"] },
  float: { label: "Float", summary: "A gentle vertical bob.", kinds: ["image", "video"] },
  drift: { label: "Drift", summary: "A slow rotational sway.", kinds: ["video"] },
  "tilt-reveal": {
    label: "Tilt",
    summary: "Swings flush from a tilted start.",
    kinds: ["image", "video"],
  },
  "push-in": {
    label: "Push",
    summary: "Eases up from 90% to full size.",
    kinds: ["image", "video"],
  },
};

const DEVICE_LAYOUTS: Record<DeviceLayoutPreset, { label: string; summary: string }> = {
  row: { label: "Row", summary: "A flat line-up facing the camera." },
  "toe-in": { label: "Toe-in", summary: "A row with outer devices turned toward centre." },
  arc: { label: "Arc", summary: "A shallow arc, outer devices receding." },
  cascade: { label: "Cascade", summary: "Fanned cards stepping across and back." },
  hero: { label: "Hero", summary: "Device 1 forward, the rest flanking behind." },
  "depth-pair": {
    label: "Depth",
    summary: "Two devices split front and back (exactly 2, else toe-in).",
  },
};

const BULLET_MARKERS: Record<SceneManagedTextMarker, string> = {
  dot: "Round dot.",
  dash: "Short dash.",
  tick: "Tick mark.",
  number: "1. 2. 3.",
  none: "No marker.",
};

const CHART_MOUNTS: Record<ChartMount, string> = {
  hero: "The chart is the scene, fitted to the safe frame.",
  staged: "Stands among devices and text at a placement (3.3 x 2.2 units).",
  panel: "Flat chart inside the overlay panel; needs frame.chart too.",
};

/** Toolkit exports a scene may use, one line each; the test fails when an export lacks one. */
export const TOOLKIT_SUMMARIES: Record<
  string,
  { summary: string; internal?: true; legacy?: true }
> = {
  AVAILABLE_DEVICE_IDS: { summary: "Device ids this build can render with their own model." },
  AnimatedCounter: {
    summary: "Number counting from `from` to `to` over durationMs from scene start.",
  },
  AnimatedGroup: { summary: "Animates icon + text lockups as one unit with the text presets." },
  AnimatedHeadline: {
    summary: "The core SDF text primitive: presets, stagger, looks, textKey styling.",
  },
  BrandLockup: {
    summary: "App icon beside a small title over a hero subtitle, revealed as one unit.",
  },
  Chart: { summary: "Draws the sidecar chart block; usually the whole chart TSX." },
  Chart2D: { summary: "Flat chart renderer behind Chart; prefer Chart." },
  Chart3D: { summary: "3D chart renderer behind Chart; prefer Chart." },
  ChartFallback: { summary: "Host-mounted chart for scenes without Chart.", internal: true },
  DEFAULT_DEVICE_ID: { summary: "The studio default device id for this build." },
  DEPTH_BANDS: {
    summary: "DepthStage slot depths: foreground 1.8, content 0, midground -2.4, backdrop -5.5.",
  },
  DEVICE_AVAILABILITY: { summary: "Per device id: whether this build has its model." },
  DEVICE_CATALOG: { summary: "Device specs by id (name, form, colours, screen aspect)." },
  DEVICE_IDS: { summary: "Every catalogue device id." },
  DepthStage: { summary: "Four depth slots sized to stay full-bleed through a camera rig." },
  Device: { summary: "A catalogue device with screen media, placement, motion and shadow." },
  DeviceMockup: { summary: "Pre-catalogue phone with a static screen image.", legacy: true },
  ExtrudedText: { summary: "Lit 3D extruded text (ASCII, bundled face)." },
  FALLBACK_DEVICE_ID: { summary: "android: what unknown or unavailable models render as." },
  HeroObject: { summary: "Bundled hero glTF with idle spin and float." },
  ImageCard: { summary: "Flat, colour-exact image plane; PNG alpha shapes it." },
  LayeredScreenshot: { summary: "Renders the sidecar layeredScreenshot stack." },
  LightRig: { summary: "Shared three-light rig; mount once, pass lit={false} to lit primitives." },
  ManagedTextStack: { summary: "Responsive stack for inspector-owned managedText." },
  MotionBlur: {
    summary:
      "Scales motion blur for a subtree's own motion: amount 0 sharp, 1 the shutter, 2 double.",
  },
  ObjectsFallback: {
    summary: "Host-mounted 3D objects for scenes without StagedObject.",
    internal: true,
  },
  ParticleField: { summary: "Seeded instanced particles drifting on the clock." },
  Ribbon: { summary: "Seeded tube that grows along a curve." },
  SceneStage: { summary: "Theme lighting, backdrop and real shadows for the scene." },
  StagedObject: { summary: "One sidecar objects entry, auto-fitted." },
  TEXT_PRESET_NAMES: { summary: "Every text motion preset name." },
  TitleBlock: { summary: "Title + optional subtitle, theme-scaled, safe-area aligned." },
  VideoClip: { summary: "Deterministic video plane (pre-extracted 60 fps frames)." },
  VideoWindow: { summary: "Shim over a window-hosted media entry.", legacy: true },
  WORKSPACE_OBJECT_PREFIX: { summary: "ws: prefix of workspace object ids.", internal: true },
  WireGrid: { summary: "Travelling-wave wire grid on the clock." },
  createSeededRandom: {
    summary: "Seeded PRNG: createSeededRandom(seed)() returns 0..1. Use instead of Math.random.",
  },
  defineScene: {
    summary: "Every scene file default-exports defineScene({ id, durationMs, Scene }).",
  },
  deviceColour: { summary: "Resolve a colour id against a device spec." },
  fade: { summary: "fade(time, [startMs, endMs]) returns { opacity } 0..1." },
  importObject: { summary: "Imports a glb into the object library (app only).", internal: true },
  isDeviceAvailable: { summary: "Whether this build renders a device id with its own model." },
  isDeviceId: { summary: "Whether a string is a catalogue device id." },
  isTextPresetName: { summary: "Whether a string is a text motion preset." },
  isWorkspaceObjectId: {
    summary: "Whether an object id is a ws: workspace object.",
    internal: true,
  },
  liftColour: {
    summary: "liftColour(from, to, amount): sRGB blend toward another colour, as hex.",
  },
  listObjects: { summary: "Lists library objects (app only).", internal: true },
  parseObjectManifest: { summary: "Validates object.json (app only).", internal: true },
  preloadCatalogModels: { summary: "Export barrier for device models (app only).", internal: true },
  preloadSceneObjects: { summary: "Export barrier for 3D objects (app only).", internal: true },
  resolveAvailableDeviceId: { summary: "The id a model renders as in this build." },
  resolveAvailableDeviceSpec: { summary: "The spec a model renders with in this build." },
  resolveDeviceLayout: {
    summary: "resolveDeviceLayout(devices, layout, format): per-aspect placements.",
  },
  resolveObject: { summary: "Resolves an object manifest (app only).", internal: true },
  resolveObjectAsset: { summary: "Resolves an object glb (app only).", internal: true },
  sampleSharedTransform: { summary: "Samples a persistent-module keyframe track at globalMs." },
  slide: {
    summary: "slide(time, [startMs, endMs], axis) returns { offset } 1..0; axis is ignored.",
  },
  useDepthBand: { summary: "Inside DepthStage: the slot's { name, z, width, height }." },
  useFormat: { summary: "{ width, height, aspect, frame, safe } in world units at z=0." },
  useGroupAnimation: { summary: "Lets a custom child join an AnimatedGroup's alpha and shine." },
  useRigTrack: { summary: "The scene's normalised camera rig track, or null." },
  useSceneChart: { summary: "The resolved sidecar chart block, or null." },
  useSceneDevices: { summary: "Sidecar devices as Device props, layout resolved." },
  useSceneDoc: { summary: "The raw sidecar document, or null." },
  useSceneLayeredScreenshot: { summary: "The validated layeredScreenshot block, or null." },
  useSceneObjects: { summary: "The sidecar objects array." },
  useSceneStaged: { summary: "Whether a SceneStage owns the lighting here." },
  useSceneText: { summary: "useSceneText(key, fallback, role?): sidecar copy for a text key." },
  useTheme: { summary: "The resolved theme tokens for this scene." },
  useTimeline: { summary: "{ localMs, globalMs, progress }; progress is PROJECT-wide." },
};

// ── Helpers ──

/** The house style bans em dashes; registry hints still carry a few. */
export const EM_DASH = String.fromCharCode(0x2014);
const EM_DASH_RUN = new RegExp(`\\s*${EM_DASH}\\s*`, "g");

const round = (n: number, places = 3): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Deep copy with numbers rounded (computed values only) and every em dash rewritten: the kit is em-dash free. */
function tidy(value: unknown, roundNumbers = false): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.replace(EM_DASH_RUN, ", ");
  if (typeof value === "number") return roundNumbers ? round(value, 4) : value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => tidy(v, roundNumbers));
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === "function") continue;
      out[k] = tidy(v, roundNumbers);
    }
    return out;
  }
  return null;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function paramList(
  params: Record<
    string,
    { label: string; default: number; min: number; max: number; step: number }
  >,
): Entry[] {
  return Object.entries(params).map(([id, p]) => ({
    id,
    label: p.label,
    default: p.default,
    min: p.min,
    max: p.max,
    step: p.step,
  }));
}

function toolkitKind(name: string, value: unknown): string {
  if (name.startsWith("use")) return "hook";
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) return "constant";
  if (typeof value === "function" && /^[A-Z]/.test(name)) return "component";
  return typeof value === "function" ? "function" : "constant";
}

/** Type-only exports, read from the barrel's source (types are erased at runtime). */
export function toolkitTypeExports(source: string): string[] {
  const names = new Set<string>();
  for (const block of source.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
    for (const item of block[1].split(",")) {
      const name = item
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) names.add(name);
    }
  }
  for (const block of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const item of block[1].split(",")) {
      const m = item.trim().match(/^type\s+([A-Za-z0-9_]+)/);
      if (m) names.add(m[1]);
    }
  }
  return [...names].sort();
}

const presetSidecars = import.meta.glob<Record<string, unknown>>("/presets/*/scenes/*.json", {
  eager: true,
  import: "default",
});
const templateSidecars = import.meta.glob<Record<string, unknown>>("/projects/*/scenes/*.json", {
  eager: true,
  import: "default",
});
const presetPreviewFiles = import.meta.glob("/src/assets/preset-previews/*.jpg");

/** Sidecar top-level keys a scene authors, minus the bookkeeping ones. */
function sidecarBlocks(doc: Record<string, unknown> | undefined): string[] {
  if (!doc) return [];
  return Object.keys(doc)
    .filter((k) => k !== "version" && k !== "name")
    .sort();
}

function stemOf(file: string): string {
  return file.replace(/^\.?\//, "").replace(/\.tsx$/, "");
}

const PRESET_CONTEXT: PresetContext = {
  durationMs: 4000,
  orbit: { target: [0, 0, 0], azimuthDeg: 0, elevationDeg: 0, distance: CAMERA.position[2] },
  free: { position: [...CAMERA.position], aim: { mode: "point", at: [0, 0, 0] } },
  fov: CAMERA.fov,
};

// ── Families ──

function aspects(): Entry[] {
  return (Object.keys(FORMATS) as AspectName[]).map((id) => {
    const format = computeFormat(FORMATS[id]);
    return {
      id,
      label: aspectLabel(id),
      width: format.width,
      height: format.height,
      orientation: format.aspect > 1 ? "landscape" : format.aspect < 1 ? "portrait" : "square",
      frame: { width: round(format.frame.width), height: round(format.frame.height) },
      safeInset: round(format.safe.left),
    };
  });
}

function transitions(): Entry[] {
  return TRANSITION_CATALOG.map((t) => ({
    id: t.type,
    label: t.label,
    summary: t.hint,
    feel: t.feel,
    feelLabel: FEEL_LABELS[t.feel],
    defaultDurationMs: t.defaultDurationMs,
    direction: t.needsDirection,
    color: t.needsColor,
    ...(t.presets ? { presets: tidy(t.presets) } : {}),
    params: (t.params ?? []).map((p) =>
      p.kind === "choice"
        ? { key: p.key, label: p.label, default: p.default, options: p.options.map((o) => o.value) }
        : p.kind === "point"
          ? { key: p.key, label: p.label, default: [...p.default] }
          : {
              key: p.key === "blocksX" ? "blocks[0]" : p.key === "blocksY" ? "blocks[1]" : p.key,
              label: p.label,
              default: p.default,
              min: p.min,
              max: p.max,
            },
    ),
  }));
}

function eases(): Entry[] {
  const families = new Set<string>(EASE_FAMILIES);
  return EASE_NAMES.map((id) => {
    if (id === "linear") return { id, summary: "Constant speed." };
    if (id === "jump") {
      return {
        id,
        summary: "Holds the from value, snaps to the to value at the segment end (a cut).",
      };
    }
    const m = id.match(/^(in|out|inOut)(.+)$/);
    const family = m && families.has(m[2]) ? m[2] : "";
    const shape =
      m?.[1] === "in"
        ? "accelerates"
        : m?.[1] === "out"
          ? "decelerates"
          : "accelerates then decelerates";
    return { id, family, summary: `${family} curve; ${shape}.` };
  });
}

function textMotion(): Entry[] {
  const theme = BUILTIN_THEME_CATALOGUE.find((t) => t.id === "kookaburra-default")?.theme;
  const granularity = (preset: string): string | null => {
    if (!theme) return null;
    const resolved = resolveTextAnimation(
      { preset: preset as TextPresetName },
      { ...theme, textAnimation: undefined },
    );
    return resolved?.granularity ?? null;
  };
  const DISTANCE = new Set(["fade-up", "slide", "scatter-scale"]);
  const presets: Entry[] = TEXT_PRESET_CATALOG.map((p) => ({
    id: p.preset,
    label: p.label,
    summary: p.hint,
    granularity: granularity(p.preset),
    params: [
      ...(p.hasScaleParams ? ["startScale", "shine"] : []),
      ...(p.hasDirection ? ["direction"] : []),
      ...(DISTANCE.has(p.preset) ? ["distance"] : []),
    ],
  }));
  presets.push({
    id: "static",
    label: "Static",
    summary: "Fully still text, no reveal (the inspector's None).",
    granularity: null,
    params: [],
  });
  return presets;
}

function textDeliveries(): Entry[] {
  return DELIVERY_OPTIONS.map((d) => ({
    id: d.id,
    label: d.label,
    defaultStaggerMs: DELIVERY_DEFAULT_MS[d.id],
    writes:
      d.id === "word" || d.id === "char"
        ? { stagger: d.id, staggerMs: DELIVERY_DEFAULT_MS[d.id] }
        : d.id === "default"
          ? {}
          : { delivery: d.id },
  }));
}

function textLooks(): Entry[] {
  return TEXT_LOOK_CATALOG.map((l) => ({
    id: l.preset,
    label: l.label,
    summary: l.hint,
    params: [
      ...(l.hasColorA ? ["colorA"] : []),
      ...(l.hasColorB ? ["colorB"] : []),
      ...(l.hasAngle ? ["angleDeg"] : []),
      ...(l.hasStroke ? ["strokeEm"] : []),
      ...(l.hasHollow ? ["hollow"] : []),
      ...(l.hasIntensity ? ["intensity"] : []),
      ...(l.hasOffset ? ["offsetEm"] : []),
      ...(l.hasCurve ? ["curveDeg"] : []),
    ],
    threeD: l.preset.endsWith("-3d"),
  }));
}

function backgroundSummary(bg: ThemeBackground | undefined): string | null {
  if (!bg) return null;
  if (bg.type === "shader") return `shader:${bg.shader}`;
  if (bg.type === "scene3d") return `scene3d:${bg.look}`;
  return bg.type;
}

function themes(): Entry[] {
  const categories = new Map<string, string>(THEME_CATEGORIES.map((c) => [c.id, c.label]));
  return BUILTIN_THEME_CATALOGUE.map(({ theme, catalogue }) => ({
    id: theme.id,
    label: theme.name,
    summary: catalogue.useLabel,
    mode: theme.mode ?? null,
    category: catalogue.category,
    categoryLabel: categories.get(catalogue.category) ?? catalogue.category,
    tags: [...catalogue.tags],
    stage: catalogue.stage,
    ...(catalogue.hidden ? { hidden: true } : {}),
    colors: { ...theme.colors },
    ...(theme.chartColors ? { chartColors: [...theme.chartColors] } : {}),
    typography: {
      headline: formatFontString(theme.typography.headline),
      body: formatFontString(theme.typography.body),
      scale: theme.typography.scale,
    },
    motion: tidy(theme.motion),
    gradients: Object.keys(theme.gradients ?? {}).sort(),
    textAnimation: theme.textAnimation ? tidy(theme.textAnimation) : null,
    textLook: theme.textLook?.preset ?? null,
    background: backgroundSummary(theme.background),
    backdrop: theme.backdrop?.type ?? null,
    environment: theme.environment?.source ?? null,
    lighting: theme.lighting !== undefined,
    effects: Object.keys(theme.effects ?? {}).sort(),
  }));
}

function backgrounds(): Record<string, unknown> {
  const shaders: Entry[] = SHADER_BACKGROUND_IDS.map((id) => {
    const def = SHADER_BACKGROUNDS[id];
    return {
      id,
      label: def.name,
      colorSlots: def.colorSlots.map((s) => ({ label: s.label, fallback: s.fallback })),
      ...(def.maxColors ? { maxColors: def.maxColors } : {}),
      params: paramList(def.params),
      presets: (SHADER_BACKGROUND_PRESETS[id] ?? []).map(({ id: presetId, name, ...rest }) => ({
        id: presetId,
        label: name,
        ...rest,
      })),
    };
  });
  const scene3d: Entry[] = SCENE3D_BACKGROUND_IDS.map((id) => {
    const def = SCENE3D_BACKGROUNDS[id];
    return {
      id,
      label: def.name,
      family: def.family,
      familyLabel: SCENE3D_FAMILY_NAMES[def.family],
      lit: def.lit === true,
      colorSlots: def.colorSlots.map((s) => ({
        label: s.label,
        fallback: s.fallback,
        ...(s.glow ? { glow: true } : {}),
      })),
      params: paramList(def.params),
      presets: (SCENE3D_BACKGROUND_PRESETS[id] ?? []).map((p) => {
        const { id: presetId, lighting, name, ...rest } = p;
        return { id: presetId, label: name, ...rest, matchingLighting: lighting ?? null };
      }),
    };
  });
  return {
    types: (Object.keys(BACKGROUND_TYPES) as ThemeBackground["type"][]).map((id) => ({
      id,
      summary: BACKGROUND_TYPES[id].summary,
      fields: BACKGROUND_TYPES[id].fields,
      theme: BACKGROUND_TYPES[id].theme,
    })),
    backdrops: (Object.keys(BACKDROP_TYPES) as ThemeBackdrop["type"][]).map((id) => ({
      id,
      summary: BACKDROP_TYPES[id].summary,
      fields: BACKDROP_TYPES[id].fields,
    })),
    shaders,
    scene3d,
    gradients: GRADIENT_PRESETS.map((g) => ({
      id: slug(g.name),
      label: g.name,
      mode: g.mode,
      textColor: g.textColor,
      spec: tidy(g.spec),
    })),
    images: [...BUNDLED_BACKDROP_NAMES].sort().map((name) => ({
      id: `kookaburra:${name}`,
      label: name,
    })),
  };
}

function lighting(): Record<string, unknown> {
  return {
    presets: LIGHTING_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      summary: p.description,
      spec: tidy(p.spec),
    })),
    lightTypes: (Object.keys(LIGHT_TYPES) as LightSpec["type"][]).map((id) => ({
      id,
      ...LIGHT_TYPES[id],
    })),
    fixtureForms: (Object.keys(FIXTURE_FORMS) as FixtureForm[]).map((id) => ({
      id,
      ...FIXTURE_FORMS[id],
    })),
    spaces: (Object.keys(LIGHT_SPACES) as LightSpace[]).map((id) => ({
      id,
      summary: LIGHT_SPACES[id],
    })),
    environments: [
      ...BUNDLED_ENVIRONMENT_IDS.map((id) => ({ id, summary: "Bundled HDRI." })),
      { id: SOFTBOX_SOURCE, summary: "Procedural softbox reflections." },
      { id: NONE_SOURCE, summary: "No reflections (distinct from absent, which inherits)." },
      { id: "assets/<file>.hdr", summary: "A project HDR or EXR; a missing file fails the load." },
    ],
    toneMapping: (Object.keys(TONE_MAPPING) as ToneMappingId[]).map((id) => ({
      id,
      summary: TONE_MAPPING[id],
      ...(id === "aces" ? { default: true } : {}),
    })),
    limits: [
      { id: "exposure", min: EXPOSURE_MIN, max: EXPOSURE_MAX, default: 1 },
      { id: "kelvin", min: KELVIN_MIN, max: KELVIN_MAX },
      { id: "maxSceneLights", max: MAX_SCENE_LIGHTS },
      { id: "maxShadowCasters", max: MAX_SHADOW_CASTERS },
      { id: "maxFixtureInstances", max: FIXTURE_MAX_COUNT },
    ],
  };
}

function effects(): Entry[] {
  return (Object.keys(EFFECTS) as (keyof EffectsConfig)[]).map((id) => ({
    id,
    summary: EFFECTS[id].summary,
    fields: EFFECTS[id].fields,
  }));
}

function devices(): Entry[] {
  return DEVICE_IDS.map((id) => {
    const spec = DEVICE_CATALOG[id];
    return {
      id,
      label: spec.name,
      form: spec.form,
      licensed: id !== FALLBACK_DEVICE_ID,
      defaultColour: spec.defaultColour,
      colours: spec.colours.map((c) => ({ id: c.id, label: c.name, swatch: c.swatch })),
      customColour: `${CUSTOM_COLOUR_PREFIX}#rrggbb`,
      screenAspect: round(spec.screen.aspect, 4),
      ...(spec.coverScreen ? { coverScreenAspect: round(spec.coverScreen.aspect, 4) } : {}),
      fittedHeight: round(spec.fittedHeight),
      layoutWidth: round(spec.layoutWidth),
      ...(spec.lid ? { lid: { defaultDeg: spec.lid.defaultDeg, openDeg: spec.lid.openDeg } } : {}),
      ...(spec.fold
        ? { fold: { defaultDeg: spec.fold.defaultDeg, openDeg: spec.fold.openDeg } }
        : {}),
    };
  });
}

function deviceShadows(): Entry[] {
  return DEVICE_SHADOW_CHOICES.map((c) => ({
    id: c.id,
    label: c.label,
    receiver: c.id === "none" ? null : DEVICE_SHADOW_MODES[c.id].receiver,
    ...(c.id === "soft" ? { default: true } : {}),
  }));
}

function cameraPresets(): Entry[] {
  return CAMERA_PRESETS.map((p) => {
    const result = p.build(PRESET_CONTEXT);
    const example =
      result.mode === "rig"
        ? { cameraMode: "rig", cameraRig: tidy(result.rig, true) }
        : { cameraMode: "orbit", camera: tidy(result.camera, true) };
    return {
      id: p.id,
      label: p.label,
      summary: p.description,
      mode: p.mode,
      exampleFor4000ms: example,
    };
  });
}

function charts(): Record<string, unknown> {
  return {
    types: (Object.keys(CHART_TYPE_LABELS) as (keyof typeof CHART_TYPE_LABELS)[]).map((id) => ({
      id,
      label: CHART_TYPE_LABELS[id],
    })),
    mounts: (Object.keys(CHART_MOUNTS) as ChartMount[]).map((id) => ({
      id,
      summary: CHART_MOUNTS[id],
      ...(id === "hero" ? { default: true } : {}),
    })),
    styles: CHART_STYLE_PRESET_IDS.map((id) => ({
      id,
      label: CHART_STYLE_PRESETS[id].label,
      tier: CHART_STYLE_PRESETS[id].tier,
      ...(id === CHART_STYLE_DEFAULT_ID ? { default: true } : {}),
    })),
    animations: CHART_ANIMATION_PRESET_IDS.map((id) => ({
      id,
      label: CHART_ANIMATION_PRESETS[id].label,
      tier: CHART_ANIMATION_PRESETS[id].tier,
      types: [...CHART_ANIMATION_PRESETS[id].types],
      ...(id === "rise" ? { default: true } : {}),
    })),
    palettes: CHART_PALETTE_SCHEME_IDS.map((id) => ({
      id,
      label: CHART_PALETTE_SCHEMES[id].label,
      swatches: [...CHART_PALETTE_SCHEMES[id].swatches],
    })),
  };
}

function presets(): Entry[] {
  return listPresets().map((p) => {
    const file = sceneFileOf(p.slug);
    const doc = file ? presetSidecars[`/presets/${p.slug}/${stemOf(file)}.json`] : undefined;
    return {
      id: p.slug,
      label: p.name,
      summary: p.tagline,
      category: p.category,
      categoryLabel: p.categoryLabel,
      tags: [...p.tags],
      status: p.status,
      scene: file,
      durationMs: p.durationMs,
      aspects: [...p.aspects],
      themeId: p.themeId,
      blocks: sidecarBlocks(doc),
      preview: presetPreviewFiles[`/src/assets/preset-previews/${p.slug}.jpg`]
        ? `preset-previews/${p.slug}.jpg`
        : null,
    };
  });
}

const presetProjects = import.meta.glob<ProjectManifest>("/presets/*/project.json", {
  eager: true,
  import: "default",
});

function sceneFileOf(slugName: string): string | null {
  return presetProjects[`/presets/${slugName}/project.json`]?.scenes?.[0]?.file ?? null;
}

const templateProjects = import.meta.glob<ProjectManifest>("/projects/*/project.json", {
  eager: true,
  import: "default",
});

function templates(): Entry[] {
  return listTemplates().map((t) => {
    const project = templateProjects[`/projects/${t.slug}/project.json`];
    return {
      id: t.slug,
      label: t.name,
      summary: t.tagline,
      category: t.category,
      tags: [...t.tags],
      personas: [...t.personas],
      level: t.level,
      tier: t.tier,
      uses: [...t.uses],
      highlights: [...t.highlights],
      sceneCount: t.sceneCount,
      durationMs: t.durationMs,
      aspects: [...t.aspects],
      themeId: t.themeId,
      scenes: (project?.scenes ?? []).map((s) => ({
        file: s.file,
        durationMs: s.durationMs,
        transition: s.transition?.type ?? null,
        blocks: sidecarBlocks(templateSidecars[`/projects/${t.slug}/${stemOf(s.file)}.json`]),
      })),
    };
  });
}

function toolkitFamily(): Record<string, unknown> {
  const runtime = Object.keys(toolkit).sort();
  const exports = runtime.map((name) => {
    const meta = TOOLKIT_SUMMARIES[name];
    return {
      id: name,
      kind: toolkitKind(name, (toolkit as Record<string, unknown>)[name]),
      summary: meta?.summary ?? null,
      ...(meta?.internal ? { internal: true } : {}),
      ...(meta?.legacy ? { legacy: true } : {}),
    };
  });
  return {
    imports: allowedSpecifiers().map((id) =>
      id === "@kookaburra/toolkit"
        ? { id, summary: "The only import a scene may write." }
        : { id, summary: "Emitted by the JSX compiler; never write it." },
    ),
    exports,
    types: toolkitTypeExports(toolkitIndexSource).map((id) => ({ id })),
  };
}

/** The whole catalogue, deterministic: registry order where it is meaningful (picker order), sorted where it is not. */
export function buildAgentCatalog(): Record<string, Json> {
  const catalog = {
    version: AGENT_CATALOG_VERSION,
    aspects: aspects(),
    transitions: transitions(),
    transitionEases: (Object.keys(TRANSITION_EASES) as TransitionEase[]).map((id) => ({
      id,
      summary: TRANSITION_EASES[id],
    })),
    eases: eases(),
    textMotion: textMotion(),
    textDeliveries: textDeliveries(),
    textLooks: textLooks(),
    themes: themes(),
    backgrounds: backgrounds(),
    lighting: lighting(),
    effects: effects(),
    devices: devices(),
    deviceShadows: deviceShadows(),
    deviceMotion: (Object.keys(DEVICE_MOTION) as DeviceMotionPreset[]).map((id) => ({
      id,
      ...DEVICE_MOTION[id],
      ...(id === "none" ? { default: true } : {}),
    })),
    deviceLayouts: DEVICE_LAYOUT_PRESETS.map((id) => ({ id, ...DEVICE_LAYOUTS[id] })),
    deviceMedia: {
      keys: (Object.keys(DEVICE_MEDIA_KEYS) as (keyof DeviceMediaSpec)[]).map((id) => ({
        id,
        ...DEVICE_MEDIA_KEYS[id],
      })),
    },
    mediaMotion: SCENE_MEDIA_MOTION_PRESETS.map((id) => ({ id, ...MEDIA_MOTION[id] })),
    objects: Object.values(builtinObjects)
      .map((o) => ({
        id: o.id,
        label: o.name,
        tags: [...(o.tags ?? [])],
        fitHeight: o.fitHeight ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    camera: {
      presets: cameraPresets(),
      dof: (Object.keys(DOF_MODES) as DofMode[]).map((id) => ({ id, ...DOF_MODES[id] })),
      motionBlur: {
        shutterPresets: SHUTTER_PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
          shutterDeg: p.deg,
        })),
        samplePresets: SAMPLE_PRESETS.map((p) => ({
          id: p.id,
          label: p.label,
          samples: p.samples,
        })),
        limits: [
          { id: "shutterDeg", min: 0, max: SHUTTER_DEG_MAX, default: SHUTTER_DEG_DEFAULT },
          { id: "samples", values: [...SHUTTER_SAMPLE_COUNTS], default: SHUTTER_SAMPLES_DEFAULT },
          { id: "amount", min: 0, max: MOTION_BLUR_AMOUNT_MAX, default: 1 },
        ],
      },
    },
    compare: {
      presets: COMPARE_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        summary: p.hint,
        exampleFor4000ms: tidy(p.build(4000), true),
      })),
      masks: COMPARE_MASK_CATALOG.map((m) => ({
        id: m.id,
        label: m.label,
        summary: m.hint,
        angle: m.needsAngle,
        center: m.needsCenter,
        line: m.hasLine,
        grip: m.hasGrip,
        softness: m.hasSoftness,
      })),
      grips: COMPARE_GRIP_CATALOG.map((g) => ({ id: g.id, label: g.label, summary: g.hint })),
    },
    charts: charts(),
    chipIcons: CHIP_ICON_IDS.map((id) => ({ id })),
    bulletMarkers: MANAGED_TEXT_MARKERS.map((id) => ({ id, summary: BULLET_MARKERS[id] })),
    terminalThemes: TERMINAL_THEME_PRESETS.map((t) => ({ id: t.id, label: t.name })),
    fonts: {
      bundled: Object.keys(BUNDLED_FONTS)
        .sort()
        .map((family) => ({
          id: family,
          weights: Object.keys(BUNDLED_FONTS[family])
            .map(Number)
            .sort((a, b) => a - b),
        })),
    },
    sceneDoc: {
      version: SCENE_DOC_VERSION,
      keys: (Object.keys(SCENE_DOC_KEYS) as (keyof SceneDoc)[]).map((id) => ({
        id,
        ...SCENE_DOC_KEYS[id],
      })),
    },
    projectManifest: {
      version: 2,
      keys: (Object.keys(PROJECT_MANIFEST_KEYS) as (keyof ProjectManifest)[]).map((id) => ({
        id,
        ...PROJECT_MANIFEST_KEYS[id],
      })),
    },
    toolkit: toolkitFamily(),
    presets: presets(),
    templates: templates(),
  };
  return tidy(catalog) as Record<string, Json>;
}

/** Stable text form: two-space JSON plus a trailing newline (biome then formats the file). */
export function serialiseAgentCatalog(catalog: Record<string, Json>): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
