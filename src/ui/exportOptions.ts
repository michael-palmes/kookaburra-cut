/** Pure option/maths logic for the export modal, the stageOptions/textAnimationOptions pattern: everything the modal computes lives here, unit-pinned, so the component is layout only. The size-estimate and Fit-to-cap maths are golden-tested (decision 18: estimate = (video + audio) kbps × duration × 1.05 mux margin; over-cap warns amber + one-click fit, never silent, never blocking). */

import type { AspectName } from "../engine/format";
import {
  type EncodeSpec,
  EXPORT_PRESET_VERSION,
  type ExportPresetDoc,
  resolvePresetToEncodeSpec,
} from "../export/presetSchema";

/** The frozen legacy path's row id: exports with no EncodeSpec (Michael's call: a first-class row, so the frozen path stays one honest click). */
export const KOOKABURRA_STANDARD_ID = "kookaburra-standard";
export const CUSTOM_ID = "custom";

/** Decision 18's mux margin. */
export const MUX_MARGIN = 1.05;

export const ALL_ASPECTS: AspectName[] = ["16:9", "9:16", "1:1", "4:5"];

/** Aspects a preset may export (absent allowedAspects = unrestricted). */
export function presetAspects(doc: ExportPresetDoc): AspectName[] {
  return doc.allowedAspects?.length ? doc.allowedAspects : ALL_ASPECTS;
}

// ── Size estimates & Fit to cap ───────────────────────────────────────────────

/** Audio bitrate for the estimate: AAC as stated; PCM = 48 kHz × bits × stereo. */
export function audioKbpsOf(doc: ExportPresetDoc): number {
  if ("aacKbps" in doc.audio.codec) return doc.audio.codec.aacKbps;
  return (48_000 * doc.audio.codec.pcmBits * 2) / 1000;
}

/** Projected file size in MB for bitrate-mode presets; null for CRF/ProRes ("size varies with content", the check is skipped, decision 18). `audioKbps` is 0 when the project has no soundtrack (`-an` writes no audio bits). */
export function estimateSizeMB(
  doc: ExportPresetDoc,
  durationMs: number,
  audioKbps: number,
): number | null {
  const rate = doc.video.rate;
  if (!("targetKbps" in rate)) return null;
  const seconds = durationMs / 1000;
  return ((rate.targetKbps + audioKbps) * seconds * MUX_MARGIN) / 8 / 1000;
}

/** Solve the target bitrate back from the cap (the estimate formula inverted), scaling max/bufsize along by the same ratio. Floors at 500 kbps: a cap so tight it demands less is a duration problem, not a bitrate one. */
export function fitToCap(
  rate: { targetKbps: number; maxKbps: number; bufsizeKbps: number; twoPass?: boolean },
  capMB: number,
  durationMs: number,
  audioKbps: number,
): { targetKbps: number; maxKbps: number; bufsizeKbps: number; twoPass?: boolean } {
  const seconds = durationMs / 1000;
  const totalKbps = (capMB * 1000 * 8) / (seconds * MUX_MARGIN);
  const target = Math.max(500, Math.floor(totalKbps - audioKbps));
  const scale = target / rate.targetKbps;
  return {
    ...rate,
    targetKbps: target,
    maxKbps: Math.round(rate.maxKbps * scale),
    bufsizeKbps: Math.round(rate.bufsizeKbps * scale),
  };
}

// ── Row chips (codec · res@fps · rate · cap · fast-draft) ────────────────────

const CODEC_LABEL: Record<EncodeSpec["codec"], string> = {
  libx264: "H.264",
  libx265: "HEVC",
  h264_videotoolbox: "H.264",
  hevc_videotoolbox: "HEVC",
  prores_ks: "ProRes 422 HQ",
};

export function isVideotoolbox(codec: EncodeSpec["codec"]): boolean {
  return codec === "h264_videotoolbox" || codec === "hevc_videotoolbox";
}

export function specChips(doc: ExportPresetDoc): string[] {
  const v = doc.video;
  const chips: string[] = [CODEC_LABEL[v.codec]];
  const res = v.scaleShortEdgeTo ? `${v.scaleShortEdgeTo}p` : "Native";
  chips.push(`${res} @ ${v.fps}fps`);
  if (v.codec !== "prores_ks") {
    chips.push(
      "crf" in v.rate
        ? `CRF ${v.rate.crf}`
        : `${v.rate.targetKbps / 1000} Mbps${"twoPass" in v.rate && v.rate.twoPass ? " two-pass" : ""}`,
    );
  }
  if (doc.maxFileSizeMB) chips.push(`≤ ${doc.maxFileSizeMB} MB`);
  if (isVideotoolbox(v.codec)) chips.push("fast draft — excluded from Verify");
  return chips;
}

// ── Grouping, search, aspect filtering ───────────────────────────────────────

export interface PresetRow {
  /** Selection id: bundled id, or `ws:<slug>` for user presets. */
  id: string;
  doc: ExportPresetDoc;
  isUser: boolean;
}

export interface PresetGroup {
  platform: string;
  rows: PresetRow[];
}

function matches(doc: ExportPresetDoc, search: string, aspect: AspectName | null): boolean {
  if (aspect && !presetAspects(doc).includes(aspect)) return false;
  if (!search) return true;
  const q = search.toLowerCase();
  return [doc.name, doc.description, doc.platform].some((s) => s.toLowerCase().includes(q));
}

/** The left rail's groups: bundled presets grouped by platform in lineup order (the grouping is the platform filter), then *Your presets*. Search matches name/description/platform; the aspect chip filters on `allowedAspects`. */
export function groupPresets(
  bundled: ExportPresetDoc[],
  user: PresetRow[],
  search: string,
  aspect: AspectName | null,
): PresetGroup[] {
  const groups: PresetGroup[] = [];
  for (const doc of bundled) {
    if (!matches(doc, search, aspect)) continue;
    const row: PresetRow = { id: doc.id, doc, isUser: false };
    const group = groups.find((g) => g.platform === doc.platform);
    if (group) group.rows.push(row);
    else groups.push({ platform: doc.platform, rows: [row] });
  }
  const yours = user.filter((r) => matches(r.doc, search, aspect));
  if (yours.length) groups.push({ platform: "Your presets", rows: yours });
  return groups;
}

// ── The Custom panel (the decision-20 knob set) ──────────────────────────────

export interface CustomDraft {
  codec: EncodeSpec["codec"];
  /** Short-edge target; null = native render resolution. */
  shortEdge: number | null;
  fps: 30 | 60;
  rateMode: "crf" | "bitrate";
  crf: number;
  targetKbps: number;
  maxKbps: number;
  bufsizeKbps: number;
  twoPass: boolean;
  /** "" = leave to the encoder. */
  profile: string;
  level: string;
  /** null = auto (no -g flag). */
  gopSeconds: number | null;
  bFrames: number | null;
  entropy: "" | "cabac" | "cavlc";
  tenBit: boolean;
  faststart: boolean;
  colourTags: boolean;
  audioMode: "aac" | "pcm";
  aacKbps: number;
  pcmBits: 16 | 24;
  /** null = off (no loudness correction). */
  loudnessTarget: number | null;
}

/** Decision 24: the current export method surfaces as Custom's seed values, libx264 CRF 18, native res, 60 fps, no tags, no faststart, AAC 192. */
export function customSeed(): CustomDraft {
  return {
    codec: "libx264",
    shortEdge: null,
    fps: 60,
    rateMode: "crf",
    crf: 18,
    targetKbps: 12000,
    maxKbps: 16000,
    bufsizeKbps: 24000,
    twoPass: false,
    profile: "",
    level: "",
    gopSeconds: null,
    bFrames: null,
    entropy: "",
    tenBit: false,
    faststart: false,
    colourTags: false,
    audioMode: "aac",
    aacKbps: 192,
    pcmBits: 16,
    loudnessTarget: null,
  };
}

/** Seed a Custom draft from an existing preset (the Duplicate… flow). */
export function draftFromDoc(doc: ExportPresetDoc): CustomDraft {
  const seed = customSeed();
  const v = doc.video;
  const bitrate = "targetKbps" in v.rate ? v.rate : null;
  return {
    ...seed,
    codec: v.codec,
    shortEdge: v.scaleShortEdgeTo ?? null,
    fps: v.fps,
    rateMode: bitrate ? "bitrate" : "crf",
    crf: "crf" in v.rate ? v.rate.crf : seed.crf,
    targetKbps: bitrate?.targetKbps ?? seed.targetKbps,
    maxKbps: bitrate?.maxKbps ?? seed.maxKbps,
    bufsizeKbps: bitrate?.bufsizeKbps ?? seed.bufsizeKbps,
    twoPass: bitrate ? (bitrate.twoPass ?? false) : false,
    profile: v.profile ?? "",
    level: v.level ?? "",
    gopSeconds: v.gopSeconds ?? null,
    bFrames: v.bFrames ?? null,
    entropy: (v.entropy as "" | "cabac" | "cavlc") ?? "",
    tenBit: v.tenBit ?? false,
    faststart: v.faststart,
    colourTags: v.colourTags,
    audioMode: "pcmBits" in doc.audio.codec ? "pcm" : "aac",
    aacKbps: "aacKbps" in doc.audio.codec ? doc.audio.codec.aacKbps : seed.aacKbps,
    pcmBits: "pcmBits" in doc.audio.codec ? (doc.audio.codec.pcmBits as 16 | 24) : seed.pcmBits,
    loudnessTarget: doc.audio.loudnessTarget ?? null,
  };
}

/** Materialise a draft as a preset document (Save-as-preset + the one resolve/rejection implementation, `resolvePresetToEncodeSpec` runs on this doc). */
export function draftToDoc(
  draft: CustomDraft,
  id: string,
  name: string,
  description: string,
  platform = "Custom",
  favouredAspect: AspectName = "16:9",
): ExportPresetDoc {
  return {
    version: EXPORT_PRESET_VERSION,
    id,
    name,
    description,
    platform,
    favouredAspect,
    video: {
      codec: draft.codec,
      ...(draft.shortEdge ? { scaleShortEdgeTo: draft.shortEdge } : {}),
      fps: draft.fps,
      rate:
        draft.rateMode === "crf"
          ? { crf: draft.crf }
          : {
              targetKbps: draft.targetKbps,
              maxKbps: draft.maxKbps,
              bufsizeKbps: draft.bufsizeKbps,
              ...(draft.twoPass ? { twoPass: true } : {}),
            },
      ...(draft.profile ? { profile: draft.profile } : {}),
      ...(draft.level ? { level: draft.level } : {}),
      ...(draft.gopSeconds != null ? { gopSeconds: draft.gopSeconds } : {}),
      ...(draft.bFrames != null ? { bFrames: draft.bFrames } : {}),
      ...(draft.entropy ? { entropy: draft.entropy } : {}),
      ...(draft.tenBit ? { tenBit: true } : {}),
      faststart: draft.faststart,
      colourTags: draft.colourTags,
    },
    audio: {
      codec: draft.audioMode === "aac" ? { aacKbps: draft.aacKbps } : { pcmBits: draft.pcmBits },
      ...(draft.loudnessTarget != null ? { loudnessTarget: draft.loudnessTarget } : {}),
    },
  };
}

/** Resolve a draft to the backend spec, or the readable rejection to show inline. */
export function resolveDraft(
  draft: CustomDraft,
): { spec: EncodeSpec; error?: undefined } | { spec?: undefined; error: string } {
  try {
    const spec = resolvePresetToEncodeSpec(draftToDoc(draft, CUSTOM_ID, "Custom", ""));
    return { spec };
  } catch (e) {
    return { error: e instanceof Error ? e.message.replace(/^Custom: /, "") : String(e) };
  }
}

/** Slug for Save-as-preset: the workspace slug rules (lowercase, hyphenated). */
export function slugifyPresetName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
