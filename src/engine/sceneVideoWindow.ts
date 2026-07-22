/** VideoWindow engine core: deep validation of the sidecar block (degrade-don't-crash, the sceneLayeredScreenshot pattern), radius-preset resolution, and motion sampling. Pure (no three.js, no clock reads) so preview and export agree by construction. */

import { ease } from "./ease";
import type {
  SceneDocVideoWindow,
  VideoWindowBorder,
  VideoWindowMotion,
  VideoWindowMotionPreset,
  VideoWindowRadius,
  VideoWindowStage,
} from "./sceneDocSchema";

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
/** tilt-reveal starts the window this far toward the camera and eases it back to 0, so the tilt never swings an edge behind the backing stage. */
const TILT_FORWARD = 1.4;

/** Corner radius per preset, as a fraction of the window's SHORT edge (the ThemeCard convention); `macos` is tuned to a real window shown large in frame. */
const RADIUS_PRESETS: Record<Exclude<VideoWindowRadius, { custom: number }>, number> = {
  sharp: 0,
  subtle: 0.02,
  macos: 0.035,
  rounded: 0.08,
};

const DEFAULT_RADIUS = RADIUS_PRESETS.macos;
/** Window occupies this fraction of the frame's shorter axis by default, leaving a wallpaper margin. */
const DEFAULT_SCALE = 0.72;
const DEFAULT_SHADOW = { opacity: 0.32, blur: 0.14, offset: [0, -0.05] as [number, number] };
/** Matches the old fixed hairline rim, so a window with no `border` field renders byte-identically. */
const DEFAULT_BORDER: VideoWindowBorder = {
  enabled: true,
  color: "#ffffff",
  width: 0.0035,
  opacity: 0.12,
};

/** Resolved, defaults-filled shadow: fractions of the window's short edge except opacity (0..1). */
export interface NormalizedVideoWindowShadow {
  opacity: number;
  blur: number;
  offset: [number, number];
}

/** A validated, defaults-filled videoWindow ready to render. */
export interface NormalizedVideoWindow {
  media: { src: string; startMs: number; loop: boolean };
  stage: VideoWindowStage;
  radiusFraction: number;
  border: VideoWindowBorder;
  shadow: NormalizedVideoWindowShadow;
  motion: VideoWindowMotion;
  scale: number;
}

const MOTION_PRESETS: VideoWindowMotionPreset[] = [
  "none",
  "float",
  "tilt-reveal",
  "push-in",
  "drift",
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Radius preset → short-edge fraction; a `{ custom }` value is clamped 0..0.5, anything invalid falls back to the macOS look. */
export function resolveVideoWindowRadius(radius: VideoWindowRadius | undefined): number {
  if (typeof radius === "string") return RADIUS_PRESETS[radius] ?? DEFAULT_RADIUS;
  const custom = radius?.custom;
  return Number.isFinite(custom) ? clamp(custom as number, 0, 0.5) : DEFAULT_RADIUS;
}

function normalizeStage(raw: unknown, source: string): VideoWindowStage {
  const fallback: VideoWindowStage = { type: "color", color: "#111111" };
  const stage = raw as VideoWindowStage | null;
  if (!stage || typeof stage !== "object") return fallback;
  if (stage.type === "color" && typeof stage.color === "string" && stage.color.length > 0) {
    return { type: "color", color: stage.color };
  }
  if (stage.type === "gradient" && stage.spec && Array.isArray(stage.spec.stops)) {
    return { type: "gradient", spec: stage.spec };
  }
  if (stage.type === "image" && typeof stage.src === "string" && stage.src.length > 0) {
    return {
      type: "image",
      src: stage.src,
      ...(stage.fit === "contain" ? { fit: "contain" } : {}),
    };
  }
  console.warn(`[videoWindow] ${source}: invalid stage, defaulting to a flat colour`);
  return fallback;
}

function normalizeShadow(raw: unknown): NormalizedVideoWindowShadow {
  const s = raw as Partial<NormalizedVideoWindowShadow> | null;
  if (!s || typeof s !== "object") return { ...DEFAULT_SHADOW, offset: [...DEFAULT_SHADOW.offset] };
  const offset =
    Array.isArray(s.offset) && s.offset.length === 2 && s.offset.every((n) => Number.isFinite(n))
      ? ([s.offset[0], s.offset[1]] as [number, number])
      : ([...DEFAULT_SHADOW.offset] as [number, number]);
  return {
    opacity: Number.isFinite(s.opacity) ? clamp(s.opacity as number, 0, 1) : DEFAULT_SHADOW.opacity,
    blur:
      Number.isFinite(s.blur) && (s.blur as number) >= 0 ? (s.blur as number) : DEFAULT_SHADOW.blur,
    offset,
  };
}

function normalizeBorder(raw: unknown): VideoWindowBorder {
  const b = raw as Partial<VideoWindowBorder> | null;
  if (!b || typeof b !== "object") return { ...DEFAULT_BORDER };
  return {
    enabled: b.enabled !== false,
    color: typeof b.color === "string" && b.color.length > 0 ? b.color : DEFAULT_BORDER.color,
    width:
      Number.isFinite(b.width) && (b.width as number) >= 0
        ? (b.width as number)
        : DEFAULT_BORDER.width,
    opacity: Number.isFinite(b.opacity) ? clamp(b.opacity as number, 0, 1) : DEFAULT_BORDER.opacity,
  };
}

function normalizeMotion(raw: unknown): VideoWindowMotion {
  const m = raw as VideoWindowMotion | null;
  if (!m || typeof m !== "object" || !MOTION_PRESETS.includes(m.preset)) return { preset: "none" };
  return m;
}

/** Validate + normalize a sidecar videoWindow value. Null when absent or missing a media source; a present block otherwise always normalizes with defaults filled. */
export function normalizeVideoWindow(
  raw: SceneDocVideoWindow | undefined,
  source: string,
): NormalizedVideoWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw.media?.src;
  if (typeof src !== "string" || src.length === 0) {
    console.warn(`[videoWindow] ${source}: missing media.src, no window`);
    return null;
  }
  return {
    media: {
      src,
      startMs: Number.isFinite(raw.media.startMs) ? (raw.media.startMs as number) : 0,
      loop: raw.media.loop === true,
    },
    stage: normalizeStage(raw.stage, source),
    radiusFraction: resolveVideoWindowRadius(raw.radius),
    border: normalizeBorder(raw.border),
    shadow: normalizeShadow(raw.shadow),
    motion: normalizeMotion(raw.motion),
    scale: Number.isFinite(raw.scale) ? clamp(raw.scale as number, 0.1, 1) : DEFAULT_SCALE,
  };
}

/** The window group's transform at scene-local time: pure functions of the timeline value, never the wall clock (the DeviceMotionSpec presets, retuned for a floating window). */
export interface VideoWindowMotionSample {
  posX: number;
  posY: number;
  posZ: number;
  rotX: number;
  rotY: number;
  scale: number;
}

export function sampleVideoWindowMotion(
  motion: VideoWindowMotion,
  localMs: number,
): VideoWindowMotionSample {
  const t = localMs / 1000;
  const s: VideoWindowMotionSample = { posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, scale: 1 };
  switch (motion.preset) {
    case "float": {
      const amp = motion.amplitude ?? 0.12;
      const hz = motion.hz ?? 0.3;
      s.posY = amp * Math.sin(TWO_PI * hz * t);
      break;
    }
    case "drift": {
      const amp = (motion.amplitude ?? 4) * DEG2RAD;
      const hz = motion.hz ?? 0.1;
      s.rotY = amp * Math.sin(TWO_PI * hz * t);
      s.rotX = amp * 0.4 * Math.sin(TWO_PI * hz * t * 0.7 + 1);
      break;
    }
    case "tilt-reveal": {
      const p = ease("outCubic", Math.min(1, localMs / (motion.durationMs ?? 900)));
      s.rotX = (1 - p) * -12 * DEG2RAD;
      s.rotY = (1 - p) * -28 * DEG2RAD;
      // Ride forward at the tilted start so a swung edge stays in front of the stage, easing back to flush.
      s.posZ = (1 - p) * TILT_FORWARD;
      break;
    }
    case "push-in": {
      const p = ease("outCubic", Math.min(1, localMs / (motion.durationMs ?? 1000)));
      s.scale = 0.9 + 0.1 * p;
      s.rotY = (1 - p) * -6 * DEG2RAD;
      break;
    }
    default:
      break;
  }
  return s;
}
