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
  DeviceMediaSpec,
  DeviceMotionSpec,
  DevicePlacement,
  DeviceShadowMode,
} from "../toolkit/device/Device";
import type { FrameOverrideSpec } from "../toolkit/frame/types";
import { parseFrameOverride } from "./frameSchema";
import { normalizeLighting } from "./sceneLighting";

/** The per-scene sidecar schema (`scenes/<stem>.json` beside a scene's TSX): holds everything machine-editable (name, text, devices, camera, duration), written atomically via `write_scene_doc`; this module is pure (types + validation only) so it's unit-testable and safe to import anywhere, with IO and hooks living in `sceneDoc.ts`. Field docs: the kookaburra-scene-authoring skill; rationale: docs/decisions.md. */

/** Newest sidecar schema this build understands (newer docs are ignored with a warning). */
export const SCENE_DOC_VERSION = 1;

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
  /** Per-channel ease overrides; absent means the segment's own `ease` (position covers position, rotation covers aim and roll, lens covers fov). */
  easePosition?: string;
  easeRotation?: string;
  easeLens?: string;
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
  /** Per-text-element overrides keyed `<textKey><Suffix>`: `Color` (raw hex fill, the one narrow exception to "colours stay tokens"), `Font` ("Family" or "Family@weight"), `Size` (multiplier of the element's default, 1 = unchanged) and `OffsetX`/`OffsetY` (world-unit nudges from the scene's layout); consumed by text primitives given a matching `textKey`, inert otherwise. */
  textStyle?: Record<string, string | number>;
  /** Header icon for a plain (non-overlay) scene's text: an emoji or an `assets/` image path, drawn above the headline by `TextFallback`/`TitleBlock`. Overlay scenes carry their icon on `frame.icon` instead. */
  headerIcon?: string;
  devices?: SceneDocDeviceSpec[];
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
  /** Which animated track drives this scene; absent = "camera" (null-for-legacy). Switching never deletes the other tracks' keys. */
  animatedTrack?: "camera" | "layeredScreenshot" | "compare";
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
      } else {
        console.warn(
          `[sceneDoc] ${source}: textStyle.${key} isn't a <textKey>Color|Font|Size|OffsetX|OffsetY key, dropped`,
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
  if (
    doc.animatedTrack === "camera" ||
    doc.animatedTrack === "layeredScreenshot" ||
    doc.animatedTrack === "compare"
  ) {
    out.animatedTrack = doc.animatedTrack;
  } else if (doc.animatedTrack !== undefined) {
    console.warn(
      `[sceneDoc] ${source}: animatedTrack isn't camera|layeredScreenshot|compare, dropped`,
    );
  }
  return out;
}

/** The distinct font refs the docs' `textStyle.<key>Font` overrides reference; feeds the pin/preload pipeline beside the theme collector. */
export function collectSceneDocFontRefs(docs: readonly (SceneDoc | undefined)[]): FontRef[] {
  const seen = new Map<string, FontRef>();
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc?.textStyle ?? {})) {
      if (key.endsWith("Font") && typeof value === "string") {
        const ref = parseFontString(value);
        seen.set(`${ref.family}:${ref.weight}`, ref);
      }
    }
  }
  return [...seen.values()];
}
