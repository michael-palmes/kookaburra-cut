import { parseWarn } from "./parseWarnings";
import type { SceneDoc } from "./sceneDocSchema";
import {
  SHUTTER_DEG_DEFAULT,
  SHUTTER_DEG_MAX,
  SHUTTER_SAMPLE_COUNTS,
  SHUTTER_SAMPLES_DEFAULT,
  type ShutterSamples,
} from "./shutter";

// Motion blur settings: project `render.motionBlur`, the sidecar scene layer and per-item overrides; absent means off.

/** The project layer. */
export interface MotionBlurSettings {
  enabled: boolean;
  /** 0..360: the share of each frame interval the shutter stays open. */
  shutterDeg: number;
  /** Renders averaged per blurred frame; project-wide, never per scene. */
  samples: ShutterSamples;
  /** Blur from camera moves. */
  camera: boolean;
  /** Blur from anything that moves on its own (devices, media, text, charts). */
  objects: boolean;
}

/** The scene layer: each present field replaces the project's. */
export interface SceneDocMotionBlur {
  enabled?: boolean;
  shutterDeg?: number;
  camera?: boolean;
  objects?: boolean;
}

/** A per-item override. Absent inherits the scene; `enabled: false` pins the item at the frame instant; `amount` scales how far its own time travels inside the shutter. */
export interface MotionBlurOverride {
  enabled: boolean;
  amount?: number;
}

/** One scene's resolved shutter. */
export interface SceneMotionBlur {
  shutterDeg: number;
  camera: boolean;
  objects: boolean;
  /** Objects is on, or an item opts in while it is off: the frame then samples object time. */
  objectsActive: boolean;
}

export const MOTION_BLUR_AMOUNT_MAX = 2;

export const DEFAULT_MOTION_BLUR: MotionBlurSettings = {
  enabled: false,
  shutterDeg: SHUTTER_DEG_DEFAULT,
  samples: SHUTTER_SAMPLES_DEFAULT,
  camera: true,
  objects: true,
};

export const SHUTTER_PRESETS = [
  { id: "crisp", label: "Crisp", deg: 90 },
  { id: "film", label: "Film", deg: 180 },
  { id: "smooth", label: "Smooth", deg: 270 },
  { id: "smear", label: "Smear", deg: 360 },
] as const;

export const SAMPLE_PRESETS = [
  { id: "quick", label: "Quick", samples: 4 },
  { id: "standard", label: "Standard", samples: 8 },
  { id: "fine", label: "Fine", samples: 16 },
] as const satisfies readonly { id: string; label: string; samples: ShutterSamples }[];

type Warn = (message: string) => void;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readBool(block: Record<string, unknown>, key: string, warn: Warn): boolean | undefined {
  const v = block[key];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  warn(`${key} isn't a boolean, ignored`);
  return undefined;
}

function readShutter(block: Record<string, unknown>, warn: Warn): number | undefined {
  const v = block.shutterDeg;
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    warn("shutterDeg isn't a number, ignored");
    return undefined;
  }
  const clamped = Math.min(SHUTTER_DEG_MAX, Math.max(0, v));
  if (clamped !== v) warn(`shutterDeg ${v} clamped to ${clamped}`);
  return clamped;
}

/** Snaps any sample count to the nearest allowed one (ties go to the cheaper). */
export function snapSamples(n: number): ShutterSamples {
  let best: ShutterSamples = SHUTTER_SAMPLE_COUNTS[0];
  for (const c of SHUTTER_SAMPLE_COUNTS) {
    if (Math.abs(c - n) < Math.abs(best - n)) best = c;
  }
  return best;
}

/** Parses `render.motionBlur`; absent stays absent (off), malformed fields fall back with a warning. */
export function parseMotionBlurSettings(
  raw: unknown,
  source: string,
): MotionBlurSettings | undefined {
  if (raw === undefined) return undefined;
  const warn: Warn = (m) => parseWarn(`[render] ${source}: motionBlur ${m}`);
  if (!isRecord(raw)) {
    warn("isn't an object, ignored");
    return undefined;
  }
  let samples = SHUTTER_SAMPLES_DEFAULT;
  if (raw.samples !== undefined) {
    if (typeof raw.samples === "number" && Number.isFinite(raw.samples)) {
      samples = snapSamples(raw.samples);
      if (samples !== raw.samples) warn(`samples ${raw.samples} snapped to ${samples}`);
    } else {
      warn(`samples isn't a number, using ${SHUTTER_SAMPLES_DEFAULT}`);
    }
  }
  return {
    enabled: readBool(raw, "enabled", warn) ?? DEFAULT_MOTION_BLUR.enabled,
    shutterDeg: readShutter(raw, warn) ?? DEFAULT_MOTION_BLUR.shutterDeg,
    samples,
    camera: readBool(raw, "camera", warn) ?? DEFAULT_MOTION_BLUR.camera,
    objects: readBool(raw, "objects", warn) ?? DEFAULT_MOTION_BLUR.objects,
  };
}

/** True when the settings say nothing the absent block wouldn't, so the writer can drop them. */
export function isDefaultMotionBlur(settings: MotionBlurSettings | undefined): boolean {
  if (!settings) return true;
  return (
    settings.enabled === DEFAULT_MOTION_BLUR.enabled &&
    settings.shutterDeg === DEFAULT_MOTION_BLUR.shutterDeg &&
    settings.samples === DEFAULT_MOTION_BLUR.samples &&
    settings.camera === DEFAULT_MOTION_BLUR.camera &&
    settings.objects === DEFAULT_MOTION_BLUR.objects
  );
}

/** Parses the sidecar `motionBlur` block, keeping only valid fields; an empty block is dropped. */
export function parseSceneMotionBlur(raw: unknown, source: string): SceneDocMotionBlur | undefined {
  const warn: Warn = (m) => parseWarn(`[sceneDoc] ${source}: motionBlur ${m}`);
  if (!isRecord(raw)) {
    warn("isn't an object, dropped");
    return undefined;
  }
  const out: SceneDocMotionBlur = {};
  const enabled = readBool(raw, "enabled", warn);
  if (enabled !== undefined) out.enabled = enabled;
  const shutterDeg = readShutter(raw, warn);
  if (shutterDeg !== undefined) out.shutterDeg = shutterDeg;
  const camera = readBool(raw, "camera", warn);
  if (camera !== undefined) out.camera = camera;
  const objects = readBool(raw, "objects", warn);
  if (objects !== undefined) out.objects = objects;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parses a per-item `motionBlur` override; anything malformed inherits. */
export function parseMotionBlurOverride(
  raw: unknown,
  source: string,
): MotionBlurOverride | undefined {
  if (raw === undefined) return undefined;
  const warn: Warn = (m) => parseWarn(`[sceneDoc] ${source}: motionBlur ${m}`);
  if (!isRecord(raw) || typeof raw.enabled !== "boolean") {
    warn("needs a boolean enabled, dropped");
    return undefined;
  }
  const out: MotionBlurOverride = { enabled: raw.enabled };
  if (raw.amount !== undefined) {
    if (typeof raw.amount === "number" && Number.isFinite(raw.amount)) {
      out.amount = Math.min(MOTION_BLUR_AMOUNT_MAX, Math.max(0, raw.amount));
      if (out.amount !== raw.amount) warn(`amount ${raw.amount} clamped to ${out.amount}`);
    } else {
      warn("amount isn't a number, ignored");
    }
  }
  return out;
}

/** True when an item in the scene switches its own blur on (what still blurs under Objects off). */
export function sceneHasMotionBlurOptIn(
  doc: SceneDoc | undefined,
  themeText?: { motionBlur?: MotionBlurOverride },
): boolean {
  const on = (o: { motionBlur?: MotionBlurOverride } | undefined) =>
    o?.motionBlur?.enabled === true;
  return (
    !!doc?.devices?.some(on) ||
    !!doc?.media?.some(on) ||
    on(doc?.textAnimation ?? themeText) ||
    Object.values(doc?.textAnimationOverrides ?? {}).some(on) ||
    on(doc?.chart?.animation) ||
    on(doc?.layeredScreenshot)
  );
}

/** The scene's shutter, or null when motion blur is off for it. */
export function resolveSceneMotionBlur(
  project: MotionBlurSettings | undefined,
  scene: SceneDocMotionBlur | undefined,
  optIn = false,
): SceneMotionBlur | null {
  const enabled = scene?.enabled ?? project?.enabled ?? false;
  if (!enabled) return null;
  const objects = scene?.objects ?? project?.objects ?? DEFAULT_MOTION_BLUR.objects;
  return {
    shutterDeg: scene?.shutterDeg ?? project?.shutterDeg ?? DEFAULT_MOTION_BLUR.shutterDeg,
    camera: scene?.camera ?? project?.camera ?? DEFAULT_MOTION_BLUR.camera,
    objects,
    objectsActive: objects || optIn,
  };
}

/** An item's `useTimeline` scale: undefined inherits the scene's Objects switch, 0 pins it at the frame instant. */
export function motionBlurScale(override: MotionBlurOverride | undefined): number | undefined {
  if (!override) return undefined;
  return override.enabled ? (override.amount ?? 1) : 0;
}
