import type { AspectName } from "../engine/format";

/** Export presets: the JSON document schema, the degrade-don't-crash parser (the theme-parser precedent), and the resolve step that turns a preset into the fully-resolved `EncodeSpec` Rust builds argv from. THE FROZEN-PATH RULE: an export carrying no spec runs today's byte-pinned legacy argv; presets never touch the standing baselines or Verify. */

/** The fully-resolved encode the backend consumes (mirrors Rust's `EncodeSpec`). */
export interface EncodeSpec {
  codec:
    | "libx264"
    | "libx265"
    | "h264_videotoolbox"
    | "hevc_videotoolbox"
    | "prores_ks"
    | "prores_videotoolbox";
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
  posterFrame?: boolean;
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

const ASPECTS: readonly string[] = [
  "16:9",
  "9:16",
  "1:1",
  "4:5",
  "5:4",
  "3:2",
  "2:3",
  "phone",
  "phone-landscape",
];

/** `-profile:v` per encoder; anything else never reaches ffmpeg argv (Rust checks the same lists on the spec). */
const PROFILES: Record<EncodeSpec["codec"], readonly string[]> = {
  libx264: ["baseline", "main", "high", "high10", "high422", "high444"],
  h264_videotoolbox: ["baseline", "main", "high", "extended"],
  libx265: ["main", "main10", "main422-10", "main444-8", "main444-10"],
  hevc_videotoolbox: ["main", "main10"],
  prores_ks: ["proxy", "lt", "standard", "hq", "4444", "4444xq", "0", "1", "2", "3", "4", "5"],
  prores_videotoolbox: [
    "proxy",
    "lt",
    "standard",
    "hq",
    "4444",
    "4444xq",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
  ],
};

/** `auto`, `1b`, or a major 1 to 6 with an optional `.0` to `.2` minor. */
const LEVEL = /^(auto|1b|[1-6](\.[0-2])?)$/;

const ENTROPY: readonly string[] = ["cabac", "cavlc", "ac", "vlc"];

/** Why the three free-text encoder fields of a video block are not accepted, or undefined when they are. */
export function encoderFieldProblem(video: {
  codec: string;
  profile?: unknown;
  level?: unknown;
  entropy?: unknown;
}): string | undefined {
  const profiles = PROFILES[video.codec as EncodeSpec["codec"]];
  if (!profiles) return `unknown codec "${video.codec}"`;
  if (video.profile !== undefined) {
    if (typeof video.profile !== "string" || !profiles.includes(video.profile)) {
      return `profile must be one of ${profiles.join(", ")}`;
    }
  }
  if (video.level !== undefined) {
    if (typeof video.level !== "string" || !LEVEL.test(video.level)) {
      return "level must be auto, 1b, or 1 to 6.2";
    }
  }
  if (video.entropy !== undefined) {
    if (typeof video.entropy !== "string" || !ENTROPY.includes(video.entropy)) {
      return "entropy must be cabac or cavlc";
    }
  }
  return undefined;
}

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
  const problem = encoderFieldProblem(video as { codec: string });
  if (problem) {
    console.warn(`[export-preset] ${source}: ${problem}, ignored`);
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
  if (
    "pcmBits" in doc.audio.codec &&
    v.codec !== "prores_ks" &&
    v.codec !== "prores_videotoolbox"
  ) {
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
