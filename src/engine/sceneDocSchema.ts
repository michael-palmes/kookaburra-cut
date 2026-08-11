import { parseFontString } from "../theme/fontRef";
import { parseBackdropSpec, parseBackgroundSpec, parseTextAnimationSpec } from "../theme/schema";
import type {
  FontRef,
  LightingSpec,
  TextAnimationSpec,
  ThemeBackdrop,
  ThemeBackground,
} from "../theme/tokens";
import type {
  ChartAnimationConfig,
  ChartCategoryAxis,
  ChartDimension,
  ChartGridlines,
  ChartLegend,
  ChartMount,
  ChartStyle,
  ChartType,
  ChartValueAxis,
  ChartValueFormat,
  ChartValueLabelBackground,
  ChartValueLabels,
  ChartValuesPose,
} from "../toolkit/chart/types";
import type {
  DeviceMediaSpec,
  DeviceMotionSpec,
  DevicePlacement,
  DeviceShadowMode,
} from "../toolkit/device/Device";
import type { FrameOverrideSpec } from "../toolkit/frame/types";
import type { SceneDocDof } from "./dof";
import { parseFrameOverride } from "./frameSchema";
import { normalizeLighting } from "./sceneLighting";

export type { SceneDocDof } from "./dof";

/** The per-scene sidecar schema (`scenes/<stem>.json` beside a scene's TSX): holds everything machine-editable (name, text, devices, camera, duration), written atomically via `write_scene_doc`; this module is pure (types + validation only) so it's unit-testable and safe to import anywhere, with IO and hooks living in `sceneDoc.ts`. Field docs: the kookaburra-scene-authoring skill; rationale: docs/decisions.md. */

/** Newest sidecar schema this build understands (newer docs are ignored with a warning). */
export const SCENE_DOC_VERSION = 1;

/** Range for a `textStyle.<textKey>LineHeight` multiplier, shared with the inspector's slider. */
export const TEXT_LINE_HEIGHT_MIN = 0.8;
export const TEXT_LINE_HEIGHT_MAX = 2;

export function clampLineHeight(value: number): number {
  return Math.min(TEXT_LINE_HEIGHT_MAX, Math.max(TEXT_LINE_HEIGHT_MIN, value));
}

/** Fold degrees into (-180, 180] so a wrapped drag and a hand-typed 400 land on the same value. */
export function normaliseDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let d = deg % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return d === 0 ? 0 : d;
}

/** One device entry, deliberately shaped as `Device` props plus a stable id. */
export interface SceneDocDeviceSpec {
  id: string;
  /** Catalog id, e.g. `"iphone-15-pro"` (unknown ids degrade inside `Device`). */
  model: string;
  colour?: string;
  media?: DeviceMediaSpec;
  placement?: DevicePlacement;
  motion?: DeviceMotionSpec;
  shadow?: DeviceShadowMode;
  /** Laptop lid opening in degrees (0 closed, default the model's authored angle); ignored by devices with no hinge. */
  lidDeg?: number;
}

export type SceneImageHost = "stage" | "overlay";

export interface SceneImageStagePlacement {
  position: [number, number, number];
  /** World-unit width. */
  size: number;
  rotationDeg: [number, number, number];
}

export interface SceneImageOverlayPlacement {
  /** Frame-relative centre, matching overlay decoration coordinates. */
  position: [number, number];
  /** Width as a fraction of the frame width. */
  size: number;
  /** Clockwise screen rotation. */
  rotationDeg: number;
  shape: "none" | "circle";
  layer: "below" | "above";
}

export interface SceneDocImageSpec {
  id: string;
  /** Project-relative still image under `assets/`. */
  src: string;
  host: SceneImageHost;
  /** Both placements remain authored when the active host changes. */
  stage: SceneImageStagePlacement;
  overlay: SceneImageOverlayPlacement;
  /** Absent is off. */
  castShadow?: boolean;
}

export const DEFAULT_SCENE_IMAGE_STAGE: SceneImageStagePlacement = {
  position: [0, 0, 0],
  size: 1,
  rotationDeg: [0, 0, 0],
};

export const DEFAULT_SCENE_IMAGE_OVERLAY: SceneImageOverlayPlacement = {
  position: [0, 0],
  size: 0.25,
  rotationDeg: 0,
  shape: "none",
  layer: "above",
};

/** Multi-device layout presets, resolved to per-aspect placements in `toolkit/device/layout.ts`. */
export const DEVICE_LAYOUT_PRESETS = [
  "row",
  "toe-in",
  "arc",
  "cascade",
  "hero",
  "depth-pair",
] as const;
export type DeviceLayoutPreset = (typeof DEVICE_LAYOUT_PRESETS)[number];

/** Per-device customisation on top of the preset base: offsets and rotations add (world units and degrees), scale multiplies. */
export interface SceneDocDeviceLayoutDelta {
  offset?: [number, number, number];
  rotationDeg?: [number, number, number];
  scale?: number;
}

/** The live device layout: preset + gap derive per-aspect placements, each device's delta applies on top. While present, the devices' own `placement` position/rotation/scale are ignored (`ground` still applies), so removing the block reverts to whatever was authored before it existed. */
export interface SceneDocDeviceLayout {
  preset: DeviceLayoutPreset;
  /** Edge-to-edge spacing in world units, authored for 16:9; narrower aspects compress the whole layout proportionally. */
  gap?: number;
  devices?: Record<string, SceneDocDeviceLayoutDelta>;
}

/** One staged 3D object, deliberately shaped like the device entry: a stable scene-local id plus a library reference and the shared placement block. */
export interface SceneDocObjectSpec {
  id: string;
  /** Object library id: a bundled key or `ws:<slug>` (unknown ids degrade to nothing rendered). */
  objectId: string;
  placement?: DevicePlacement;
}

export type SceneDocDuration =
  | { mode: "manual" }
  | { mode: "follow-media"; sourceDeviceId?: string; source?: "device" | "videoWindow" };

/** Orbit pose for the per-scene camera track. */
export interface SceneDocCameraPose {
  target: [number, number, number];
  azimuthDeg: number;
  elevationDeg: number;
  distance: number;
  /** Depth of field; absent inherits the last keyed value along the track (see engine/dof.ts). */
  dof?: SceneDocDof;
}

export interface SceneDocCameraKey {
  id: string;
  /** Scene-local time, ms. */
  tMs: number;
  pose: SceneDocCameraPose;
}

export interface SceneDocCameraSegment {
  from: string;
  to: string;
  /** An `engine/ease.ts` name (anime.js v4 style) or `"jump"`. */
  ease: string;
  /** Focus-channel ease override; absent means the segment's own `ease`. */
  easeDof?: string;
}

/** Present-slideshow hold looping for the camera track: once the authored keys finish during a hold, smooth eases back to the first key over blendMs then replays, jump restarts each cycle. Never read by preview or export sampling. */
export interface SceneDocCameraPresentLoop {
  mode: "smooth" | "jump";
  /** Smooth return-leg length in ms (the present window defaults it when absent). */
  blendMs?: number;
}

/** How a rig key points the camera: at a fixed world point, along the path, or at a bound object. `at` is the baked look point on EVERY mode, so a degenerate tangent or a deleted binding still renders a shot instead of swinging to the origin. */
export type SceneDocRigAim =
  | { mode: "point"; at: [number, number, number] }
  | { mode: "tangent"; at: [number, number, number] }
  | { mode: "object"; id: string; at: [number, number, number] };

/** A free camera pose: a position and an aim, not leashed to an orbit target. */
export interface SceneDocRigPose {
  position: [number, number, number];
  aim: SceneDocRigAim;
  /** Absent inherits the project-level track's fov; clamped 15..90 at normalise time. */
  fov?: number;
  /** Bank around the view axis; absent or zero applies no roll at all. */
  rollDeg?: number;
  /** Depth of field; absent inherits the last keyed value along the track (see engine/dof.ts). */
  dof?: SceneDocDof;
}

export interface SceneDocRigKey {
  id: string;
  /** Scene-local time, ms. */
  tMs: number;
  pose: SceneDocRigPose;
  /** First key only: start from the previous scene's final pose (resolved at load). */
  continueFromPrevious?: boolean;
}

export interface SceneDocRigSegment {
  from: string;
  to: string;
  /** An `engine/ease.ts` name (anime.js v4 style) or `"jump"`. */
  ease: string;
  /** ABSENT means smooth: rig paths curve out of the box, `false` is a deliberate straight dolly. */
  smooth?: boolean;
  /** Per-channel ease overrides; absent means the segment's own `ease` (position covers position, rotation covers aim and roll, lens covers fov, dof covers focus and blur). */
  easePosition?: string;
  easeRotation?: string;
  easeLens?: string;
  easeDof?: string;
}

/** Troika's textAlign values, 1:1 (never localise these; UI labels may). */
export type SceneTextAlign = "left" | "center" | "right";

export type LayeredScreenshotAttachSide = "left" | "right" | "top" | "bottom";

/** Where a chained item hangs off its neighbour; the layer's one root item has attach: null. */
export interface LayeredScreenshotAttach {
  /** Another item's id within the same layer. */
  to: string;
  side: LayeredScreenshotAttachSide;
}

interface LayeredScreenshotItemBase {
  id: string;
  attach: LayeredScreenshotAttach | null;
  /** World-unit gap to the attached neighbour; falls back to the layer's gap, then the tuned default. */
  gap?: number;
}

export interface LayeredScreenshotScreenItem extends LayeredScreenshotItemBase {
  kind: "screen";
  /** Project-relative asset path. */
  src: string;
  media: "image" | "video";
  /** Video only, scene-local ms. */
  startMs?: number;
  /** Card treatment override for this one item; default follows the layer's flat. */
  flat?: boolean;
}

/** The string itself lives in doc.text["ls-<id>"] via useSceneText, so textStyle overrides apply for free. */
export interface LayeredScreenshotTextItem extends LayeredScreenshotItemBase {
  kind: "text";
  /** Wrap width in world units (screens size from their media aspect; text needs an explicit box). */
  width?: number;
}

export type LayeredScreenshotItem = LayeredScreenshotScreenItem | LayeredScreenshotTextItem;

export interface LayeredScreenshotLayer {
  id: string;
  name?: string;
  visible: boolean;
  items: LayeredScreenshotItem[];
  /** This layer's default chain gap, world units. */
  gap?: number;
  /** This layer's default card treatment. */
  flat?: boolean;
  /** Stack order offset within the spread; builder-authored. */
  z: number;
}

/** The rest pose: exactly what a non-animated scene renders, and the builder's saved view. */
export interface LayeredScreenshotPose {
  /** 0 = flattest legal stack, 1 = fully expanded; mapped through a tuned Z step so layers never clip. */
  spread: number;
  azimuthDeg: number;
  elevationDeg: number;
  /** Multiplier, 1 = the auto-fit default. */
  zoom: number;
  /** World-unit offset of the stack's centre. */
  pan: [number, number];
}

export interface LayeredScreenshotKey {
  id: string;
  /** Scene-local time, ms. */
  tMs: number;
  pose: LayeredScreenshotPose;
}

export interface LayeredScreenshotSegment {
  from: string;
  to: string;
  /** An `engine/ease.ts` name or `"jump"`. */
  ease: string;
}

export interface SceneDocLayeredScreenshot {
  layers: LayeredScreenshotLayer[];
  pose: LayeredScreenshotPose;
  animation?: {
    keys: LayeredScreenshotKey[];
    segments: LayeredScreenshotSegment[];
    /** Slideshow holds only, the camera's presentLoop semantics; preview and export never loop. */
    presentLoop?: SceneDocCameraPresentLoop;
  };
}

/** Corner radius for the video window: a named preset, or a custom short-edge fraction (clamped 0..0.5 at resolve). `macos` emulates a real macOS window's rounding, and under `recording: true` it resolves to the capture's true pixel radius. */
export type VideoWindowRadius = "sharp" | "subtle" | "macos" | "rounded" | { custom: number };

/** The window's analytic drop shadow onto the backing stage. `blur` and `offset` are fractions of the window's short edge (offset x right, y up); `opacity` is 0..1. */
export interface VideoWindowShadow {
  opacity: number;
  blur: number;
  offset: [number, number];
}

/** The window's edge stroke. `width` is a fraction of the short edge, `opacity` 0..1; `enabled: false` turns it off. */
export interface VideoWindowBorder {
  enabled: boolean;
  color: string;
  width: number;
  opacity: number;
}

export type VideoWindowMotionPreset = "none" | "float" | "tilt-reveal" | "push-in" | "drift";

/** Canned gentle motion for the window itself (pure functions of scene-local time); the per-scene camera track composes on top. */
export interface VideoWindowMotion {
  preset: VideoWindowMotionPreset;
  /** `float`: world-unit bob amplitude (default 0.12). `drift`: sway in degrees (default 4). */
  amplitude?: number;
  /** `float`/`drift`: cycles per second (defaults 0.3 / 0.1). */
  hz?: number;
  /** `tilt-reveal`/`push-in`: intro length in ms (defaults 900 / 1000). */
  durationMs?: number;
}

/** A macOS screen recording presented as a floating window (rounded corners + hairline edge) with an analytic drop shadow, floating over whatever the scene stages behind it; one per scene, sidecar-only (references a project asset, like video fills). Deep validation lives in `sceneVideoWindow.ts`. */
export interface SceneDocVideoWindow {
  /** Project-relative video, e.g. `"assets/screencast.mp4"`; `aspect` (width/height, recorded at pick time) sizes the window before the clip's intrinsics arrive. */
  media: { src: string; startMs?: number; loop?: boolean; aspect?: number };
  radius: VideoWindowRadius;
  /** Raw macOS window recording: crop the capture margins (baked shadow and background) and, under the `macos` radius preset, round at the capture's true pixel radius. Auto-detected at pick time from the poster's black margins. */
  recording?: boolean;
  border?: VideoWindowBorder;
  shadow?: VideoWindowShadow;
  motion?: VideoWindowMotion;
  /** Window size as a fraction of the frame's shorter axis (default 0.72, clamped 0.1..1). */
  scale?: number;
  /** Window placement as fractions of the frame (x right, y up, clamped -1..1); [0, 0] is centred, the motion preset rides on top. */
  offset?: [number, number];
}

export interface SceneDoc {
  version: number;
  /** Human name shown by pickers (scenes have no display name otherwise). */
  name?: string;
  duration?: SceneDocDuration;
  /** Every user-visible string, keyed for `useSceneText` (the skill-mandated rule). */
  text?: Record<string, string>;
  /** Layout for the scene's text block; consumed by TitleBlock (inert when a scene positions text by hand, the `backdrop` precedent). */
  textLayout?: { align?: SceneTextAlign };
  /** Per-text-element overrides keyed `<textKey><Suffix>`: `Color` (raw hex fill, the one narrow exception to "colours stay tokens"), `Font` ("Family" or "Family@weight"), `Size` (multiplier of the element's default, 1 = unchanged), `OffsetX`/`OffsetY` (world-unit nudges from the scene's layout), `LineHeight` (line spacing as a multiple of the font size, clamped 0.8..2; absent means troika's own "normal") and `RotationDeg` (clockwise tilt in degrees about the block's anchor; absent or 0 is upright); consumed by text primitives given a matching `textKey`, inert otherwise. */
  textStyle?: Record<string, string | number>;
  /** Header icon for a plain (non-overlay) scene's text: an emoji or an `assets/` image path, drawn above the headline by `TextFallback`/`TitleBlock`. Overlay scenes carry their icon on `frame.icon` instead; both scale by `textStyle.iconSize`. */
  headerIcon?: string;
  devices?: SceneDocDeviceSpec[];
  /** Ordered, scene-owned still images that retain independent Stage and Overlay placements. */
  images?: SceneDocImageSpec[];
  /** The live multi-device layout block; see `SceneDocDeviceLayout`. */
  deviceLayout?: SceneDocDeviceLayout;
  /** Staged 3D objects from the object library, rendered by `ObjectsFallback` on any scene. */
  objects?: SceneDocObjectSpec[];
  camera?: {
    keys: SceneDocCameraKey[];
    segments: SceneDocCameraSegment[];
    presentLoop?: SceneDocCameraPresentLoop;
  };
  /** Which camera block drives this scene; absent = "orbit" (null-for-legacy). Switching never deletes the other block's keys, and "rig" with no rig keys falls through to orbit. */
  cameraMode?: "orbit" | "rig";
  /** The free-flight camera track (see `sceneRig.ts`); read only under `cameraMode: "rig"`. */
  cameraRig?: {
    keys: SceneDocRigKey[];
    segments: SceneDocRigSegment[];
    presentLoop?: SceneDocCameraPresentLoop;
  };
  /** Theme override for this scene: a theme id that swaps the whole theme (colours, typography, lighting, backdrop, effects base); absent falls back to the project's theme, and unknown ids degrade rather than crash. */
  themeId?: string;
  /** Staging override: replaces the theme's backdrop for this scene. */
  backdrop?: ThemeBackdrop;
  /** Fixed-background override: replaces the theme's camera-locked, frame-filling background for this scene (whole-value replacement, like `backdrop`); `{type:"none"}` cancels the theme's layer. */
  background?: ThemeBackground;
  /** Text-animation override: a whole spec replacing the theme's `textAnimation` for this scene (the backdrop pattern, what the picker writes); explicit per-primitive TSX props still win unless `textAnimationForce`. */
  textAnimation?: TextAnimationSpec;
  /** Flips the resolution order for this scene (the panel's Override): text primitives ignore their own TSX animation props and follow the sidecar/theme spec instead (timing props like `from`/`to`/`outAt` still apply); written when the user overrides coded motion, absent means the normal prop-wins order. */
  textAnimationForce?: boolean;
  /** Partial lighting override: each present field fully replaces the layer below's (see `mergeLighting`); the long-shadow look is typically a per-scene low-elevation `sun` + `shadow` override rather than a whole new theme. Deep validation lives in `sceneLighting.ts`. */
  lighting?: LightingSpec;
  /** Overlay override: merges over the manifest's deck-wide `frame` for this scene (see `mergeFrameSpec`); `cutout` may be omitted to inherit the deck's shape, and `{enabled:false}` opts the scene out entirely. */
  frame?: FrameOverrideSpec;
  /** The layered-screenshot composition (one per scene; layers carry the multiplicity). Deep graph validation lives in `sceneLayeredScreenshot.ts`. */
  layeredScreenshot?: SceneDocLayeredScreenshot;
  /** The video-window composition (one per scene): a macOS screen recording as a floating window over a backing stage. Deep validation lives in `sceneVideoWindow.ts`. */
  videoWindow?: SceneDocVideoWindow;
  /** The before/after comparison block: side B's overrides plus the shared mask and divider track; side A is this doc itself. Deep normalisation lives in `sceneCompare.ts`. */
  compare?: SceneDocCompare;
  /** The chart block (one per scene): data, appearance, axes, labels and the keyframed data track. Defaults and sampling live in `sceneChart.ts`. */
  chart?: SceneDocChart;
  /** Which animated track drives this scene; absent = "camera" (null-for-legacy). Switching never deletes the other tracks' keys. */
  animatedTrack?: "camera" | "layeredScreenshot" | "compare" | "chart";
}

/** Side B ("after") of a comparison: every field optional, absent means same as side A (the base doc). `media` remaps device screens by device id; `themeId`/`background`/`lighting` replace the doc's own fields for side B only. */
export interface SceneDocCompareSide {
  media?: Record<string, DeviceMediaSpec>;
  themeId?: string;
  background?: ThemeBackground;
  lighting?: LightingSpec;
}

/** One divider key on the shared KeyedTrack model: the mask value (0..1) at a scene-local time. Eased interpolation happens inside segments; outside them the latest key holds (the camera-track semantics). */
export interface SceneDocCompareKey {
  id: string;
  /** Scene-local time, ms. */
  tMs: number;
  pose: { value: number };
}

export interface SceneDocCompareSegment {
  from: string;
  to: string;
  /** An `engine/ease.ts` name (unknown names degrade at sample time). */
  ease: string;
}

/** The exported chrome: a divider line along the mask edge, a grip riding a linear divider, label chips per half, per-side tints. Colours are THEME TOKEN NAMES (background | text | accent | muted), resolved against the scene's theme at plan build. Absent sub-blocks are off. */
export interface SceneDocCompareChrome {
  line?: { width?: number; colour?: string; softness?: number };
  grip?: boolean | { size?: number };
  chips?: boolean;
  tint?: { a?: string; b?: string; amount?: number };
}

/** The comparison block. `mask.type`: `linear` (a straight divider, `angleDeg` is the LINE's angle, 90 = vertical), `circle` (the after inside a growing circle at `center`), `radial` (the after sweeps around `center`), `blend` (the after fades over the before). `softness` feathers the edge; `value` is the static divider position when no track keys exist (default 0.5). */
export interface SceneDocCompare {
  b?: SceneDocCompareSide;
  mask?: {
    type: "linear" | "circle" | "radial" | "blend";
    angleDeg?: number;
    softness?: number;
    center?: [number, number];
  };
  value?: number;
  track?: { keys: SceneDocCompareKey[]; segments: SceneDocCompareSegment[] };
  chrome?: SceneDocCompareChrome;
}

/** One data series: `values` is one number per category (short rows read as 0), `colour` overrides the theme palette swatch for this series index. */
export interface SceneDocChartSeries {
  id: string;
  name?: string;
  values: number[];
  colour?: string;
}

export interface SceneDocChartData {
  categories: string[];
  series: SceneDocChartSeries[];
  /** Project-relative CSV the values were imported from; informational, nothing reads it at render or export time. */
  source?: string;
}

/** The value axis as authored: every field optional, `sceneChart.ts` fills the defaults. */
export interface SceneDocChartValueAxis
  extends Omit<Partial<ChartValueAxis>, "format" | "gridlines"> {
  format?: Partial<ChartValueFormat>;
  gridlines?: Partial<ChartGridlines>;
}

export interface SceneDocChartValueLabels
  extends Omit<Partial<ChartValueLabels>, "format" | "background"> {
  format?: Partial<ChartValueFormat>;
  /** PRESENT (even bare) forces a chip behind every value label; absent leaves the appearance preset's own pill maths. */
  background?: Partial<ChartValueLabelBackground>;
}

/** One data keyframe: a FULL value snapshot (the Magic Chart model), `[series][category]`, the same shape as `data`. Structure changes (adding a series or category) are edits to `data`, never keyframable. */
export interface SceneDocChartKey {
  id: string;
  /** Scene-local time, ms. */
  tMs: number;
  pose: ChartValuesPose;
}

export interface SceneDocChartSegment {
  from: string;
  to: string;
  /** An `engine/ease.ts` name (unknown names degrade at sample time). */
  ease: string;
}

/** The chart block: one chart per scene, mounted as the scene's hero, staged among devices (`placement`) or inside an overlay panel. Absence is PRESERVED here (a missing field means "unauthored"); defaults, clamps and the resolved track live in `sceneChart.ts`. `track` keyframes the data: `data.series[].values` is the pose before the first key. */
export interface SceneDocChart {
  type: ChartType;
  dimension?: ChartDimension;
  mount?: ChartMount;
  /** Staged mount only. */
  placement?: DevicePlacement;
  data: SceneDocChartData;
  /** Named colour scheme id; absent takes the theme's chart palette. */
  palette?: string;
  /** Font string ("Family" or "Family@weight") for every label in the chart; absent takes the project's chart font, then the theme faces. */
  font?: string;
  style?: Partial<ChartStyle>;
  axis?: { value?: SceneDocChartValueAxis; category?: Partial<ChartCategoryAxis> };
  labels?: { legend?: Partial<ChartLegend>; values?: SceneDocChartValueLabels };
  animation?: Partial<ChartAnimationConfig>;
  track?: { keys: SceneDocChartKey[]; segments: SceneDocChartSegment[] };
}

export function validLayeredScreenshotPose(raw: unknown): raw is LayeredScreenshotPose {
  const pose = raw as LayeredScreenshotPose | null;
  return (
    !!pose &&
    typeof pose === "object" &&
    Number.isFinite(pose.spread) &&
    Number.isFinite(pose.azimuthDeg) &&
    Number.isFinite(pose.elevationDeg) &&
    Number.isFinite(pose.zoom) &&
    Array.isArray(pose.pan) &&
    pose.pan.length === 2 &&
    pose.pan.every((n) => Number.isFinite(n))
  );
}

/** Shallow structural check, the camera-block pattern: layers + a finite pose keep the block, anything else drops it whole; per-item degrade lives in sceneLayeredScreenshot.ts. */
function validLayeredScreenshot(raw: unknown): raw is SceneDocLayeredScreenshot {
  const ls = raw as SceneDocLayeredScreenshot | null;
  if (!ls || typeof ls !== "object") return false;
  if (!Array.isArray(ls.layers)) return false;
  if (!validLayeredScreenshotPose(ls.pose)) return false;
  if (ls.animation !== undefined) {
    if (
      !ls.animation ||
      typeof ls.animation !== "object" ||
      !Array.isArray(ls.animation.keys) ||
      !Array.isArray(ls.animation.segments)
    ) {
      return false;
    }
  }
  return true;
}

/** Shallow structural check (the layeredScreenshot pattern): a media source keeps the block, anything else drops it whole; per-field degrade + defaults live in sceneVideoWindow.ts. */
function validVideoWindow(raw: unknown): raw is SceneDocVideoWindow {
  const vw = raw as SceneDocVideoWindow | null;
  if (!vw || typeof vw !== "object") return false;
  return !!vw.media && typeof vw.media.src === "string" && vw.media.src.length > 0;
}

const finiteV3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

const finiteV2 = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const SCENE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

export function isSceneImageSource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  if (parts[0] !== "assets" || parts.length < 2) return false;
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false;
  const extension = parts.at(-1)?.split(".").at(-1)?.toLowerCase();
  return extension !== undefined && SCENE_IMAGE_EXTENSIONS.has(extension);
}

function parseSceneImageStage(raw: unknown): SceneImageStagePlacement {
  if (!isRecord(raw)) {
    return {
      position: [...DEFAULT_SCENE_IMAGE_STAGE.position],
      size: DEFAULT_SCENE_IMAGE_STAGE.size,
      rotationDeg: [...DEFAULT_SCENE_IMAGE_STAGE.rotationDeg],
    };
  }
  return {
    position: finiteV3(raw.position) ? [...raw.position] : [...DEFAULT_SCENE_IMAGE_STAGE.position],
    size: finiteNum(raw.size) && raw.size > 0 ? raw.size : DEFAULT_SCENE_IMAGE_STAGE.size,
    rotationDeg: finiteV3(raw.rotationDeg)
      ? (raw.rotationDeg.map(normaliseDeg) as [number, number, number])
      : [...DEFAULT_SCENE_IMAGE_STAGE.rotationDeg],
  };
}

function parseSceneImageOverlay(raw: unknown): SceneImageOverlayPlacement {
  if (!isRecord(raw)) {
    return {
      position: [...DEFAULT_SCENE_IMAGE_OVERLAY.position],
      size: DEFAULT_SCENE_IMAGE_OVERLAY.size,
      rotationDeg: DEFAULT_SCENE_IMAGE_OVERLAY.rotationDeg,
      shape: DEFAULT_SCENE_IMAGE_OVERLAY.shape,
      layer: DEFAULT_SCENE_IMAGE_OVERLAY.layer,
    };
  }
  return {
    position: finiteV2(raw.position)
      ? [...raw.position]
      : [...DEFAULT_SCENE_IMAGE_OVERLAY.position],
    size: finiteNum(raw.size) && raw.size > 0 ? raw.size : DEFAULT_SCENE_IMAGE_OVERLAY.size,
    rotationDeg: finiteNum(raw.rotationDeg)
      ? normaliseDeg(raw.rotationDeg)
      : DEFAULT_SCENE_IMAGE_OVERLAY.rotationDeg,
    shape: raw.shape === "circle" ? "circle" : "none",
    layer: raw.layer === "below" ? "below" : "above",
  };
}

function parseSceneImages(raw: unknown, source: string): SceneDocImageSpec[] | undefined {
  if (!Array.isArray(raw)) {
    console.warn(`[sceneDoc] ${source}: images isn't an array, dropped`);
    return undefined;
  }
  const images: SceneDocImageSpec[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      console.warn(`[sceneDoc] ${source}: images[${index}] needs a non-empty string id, dropped`);
      continue;
    }
    if (seen.has(entry.id)) {
      console.warn(`[sceneDoc] ${source}: duplicate image id "${entry.id}", later entry dropped`);
      continue;
    }
    if (!isSceneImageSource(entry.src)) {
      console.warn(
        `[sceneDoc] ${source}: images[${index}].src isn't a supported project image, dropped`,
      );
      continue;
    }
    seen.add(entry.id);
    const image: SceneDocImageSpec = {
      id: entry.id,
      src: entry.src,
      host: entry.host === "overlay" ? "overlay" : "stage",
      stage: parseSceneImageStage(entry.stage),
      overlay: parseSceneImageOverlay(entry.overlay),
    };
    if (typeof entry.castShadow === "boolean") image.castShadow = entry.castShadow;
    images.push(image);
  }
  return images;
}

const CHART_COLOUR_TOKENS = ["background", "text", "accent", "muted"];
const CHART_HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A chart colour as authored: one of the four theme tokens by name, or a hex (the FrameChip rule). */
const isChartColour = (v: unknown): v is string =>
  typeof v === "string" && (CHART_COLOUR_TOKENS.includes(v) || CHART_HEX.test(v));

/** Field-level parse for the deviceLayout block (degrade-not-throw): an unknown preset falls back to `row` so the block survives, malformed deltas drop alone. Resolution maths lives in `toolkit/device/layout.ts`. */
function parseDeviceLayout(raw: unknown, source: string): SceneDocDeviceLayout | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`[sceneDoc] ${source}: deviceLayout isn't an object, dropped`);
    return undefined;
  }
  const l = raw as Record<string, unknown>;
  let preset: DeviceLayoutPreset = "row";
  if (DEVICE_LAYOUT_PRESETS.includes(l.preset as DeviceLayoutPreset)) {
    preset = l.preset as DeviceLayoutPreset;
  } else {
    console.warn(`[sceneDoc] ${source}: deviceLayout.preset isn't known, using row`);
  }
  const out: SceneDocDeviceLayout = { preset };
  if (typeof l.gap === "number" && Number.isFinite(l.gap)) {
    out.gap = l.gap;
  } else if (l.gap !== undefined) {
    console.warn(`[sceneDoc] ${source}: deviceLayout.gap isn't a finite number, dropped`);
  }
  if (typeof l.devices === "object" && l.devices !== null && !Array.isArray(l.devices)) {
    const devices: Record<string, SceneDocDeviceLayoutDelta> = {};
    for (const [id, d] of Object.entries(l.devices as Record<string, unknown>)) {
      if (typeof d !== "object" || d === null || Array.isArray(d)) {
        console.warn(`[sceneDoc] ${source}: deviceLayout.devices["${id}"] is malformed, dropped`);
        continue;
      }
      const delta = d as Record<string, unknown>;
      const outDelta: SceneDocDeviceLayoutDelta = {};
      if (finiteV3(delta.offset)) outDelta.offset = delta.offset;
      if (finiteV3(delta.rotationDeg)) outDelta.rotationDeg = delta.rotationDeg;
      if (typeof delta.scale === "number" && Number.isFinite(delta.scale) && delta.scale > 0) {
        outDelta.scale = delta.scale;
      }
      if (Object.keys(outDelta).length > 0) devices[id] = outDelta;
    }
    if (Object.keys(devices).length > 0) out.devices = devices;
  } else if (l.devices !== undefined) {
    console.warn(`[sceneDoc] ${source}: deviceLayout.devices isn't an object, dropped`);
  }
  return out;
}

/** Field-level parse for the compare block (the degrade-not-throw rule): a non-object drops the block whole, a malformed sub-field drops alone so one typo can't kill the comparison. Deep normalisation (mask defaults, key sort, value sampling) lives in `sceneCompare.ts`. */
function parseCompare(raw: unknown, source: string): SceneDocCompare | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`[sceneDoc] ${source}: compare isn't an object, dropped`);
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const out: SceneDocCompare = {};
  if (typeof c.b === "object" && c.b !== null && !Array.isArray(c.b)) {
    const b = c.b as Record<string, unknown>;
    const side: SceneDocCompareSide = {};
    if (typeof b.themeId === "string") side.themeId = b.themeId;
    if (b.background !== undefined) {
      const background = parseBackgroundSpec(b.background, `${source} compare.b`, { video: true });
      if (background) side.background = background;
    }
    if (b.lighting !== undefined) {
      const lighting = normalizeLighting(b.lighting, `${source} compare.b`);
      if (lighting) side.lighting = lighting;
    }
    if (typeof b.media === "object" && b.media !== null && !Array.isArray(b.media)) {
      const media: Record<string, DeviceMediaSpec> = {};
      for (const [id, m] of Object.entries(b.media as Record<string, unknown>)) {
        const spec = m as DeviceMediaSpec | null;
        if (
          spec &&
          typeof spec === "object" &&
          typeof spec.src === "string" &&
          spec.src.length > 0 &&
          (spec.kind === "video" || spec.kind === "image")
        ) {
          media[id] = spec;
        } else {
          console.warn(`[sceneDoc] ${source}: compare.b.media["${id}"] is malformed, dropped`);
        }
      }
      if (Object.keys(media).length > 0) side.media = media;
    }
    if (Object.keys(side).length > 0) out.b = side;
  }
  if (typeof c.value === "number" && Number.isFinite(c.value)) {
    out.value = Math.min(1, Math.max(0, c.value));
  }
  if (c.mask !== undefined) {
    const mask = c.mask as {
      type?: unknown;
      angleDeg?: unknown;
      softness?: unknown;
      center?: unknown;
    } | null;
    const type = mask && typeof mask === "object" ? mask.type : undefined;
    if (type === "linear" || type === "circle" || type === "radial" || type === "blend") {
      const m: NonNullable<SceneDocCompare["mask"]> = { type };
      if (mask && typeof mask.angleDeg === "number" && Number.isFinite(mask.angleDeg)) {
        m.angleDeg = mask.angleDeg;
      }
      if (
        mask &&
        typeof mask.softness === "number" &&
        Number.isFinite(mask.softness) &&
        mask.softness >= 0
      ) {
        m.softness = mask.softness;
      }
      if (
        mask &&
        Array.isArray(mask.center) &&
        mask.center.length === 2 &&
        mask.center.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        m.center = [
          Math.min(1, Math.max(0, mask.center[0] as number)),
          Math.min(1, Math.max(0, mask.center[1] as number)),
        ];
      }
      out.mask = m;
    } else {
      console.warn(`[sceneDoc] ${source}: compare.mask type isn't known, dropped`);
    }
  }
  if (c.chrome !== undefined) {
    const raw = c.chrome as Record<string, unknown> | null;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const chrome: SceneDocCompareChrome = {};
      const line = raw.line as
        | { width?: unknown; colour?: unknown; softness?: unknown }
        | undefined;
      if (line && typeof line === "object") {
        const l: NonNullable<SceneDocCompareChrome["line"]> = {};
        if (typeof line.width === "number" && Number.isFinite(line.width) && line.width >= 0) {
          l.width = line.width;
        }
        if (typeof line.colour === "string") l.colour = line.colour;
        if (
          typeof line.softness === "number" &&
          Number.isFinite(line.softness) &&
          line.softness >= 0
        ) {
          l.softness = line.softness;
        }
        chrome.line = l;
      }
      if (typeof raw.grip === "boolean") chrome.grip = raw.grip;
      else if (raw.grip && typeof raw.grip === "object") {
        const size = (raw.grip as { size?: unknown }).size;
        chrome.grip =
          typeof size === "number" && Number.isFinite(size) && size > 0 ? { size } : true;
      }
      if (typeof raw.chips === "boolean") chrome.chips = raw.chips;
      const tint = raw.tint as { a?: unknown; b?: unknown; amount?: unknown } | undefined;
      if (tint && typeof tint === "object") {
        const t: NonNullable<SceneDocCompareChrome["tint"]> = {};
        if (typeof tint.a === "string") t.a = tint.a;
        if (typeof tint.b === "string") t.b = tint.b;
        if (typeof tint.amount === "number" && Number.isFinite(tint.amount)) {
          t.amount = Math.min(1, Math.max(0, tint.amount));
        }
        chrome.tint = t;
      }
      out.chrome = chrome;
    } else {
      console.warn(`[sceneDoc] ${source}: compare.chrome isn't an object, dropped`);
    }
  }
  if (c.track !== undefined) {
    const track = c.track as { keys?: unknown; segments?: unknown } | null;
    const rawKeys =
      track && typeof track === "object" && Array.isArray(track.keys) ? track.keys : [];
    const keys = rawKeys.filter((k): k is SceneDocCompareKey => {
      const key = k as SceneDocCompareKey | null;
      const ok =
        !!key &&
        typeof key === "object" &&
        typeof key.id === "string" &&
        Number.isFinite(key.tMs) &&
        !!key.pose &&
        typeof key.pose === "object" &&
        Number.isFinite(key.pose.value);
      if (!ok) console.warn(`[sceneDoc] ${source}: compare.track key is malformed, dropped`);
      return ok;
    });
    const rawSegments =
      track && typeof track === "object" && Array.isArray(track.segments) ? track.segments : [];
    const segments = rawSegments.filter((s): s is SceneDocCompareSegment => {
      const seg = s as SceneDocCompareSegment | null;
      const ok =
        !!seg &&
        typeof seg === "object" &&
        typeof seg.from === "string" &&
        typeof seg.to === "string" &&
        typeof seg.ease === "string";
      if (!ok) console.warn(`[sceneDoc] ${source}: compare.track segment is malformed, dropped`);
      return ok;
    });
    if (keys.length > 0) out.track = { keys, segments };
  }
  return out;
}

const CHART_TYPES: ChartType[] = [
  "column",
  "stackedColumn",
  "bar",
  "stackedBar",
  "line",
  "area",
  "stackedArea",
  "pie",
];

/** Field-level parse for a `DevicePlacement` (the deviceLayout delta pattern): bad scalars drop alone, and the layout stamp `resolvedLayout` is never authored so it is not read here. */
function parsePlacement(raw: unknown, source: string, label: string): DevicePlacement | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: ${label} isn't an object, dropped`);
    return undefined;
  }
  const out: DevicePlacement = {};
  if (finiteV3(raw.position)) out.position = raw.position;
  if (finiteV3(raw.rotationDeg)) out.rotationDeg = raw.rotationDeg;
  if (finiteNum(raw.scale) && raw.scale > 0) out.scale = raw.scale;
  if (typeof raw.ground === "boolean") out.ground = raw.ground;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Non-numeric cells read as 0 rather than dropping, so a row keeps its length and stays aligned with the categories. */
function parseChartValues(raw: readonly unknown[], source: string, label: string): number[] {
  let zeroed = 0;
  const values = raw.map((v) => {
    if (finiteNum(v)) return v;
    zeroed++;
    return 0;
  });
  if (zeroed > 0) {
    console.warn(`[sceneDoc] ${source}: ${label} had ${zeroed} non-numeric value(s), zeroed`);
  }
  return values;
}

function parseChartFormat(
  raw: unknown,
  source: string,
  label: string,
): Partial<ChartValueFormat> | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: ${label} isn't an object, dropped`);
    return undefined;
  }
  const out: Partial<ChartValueFormat> = {};
  if (raw.decimals === null || finiteNum(raw.decimals)) out.decimals = raw.decimals;
  if (typeof raw.separator === "boolean") out.separator = raw.separator;
  if (typeof raw.prefix === "string") out.prefix = raw.prefix;
  if (typeof raw.suffix === "string") out.suffix = raw.suffix;
  if (typeof raw.compact === "boolean") out.compact = raw.compact;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A `series` array is the one required shape: without it the block cannot chart anything and drops whole. */
/** The chip behind the value labels. An empty object SURVIVES: presence is the semantic (it forces the chip on), so only junk fields drop. */
function parseChartValueBackground(
  raw: unknown,
  source: string,
): Partial<ChartValueLabelBackground> | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: chart.labels.values.background isn't an object, dropped`);
    return undefined;
  }
  const out: Partial<ChartValueLabelBackground> = {};
  if (raw.colour === null || isChartColour(raw.colour)) {
    out.colour = raw.colour as string | null;
  } else if (raw.colour !== undefined) {
    console.warn(
      `[sceneDoc] ${source}: chart.labels.values.background.colour isn't a theme token or hex, dropped`,
    );
  }
  if (finiteNum(raw.opacity)) out.opacity = raw.opacity;
  if (finiteNum(raw.radius)) out.radius = raw.radius;
  return out;
}

function parseChartData(raw: unknown, source: string): SceneDocChartData | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.series)) return undefined;
  const categories = (Array.isArray(raw.categories) ? raw.categories : []).map((c, i) => {
    if (typeof c === "string") return c;
    console.warn(`[sceneDoc] ${source}: chart.data.categories[${i}] isn't a string, blanked`);
    return "";
  });
  const series: SceneDocChartSeries[] = [];
  for (const entry of raw.series as unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !Array.isArray(entry.values)) {
      console.warn(
        `[sceneDoc] ${source}: chart.data series entry needs string "id" + "values", dropped`,
      );
      continue;
    }
    const out: SceneDocChartSeries = {
      id: entry.id,
      values: parseChartValues(entry.values, source, `chart.data.series["${entry.id}"]`),
    };
    if (typeof entry.name === "string") out.name = entry.name;
    if (typeof entry.colour === "string" && entry.colour.length > 0) out.colour = entry.colour;
    series.push(out);
  }
  const data: SceneDocChartData = { categories, series };
  if (typeof raw.source === "string" && raw.source.length > 0) data.source = raw.source;
  return data;
}

function parseChartStyle(raw: unknown, source: string): Partial<ChartStyle> | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: chart.style isn't an object, dropped`);
    return undefined;
  }
  const out: Partial<ChartStyle> = {};
  if (typeof raw.preset === "string" && raw.preset.length > 0) out.preset = raw.preset;
  if (finiteNum(raw.depth)) out.depth = raw.depth;
  if (finiteNum(raw.gap)) out.gap = raw.gap;
  if (finiteNum(raw.cornerRadius)) out.cornerRadius = raw.cornerRadius;
  if (finiteNum(raw.innerRadius)) out.innerRadius = raw.innerRadius;
  const rotation = raw.rotation;
  if (Array.isArray(rotation) && rotation.length === 2 && rotation.every(finiteNum)) {
    out.rotation = [rotation[0], rotation[1]];
  }
  const offset = raw.offset;
  if (Array.isArray(offset) && offset.length === 2 && offset.every(finiteNum)) {
    out.offset = [offset[0], offset[1]];
  }
  if (finiteNum(raw.scale)) out.scale = raw.scale;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseChartValueAxis(raw: unknown, source: string): SceneDocChartValueAxis | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: chart.axis.value isn't an object, dropped`);
    return undefined;
  }
  const out: SceneDocChartValueAxis = {};
  if (typeof raw.name === "string" || raw.name === null) out.name = raw.name;
  if (raw.min === null || finiteNum(raw.min)) out.min = raw.min;
  if (raw.max === null || finiteNum(raw.max)) out.max = raw.max;
  if (typeof raw.trim === "boolean") out.trim = raw.trim;
  if (finiteNum(raw.steps)) out.steps = raw.steps;
  if (typeof raw.labels === "boolean") out.labels = raw.labels;
  if (raw.format !== undefined) {
    const format = parseChartFormat(raw.format, source, "chart.axis.value.format");
    if (format) out.format = format;
  }
  if (isRecord(raw.gridlines)) {
    const gridlines: Partial<ChartGridlines> = {};
    const style = raw.gridlines.style;
    if (typeof raw.gridlines.visible === "boolean") gridlines.visible = raw.gridlines.visible;
    if (style === "hair" || style === "dashed" || style === "none") gridlines.style = style;
    if (Object.keys(gridlines).length > 0) out.gridlines = gridlines;
  } else if (raw.gridlines !== undefined) {
    console.warn(`[sceneDoc] ${source}: chart.axis.value.gridlines isn't an object, dropped`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseChartAxis(raw: unknown, source: string): SceneDocChart["axis"] {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: chart.axis isn't an object, dropped`);
    return undefined;
  }
  const out: NonNullable<SceneDocChart["axis"]> = {};
  if (raw.value !== undefined) {
    const value = parseChartValueAxis(raw.value, source);
    if (value) out.value = value;
  }
  if (isRecord(raw.category)) {
    const category: Partial<ChartCategoryAxis> = {};
    if (typeof raw.category.name === "string" || raw.category.name === null) {
      category.name = raw.category.name;
    }
    if (typeof raw.category.labels === "boolean") category.labels = raw.category.labels;
    if (Object.keys(category).length > 0) out.category = category;
  } else if (raw.category !== undefined) {
    console.warn(`[sceneDoc] ${source}: chart.axis.category isn't an object, dropped`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseChartLabels(raw: unknown, source: string): SceneDocChart["labels"] {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: chart.labels isn't an object, dropped`);
    return undefined;
  }
  const out: NonNullable<SceneDocChart["labels"]> = {};
  if (isRecord(raw.legend)) {
    const legend: Partial<ChartLegend> = {};
    const position = raw.legend.position;
    if (typeof raw.legend.visible === "boolean") legend.visible = raw.legend.visible;
    if (position === "top" || position === "bottom" || position === "trailing") {
      legend.position = position;
    }
    if (Object.keys(legend).length > 0) out.legend = legend;
  } else if (raw.legend !== undefined) {
    console.warn(`[sceneDoc] ${source}: chart.labels.legend isn't an object, dropped`);
  }
  if (isRecord(raw.values)) {
    const values: SceneDocChartValueLabels = {};
    const location = raw.values.location;
    if (typeof raw.values.visible === "boolean") values.visible = raw.values.visible;
    if (location === "above" || location === "inside" || location === "below") {
      values.location = location;
    }
    if (typeof raw.values.countUp === "boolean") values.countUp = raw.values.countUp;
    if (finiteNum(raw.values.offsetY)) values.offsetY = raw.values.offsetY;
    if (raw.values.format !== undefined) {
      const format = parseChartFormat(raw.values.format, source, "chart.labels.values.format");
      if (format) values.format = format;
    }
    if (raw.values.background !== undefined) {
      const background = parseChartValueBackground(raw.values.background, source);
      if (background) values.background = background;
    }
    if (Object.keys(values).length > 0) out.values = values;
  } else if (raw.values !== undefined) {
    console.warn(`[sceneDoc] ${source}: chart.labels.values isn't an object, dropped`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseChartAnimation(
  raw: unknown,
  source: string,
): Partial<ChartAnimationConfig> | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: chart.animation isn't an object, dropped`);
    return undefined;
  }
  const out: Partial<ChartAnimationConfig> = {};
  const delivery = raw.delivery;
  const from = raw.from;
  if (typeof raw.preset === "string" && raw.preset.length > 0) out.preset = raw.preset;
  if (delivery === "all" || delivery === "series" || delivery === "cascade")
    out.delivery = delivery;
  if (finiteNum(raw.staggerMs) && raw.staggerMs >= 0) out.staggerMs = raw.staggerMs;
  if (finiteNum(raw.durationMs) && raw.durationMs >= 0) out.durationMs = raw.durationMs;
  if (
    from === "start" ||
    from === "end" ||
    from === "centre" ||
    from === "edges" ||
    from === "shuffle"
  ) {
    out.from = from;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The data track, on the shared KeyedTrack model (the compare precedent): a key needs an id, a time and a `pose.values` matrix; with no key surviving there is no track at all. */
function parseChartTrack(raw: unknown, source: string): SceneDocChart["track"] {
  const track = isRecord(raw) ? raw : {};
  const keys: SceneDocChartKey[] = [];
  for (const entry of Array.isArray(track.keys) ? (track.keys as unknown[]) : []) {
    const pose = isRecord(entry) && isRecord(entry.pose) ? entry.pose.values : undefined;
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !finiteNum(entry.tMs) ||
      !Array.isArray(pose) ||
      !pose.every((row) => Array.isArray(row))
    ) {
      console.warn(`[sceneDoc] ${source}: chart.track key is malformed, dropped`);
      continue;
    }
    const id = entry.id;
    keys.push({
      id,
      tMs: entry.tMs,
      pose: {
        values: (pose as unknown[][]).map((row, s) =>
          parseChartValues(row, source, `chart.track key "${id}" row ${s}`),
        ),
      },
    });
  }
  const rawSegments = Array.isArray(track.segments) ? (track.segments as unknown[]) : [];
  const segments = rawSegments.filter((s): s is SceneDocChartSegment => {
    const seg = s as SceneDocChartSegment | null;
    const ok =
      !!seg &&
      typeof seg === "object" &&
      typeof seg.from === "string" &&
      typeof seg.to === "string" &&
      typeof seg.ease === "string";
    if (!ok) console.warn(`[sceneDoc] ${source}: chart.track segment is malformed, dropped`);
    return ok;
  });
  return keys.length > 0 ? { keys, segments } : undefined;
}

/** Field-level parse for the chart block (the degrade-not-throw rule): only a missing `data.series` array drops the block whole, an unknown `type` falls back to `column` (the deviceLayout precedent) and every other malformed field drops alone. Defaults are NOT applied here: `sceneChart.ts` owns them, so absence stays legible. A panel-mounted chart is always 2d, so a `3d` dimension coerces. */
function parseChart(raw: unknown, source: string): SceneDocChart | undefined {
  if (!isRecord(raw)) {
    console.warn(`[sceneDoc] ${source}: chart isn't an object, dropped`);
    return undefined;
  }
  const data = parseChartData(raw.data, source);
  if (!data) {
    console.warn(`[sceneDoc] ${source}: chart.data needs a "series" array, block dropped`);
    return undefined;
  }
  let type: ChartType = "column";
  if (CHART_TYPES.includes(raw.type as ChartType)) {
    type = raw.type as ChartType;
  } else {
    console.warn(`[sceneDoc] ${source}: chart.type isn't known, using column`);
  }
  const out: SceneDocChart = { type, data };
  if (raw.mount === "hero" || raw.mount === "staged" || raw.mount === "panel") {
    out.mount = raw.mount;
  } else if (raw.mount !== undefined) {
    console.warn(`[sceneDoc] ${source}: chart.mount isn't hero|staged|panel, dropped`);
  }
  if (raw.dimension === "2d" || raw.dimension === "3d") {
    if (out.mount === "panel" && raw.dimension === "3d") {
      console.warn(`[sceneDoc] ${source}: panel-mounted charts are 2d, dimension coerced`);
    }
    out.dimension = out.mount === "panel" ? "2d" : raw.dimension;
  } else if (raw.dimension !== undefined) {
    console.warn(`[sceneDoc] ${source}: chart.dimension isn't 2d|3d, dropped`);
  }
  if (raw.placement !== undefined) {
    const placement = parsePlacement(raw.placement, source, "chart.placement");
    if (placement) out.placement = placement;
  }
  if (typeof raw.palette === "string" && raw.palette.trim().length > 0) {
    out.palette = raw.palette;
  } else if (raw.palette !== undefined) {
    console.warn(`[sceneDoc] ${source}: chart.palette isn't a scheme id, dropped`);
  }
  if (typeof raw.font === "string" && raw.font.trim().length > 0) {
    out.font = raw.font.trim();
  } else if (raw.font !== undefined) {
    console.warn(`[sceneDoc] ${source}: chart.font isn't a font string, dropped`);
  }
  if (raw.style !== undefined) {
    const style = parseChartStyle(raw.style, source);
    if (style) out.style = style;
  }
  if (raw.axis !== undefined) {
    const axis = parseChartAxis(raw.axis, source);
    if (axis) out.axis = axis;
  }
  if (raw.labels !== undefined) {
    const labels = parseChartLabels(raw.labels, source);
    if (labels) out.labels = labels;
  }
  if (raw.animation !== undefined) {
    const animation = parseChartAnimation(raw.animation, source);
    if (animation) out.animation = animation;
  }
  if (raw.track !== undefined) {
    const track = parseChartTrack(raw.track, source);
    if (track) out.track = track;
  }
  return out;
}

function validPresentLoop(raw: unknown): raw is SceneDocCameraPresentLoop {
  const loop = raw as SceneDocCameraPresentLoop | null;
  if (!loop || typeof loop !== "object") return false;
  if (loop.mode !== "smooth" && loop.mode !== "jump") return false;
  if (loop.blendMs !== undefined && !(Number.isFinite(loop.blendMs) && loop.blendMs > 0)) {
    return false;
  }
  return true;
}

/** Validates a raw sidecar value, returning `undefined` (with a console warning) rather than throwing, since a bad document must degrade to "no doc" and never tear down the canvas tree (the bootTrap lesson); unknown extra fields pass through untouched, structurally wrong required fields drop the entry or the whole doc. */
export function parseSceneDoc(raw: unknown, source: string): SceneDoc | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn(`[sceneDoc] ${source}: not an object — ignored`);
    return undefined;
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.version !== "number" || doc.version < 1) {
    console.warn(`[sceneDoc] ${source}: missing/invalid "version" — ignored`);
    return undefined;
  }
  if (doc.version > SCENE_DOC_VERSION) {
    console.warn(
      `[sceneDoc] ${source}: version ${doc.version} is newer than this Kookaburra Cut understands — ignored`,
    );
    return undefined;
  }
  const out: SceneDoc = { version: doc.version };
  if (typeof doc.name === "string") out.name = doc.name;
  if (typeof doc.headerIcon === "string") out.headerIcon = doc.headerIcon;
  const duration = doc.duration as SceneDocDuration | undefined;
  if (duration && (duration.mode === "manual" || duration.mode === "follow-media")) {
    out.duration = duration;
  }
  if (typeof doc.text === "object" && doc.text !== null && !Array.isArray(doc.text)) {
    const text: Record<string, string> = {};
    for (const [key, value] of Object.entries(doc.text as Record<string, unknown>)) {
      if (typeof value === "string") text[key] = value;
      else console.warn(`[sceneDoc] ${source}: text["${key}"] isn't a string — dropped`);
    }
    out.text = text;
  }
  if (
    typeof doc.textLayout === "object" &&
    doc.textLayout !== null &&
    !Array.isArray(doc.textLayout)
  ) {
    const align = (doc.textLayout as Record<string, unknown>).align;
    if (align === "left" || align === "center" || align === "right") {
      out.textLayout = { align };
    } else if (align !== undefined) {
      console.warn(`[sceneDoc] ${source}: textLayout.align isn't left|center|right — dropped`);
    }
  }
  if (
    typeof doc.textStyle === "object" &&
    doc.textStyle !== null &&
    !Array.isArray(doc.textStyle)
  ) {
    const raw = doc.textStyle as Record<string, unknown>;
    const textStyle: NonNullable<SceneDoc["textStyle"]> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key.endsWith("Color") || key.endsWith("Font")) {
        if (typeof value === "string" && value.length > 0) textStyle[key] = value;
        else
          console.warn(`[sceneDoc] ${source}: textStyle.${key} isn't a non-empty string, dropped`);
      } else if (key.endsWith("Size")) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          textStyle[key] = value;
        } else {
          console.warn(`[sceneDoc] ${source}: textStyle.${key} isn't a positive number, dropped`);
        }
      } else if (key.endsWith("OffsetX") || key.endsWith("OffsetY")) {
        if (typeof value === "number" && Number.isFinite(value)) textStyle[key] = value;
        else console.warn(`[sceneDoc] ${source}: textStyle.${key} isn't a finite number, dropped`);
      } else if (key.endsWith("LineHeight")) {
        if (typeof value === "number" && Number.isFinite(value)) {
          textStyle[key] = clampLineHeight(value);
        } else {
          console.warn(`[sceneDoc] ${source}: textStyle.${key} isn't a finite number, dropped`);
        }
      } else if (key.endsWith("RotationDeg")) {
        if (typeof value === "number" && Number.isFinite(value)) {
          textStyle[key] = normaliseDeg(value);
        } else {
          console.warn(`[sceneDoc] ${source}: textStyle.${key} isn't a finite number, dropped`);
        }
      } else {
        console.warn(
          `[sceneDoc] ${source}: textStyle.${key} isn't a <textKey>Color|Font|Size|OffsetX|OffsetY|LineHeight|RotationDeg key, dropped`,
        );
      }
    }
    if (Object.keys(textStyle).length > 0) out.textStyle = textStyle;
  }
  if (Array.isArray(doc.devices)) {
    const devices: SceneDocDeviceSpec[] = [];
    for (const entry of doc.devices as unknown[]) {
      const device = entry as SceneDocDeviceSpec;
      if (
        device &&
        typeof device === "object" &&
        typeof device.id === "string" &&
        typeof device.model === "string"
      ) {
        devices.push(device);
      } else {
        console.warn(`[sceneDoc] ${source}: device entry needs string "id" + "model" — dropped`);
      }
    }
    out.devices = devices;
  }
  if (doc.images !== undefined) {
    const images = parseSceneImages(doc.images, source);
    if (images) out.images = images;
  }
  if (doc.deviceLayout !== undefined) {
    const deviceLayout = parseDeviceLayout(doc.deviceLayout, source);
    if (deviceLayout) out.deviceLayout = deviceLayout;
  }
  if (Array.isArray(doc.objects)) {
    const objects: SceneDocObjectSpec[] = [];
    for (const entry of doc.objects as unknown[]) {
      const object = entry as SceneDocObjectSpec;
      if (
        object &&
        typeof object === "object" &&
        typeof object.id === "string" &&
        typeof object.objectId === "string"
      ) {
        objects.push(object);
      } else {
        console.warn(`[sceneDoc] ${source}: object entry needs string "id" + "objectId" — dropped`);
      }
    }
    out.objects = objects;
  }
  if (typeof doc.camera === "object" && doc.camera !== null) {
    const camera = doc.camera as NonNullable<SceneDoc["camera"]>;
    if (Array.isArray(camera?.keys) && Array.isArray(camera?.segments)) {
      if (camera.presentLoop !== undefined && !validPresentLoop(camera.presentLoop)) {
        console.warn(`[sceneDoc] ${source}: camera.presentLoop is invalid, dropped`);
        const { presentLoop: _dropped, ...rest } = camera;
        out.camera = rest;
      } else {
        out.camera = camera;
      }
    }
  }
  if (doc.cameraMode === "orbit" || doc.cameraMode === "rig") {
    out.cameraMode = doc.cameraMode;
  } else if (doc.cameraMode !== undefined) {
    console.warn(`[sceneDoc] ${source}: cameraMode isn't orbit|rig, dropped`);
  }
  if (typeof doc.cameraRig === "object" && doc.cameraRig !== null) {
    const rig = doc.cameraRig as NonNullable<SceneDoc["cameraRig"]>;
    if (Array.isArray(rig?.keys) && Array.isArray(rig?.segments)) {
      if (rig.presentLoop !== undefined && !validPresentLoop(rig.presentLoop)) {
        console.warn(`[sceneDoc] ${source}: cameraRig.presentLoop is invalid, dropped`);
        const { presentLoop: _dropped, ...rest } = rig;
        out.cameraRig = rest;
      } else {
        out.cameraRig = rig;
      }
    }
  }
  if (typeof doc.themeId === "string" && doc.themeId.length > 0) out.themeId = doc.themeId;
  if (doc.backdrop !== undefined) {
    const backdrop = parseBackdropSpec(doc.backdrop, source);
    if (backdrop) out.backdrop = backdrop;
  }
  if (doc.background !== undefined) {
    // Sidecars may carry video fills (decision 5); themes may not.
    const background = parseBackgroundSpec(doc.background, source, { video: true });
    if (background) out.background = background;
  }
  if (doc.textAnimation !== undefined) {
    const textAnimation = parseTextAnimationSpec(doc.textAnimation, source);
    if (textAnimation) out.textAnimation = textAnimation;
  }
  if (doc.textAnimationForce === true) out.textAnimationForce = true;
  if (doc.lighting !== undefined) {
    const lighting = normalizeLighting(doc.lighting, source);
    if (lighting) out.lighting = lighting;
  }
  if (doc.frame !== undefined) {
    const frame = parseFrameOverride(doc.frame, source);
    if (frame) out.frame = frame;
  }
  if (doc.layeredScreenshot !== undefined) {
    if (validLayeredScreenshot(doc.layeredScreenshot)) {
      out.layeredScreenshot = doc.layeredScreenshot;
    } else {
      console.warn(`[sceneDoc] ${source}: layeredScreenshot is malformed, dropped`);
    }
  }
  if (doc.videoWindow !== undefined) {
    if (validVideoWindow(doc.videoWindow)) {
      out.videoWindow = doc.videoWindow;
    } else {
      console.warn(`[sceneDoc] ${source}: videoWindow is malformed, dropped`);
    }
  }
  if (doc.compare !== undefined) {
    const compare = parseCompare(doc.compare, source);
    if (compare) out.compare = compare;
  }
  if (doc.chart !== undefined) {
    const chart = parseChart(doc.chart, source);
    if (chart) out.chart = chart;
  }
  if (
    doc.animatedTrack === "camera" ||
    doc.animatedTrack === "layeredScreenshot" ||
    doc.animatedTrack === "compare" ||
    doc.animatedTrack === "chart"
  ) {
    out.animatedTrack = doc.animatedTrack;
  } else if (doc.animatedTrack !== undefined) {
    console.warn(
      `[sceneDoc] ${source}: animatedTrack isn't camera|layeredScreenshot|compare|chart, dropped`,
    );
  }
  return out;
}

/** The distinct font refs the docs' `textStyle.<key>Font` overrides and `chart.font` reference; feeds the pin/preload pipeline beside the theme collector, so a face a doc names is generated before frame 0 rather than mid-run (docs/determinism.md, "Fonts"). */
export function collectSceneDocFontRefs(docs: readonly (SceneDoc | undefined)[]): FontRef[] {
  const seen = new Map<string, FontRef>();
  const take = (value: string) => {
    const ref = parseFontString(value);
    seen.set(`${ref.family}:${ref.weight}`, ref);
  };
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc?.textStyle ?? {})) {
      if (key.endsWith("Font") && typeof value === "string") take(value);
    }
    if (typeof doc?.chart?.font === "string") take(doc.chart.font);
    for (const deco of doc?.frame?.decorations ?? []) {
      if (typeof deco.font === "string") take(deco.font);
    }
  }
  return [...seen.values()];
}
