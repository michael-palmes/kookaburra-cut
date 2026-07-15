import type { AspectName } from "../engine/format";

/** Export presets: the JSON document schema, the degrade-don't-crash parser (the theme-parser precedent), and the resolve step that turns a preset into the fully-resolved `EncodeSpec` Rust builds argv from. THE FROZEN-PATH RULE: an export carrying no spec runs today's byte-pinned legacy argv; presets never touch the standing baselines or Verify. */

/** The fully-resolved encode the backend consumes (mirrors Rust's `EncodeSpec`). */
export interface EncodeSpec {
  codec: "libx264" | "libx265" | "h264_videotoolbox" | "hevc_videotoolbox" | "prores_ks";
  scaleShortEdgeTo?: number;
  fps: 30 | 60;
  rate:
    | { crf: number }
    | { targetKbps: number; maxKbps: number; bufsizeKbps: number; twoPass?: boolean };
  profile?: string;
  level?: string;
  gopSeconds?: number;
  bFrames?: number;
  entropy?: string;
  tenBit?: boolean;
  faststart?: boolean;
  colourTags?: boolean;
  audio?: {
    codec: { aacKbps: number } | { pcmBits: number };
    loudnessGainDb?: number;
  };
}

export const EXPORT_PRESET_VERSION = 1;

/** One preset document (`src/export/presets/*.json` bundled; `~/Kookaburra Cut/export-presets/` for user presets, `ws:` ids). Descriptions are one AU-English sentence for non-technical folk. */
export interface ExportPresetDoc {
  version: number;
  id: string;
  name: string;
  description: string;
  platform: string;
  favouredAspect: AspectName;
  allowedAspects?: AspectName[];
  maxFileSizeMB?: number;
  notes?: string;
  video: {
    codec: EncodeSpec["codec"];
    scaleShortEdgeTo?: number;
    fps: 30 | 60;
    rate: EncodeSpec["rate"];
    profile?: string;
    level?: string;
    gopSeconds?: number;
    bFrames?: number;
    entropy?: string;
    tenBit?: boolean;
    faststart: boolean;
    colourTags: boolean;
  };
  audio: {
    codec: { aacKbps: number } | { pcmBits: number };
    /** Integrated-loudness target, LUFS (gain-only correction; warn, never limit). */
    loudnessTarget?: number;
  };
}

const ASPECTS: readonly string[] = ["16:9", "9:16", "1:1", "4:5"];

function isRate(v: unknown): v is EncodeSpec["rate"] {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.crf === "number") return true;
  return (
    typeof r.targetKbps === "number" &&
    typeof r.maxKbps === "number" &&
    typeof r.bufsizeKbps === "number"
  );
}

/** Validate a raw preset document, returning undefined (with a console warning) on structural problems so a bad user preset never breaks the export modal. */
export function parseExportPreset(raw: unknown, source: string): ExportPresetDoc | undefined {
  if (typeof raw !== "object" || raw === null) {
    console.warn(`[export-preset] ${source}: not an object — ignored`);
    return undefined;
  }
  const d = raw as Record<string, unknown>;
  if (d.version !== EXPORT_PRESET_VERSION) {
    console.warn(`[export-preset] ${source}: unsupported version — ignored`);
    return undefined;
  }
  const video = d.video as Record<string, unknown> | undefined;
  const audio = d.audio as Record<string, unknown> | undefined;
  if (
    typeof d.id !== "string" ||
    typeof d.name !== "string" ||
    typeof d.description !== "string" ||
    typeof d.platform !== "string" ||
    !ASPECTS.includes(d.favouredAspect as string) ||
    !video ||
    typeof video.codec !== "string" ||
    (video.fps !== 30 && video.fps !== 60) ||
    !isRate(video.rate) ||
    typeof video.faststart !== "boolean" ||
    typeof video.colourTags !== "boolean" ||
    !audio ||
    typeof audio.codec !== "object"
  ) {
    console.warn(`[export-preset] ${source}: missing/invalid required fields — ignored`);
    return undefined;
  }
  return raw as ExportPresetDoc;
}

/** Resolve a preset into the backend spec, throwing readable errors on rejected combinations at resolve time so the modal can show them next to the preset; `loudnessGainDb` arrives separately since the caller measures first (cached). */
export function resolvePresetToEncodeSpec(
  doc: ExportPresetDoc,
  loudnessGainDb?: number,
): EncodeSpec {
  const v = doc.video;
  const videotoolbox = v.codec === "h264_videotoolbox" || v.codec === "hevc_videotoolbox";
  const twoPass = "twoPass" in v.rate && v.rate.twoPass === true;
  if (videotoolbox && "crf" in v.rate) {
    throw new Error(`${doc.name}: VideoToolbox is bitrate-only (no CRF)`);
  }
  if (videotoolbox && twoPass) {
    throw new Error(`${doc.name}: VideoToolbox cannot two-pass`);
  }
  if (twoPass && v.codec !== "libx264" && v.codec !== "libx265") {
    throw new Error(`${doc.name}: two-pass needs libx264 or libx265`);
  }
  if ("pcmBits" in doc.audio.codec && v.codec !== "prores_ks") {
    throw new Error(`${doc.name}: PCM audio requires the .mov (ProRes) container`);
  }
  return {
    codec: v.codec,
    scaleShortEdgeTo: v.scaleShortEdgeTo,
    fps: v.fps,
    rate: v.rate,
    profile: v.profile,
    level: v.level,
    gopSeconds: v.gopSeconds,
    bFrames: v.bFrames,
    entropy: v.entropy,
    tenBit: v.tenBit,
    faststart: v.faststart,
    colourTags: v.colourTags,
    audio: {
      codec: doc.audio.codec,
      ...(loudnessGainDb !== undefined ? { loudnessGainDb } : {}),
    },
  };
}
