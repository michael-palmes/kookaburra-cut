/** The Export button's selection, shared by the export modal and the bridge export so both hash alike: `resolveVideoSelection` turns a choice (High quality, Custom or a preset row) into the run's selection, `buildVideoExportOptions` turns that into `exportProject`'s options. Both are moves of the modal's and App's code, pinned by goldens in `selection.test.ts`. */

import type { ExportOptions } from "../engine/exporter";
import { type AspectName, FORMATS, FPS } from "../engine/format";
import type { LoadedProject, ProjectAudio } from "../engine/project";
import {
  CUSTOM_ID,
  type CustomDraft,
  customSeed,
  draftFromDoc,
  highQualityEncode,
  KOOKABURRA_STANDARD_ID,
  presetAspects,
  resolveDraft,
  withPosterFrame,
} from "../ui/exportOptions";
import { type EncodeSpec, type ExportPresetDoc, resolvePresetToEncodeSpec } from "./presetSchema";

/** A video run: App sets the format then runs exportProject. */
export interface VideoExportSelection {
  kind: "video";
  presetId: string;
  /** Absent = the frozen legacy path (Kookaburra Standard). */
  encode?: EncodeSpec;
  /** Absent = the legacy filename (only the standard row omits it). */
  outputSuffix?: string;
  aspect: AspectName;
}

export interface LoudnessMeasure {
  integratedLufs: number;
  truePeakDbtp: number;
}

/** Measures the soundtrack at an output rate and poster-frame state; null when the project has no soundtrack. */
export type MeasureLoudness = (
  fps: number,
  posterFrame: boolean,
) => Promise<LoudnessMeasure | null>;

/** What the person picked: the High quality row, the Custom panel, or a bundled or `ws:` preset row (with any Fit-to-cap rate). */
export type VideoChoice =
  | { kind: "standard" }
  | { kind: "custom"; draft: CustomDraft }
  | {
      kind: "preset";
      id: string;
      doc: ExportPresetDoc;
      fitted?: ExportPresetDoc["video"]["rate"] | null;
    };

export type ResolvedVideoSelection =
  | { sel: VideoExportSelection; error?: undefined }
  | { sel?: undefined; error: string };

/** The `measure_loudness` arguments: the export graph's frame count at the output rate (the render steps at that rate directly), plus the poster frame's leading silence. */
export function measureLoudnessArgs(
  audio: ProjectAudio,
  totalMs: number,
  outFps: number,
  posterFrame: boolean,
): Record<string, unknown> {
  const outFrames = Math.max(1, Math.round((totalMs / 1000) * outFps)) + (posterFrame ? 1 : 0);
  return {
    file: audio.abs,
    gainDb: audio.gainDb ?? 0,
    fadeInMs: audio.fadeInMs ?? 0,
    fadeOutMs: audio.fadeOutMs ?? 0,
    fadeOutCurve: audio.fadeOutCurve ?? null,
    startOffsetMs: audio.startOffsetMs ?? 0,
    trackDurationMs: Math.round(audio.durationMs),
    totalFrames: outFrames,
    fps: outFps,
    posterFrame,
  };
}

/** The gain (dB, two decimals) that lands the soundtrack on a loudness target; undefined without a target or a soundtrack. */
export async function loudnessGain(
  target: number | null,
  outFps: number,
  posterFrame: boolean,
  measure: MeasureLoudness,
): Promise<number | undefined> {
  if (target == null) return undefined;
  const m = await measure(outFps, posterFrame);
  if (!m) return undefined;
  return Math.round((target - m.integratedLufs) * 100) / 100;
}

/** The working aspect survives a preset hop whenever the preset allows it; only then its favoured aspect, else its first. */
export function aspectForPreset(doc: ExportPresetDoc, current: AspectName): AspectName {
  const allowed = presetAspects(doc);
  return allowed.includes(current)
    ? current
    : allowed.includes(doc.favouredAspect)
      ? doc.favouredAspect
      : allowed[0];
}

/** A choice as the run's selection, exactly as the modal's Export button resolves it. Rejections come back as `error`; a failed loudness measure throws. */
export async function resolveVideoSelection(
  choice: VideoChoice,
  aspect: AspectName,
  posterFrame: boolean,
  measure: MeasureLoudness,
): Promise<ResolvedVideoSelection> {
  if (choice.kind === "standard") {
    const encode = highQualityEncode(posterFrame);
    return {
      sel: {
        kind: "video",
        presetId: KOOKABURRA_STANDARD_ID,
        ...(encode ? { encode } : {}),
        aspect,
      },
    };
  }
  if (choice.kind === "custom") {
    const resolved = resolveDraft(choice.draft);
    if (!resolved.spec) return { error: resolved.error };
    const spec = withPosterFrame({ ...resolved.spec }, posterFrame);
    const gain = await loudnessGain(
      choice.draft.loudnessTarget,
      choice.draft.fps,
      posterFrame,
      measure,
    );
    if (gain !== undefined && spec.audio) spec.audio = { ...spec.audio, loudnessGainDb: gain };
    return {
      sel: { kind: "video", presetId: CUSTOM_ID, encode: spec, outputSuffix: "custom", aspect },
    };
  }
  const doc = choice.fitted
    ? { ...choice.doc, video: { ...choice.doc.video, rate: choice.fitted } }
    : choice.doc;
  const gain = await loudnessGain(
    doc.audio.loudnessTarget ?? null,
    doc.video.fps,
    posterFrame,
    measure,
  );
  let spec: EncodeSpec;
  try {
    spec = withPosterFrame(resolvePresetToEncodeSpec(doc, gain), posterFrame);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return {
    sel: {
      kind: "video",
      presetId: choice.id,
      encode: spec,
      outputSuffix: choice.id.startsWith("ws:") ? choice.id.slice(3) : choice.id,
      aspect,
    },
  };
}

/** The Custom panel's Resolution choices below native. */
export const CUSTOM_SHORT_EDGES = [1440, 1080, 720] as const;

/** A terminal export's flags: a preset id (absent = High quality), and the Custom panel's frame rate and resolution. */
export interface VideoRequest {
  preset?: string | null;
  fps?: number | null;
  shortEdge?: number | null;
}

/** kb export's flags as the modal would set them: the preset row, or with `fps`/`shortEdge` the Custom panel seeded from that row (Duplicate…) or from High quality's seed, then those two knobs changed. */
export function choiceForRequest(
  req: VideoRequest,
  findPreset: (id: string) => ExportPresetDoc | undefined,
): VideoChoice | { error: string } {
  const id = req.preset ?? KOOKABURRA_STANDARD_ID;
  if (req.fps != null && req.fps !== 30 && req.fps !== 60) {
    return { error: `fps must be 30 or 60, not ${req.fps}` };
  }
  if (req.shortEdge != null && !(CUSTOM_SHORT_EDGES as readonly number[]).includes(req.shortEdge)) {
    return {
      error: `short edge must be ${CUSTOM_SHORT_EDGES.join(", ")} (leave it out for native), not ${req.shortEdge}`,
    };
  }
  let doc: ExportPresetDoc | undefined;
  if (id !== KOOKABURRA_STANDARD_ID && id !== CUSTOM_ID) {
    doc = findPreset(id);
    if (!doc) return { error: `no export preset "${id}"` };
  }
  const custom = id === CUSTOM_ID || req.fps != null || req.shortEdge != null;
  if (!custom) return doc ? { kind: "preset", id, doc } : { kind: "standard" };
  const seed = doc ? draftFromDoc(doc) : customSeed();
  return {
    kind: "custom",
    draft: {
      ...seed,
      ...(req.fps != null ? { fps: req.fps as 30 | 60 } : {}),
      ...(req.shortEdge != null ? { shortEdge: req.shortEdge } : {}),
    },
  };
}

/** `exportProject`'s options for a selection, exactly as the Export button builds them; `destination` and `signal` never reach the bytes. */
export function buildVideoExportOptions(
  project: LoadedProject,
  sel: VideoExportSelection,
  run: { destination?: "downloads"; signal?: AbortSignal } = {},
): ExportOptions {
  return {
    projectId: project.id,
    fps: sel.encode?.fps ?? FPS,
    durationMs: project.totalMs,
    format: FORMATS[sel.aspect],
    slots: project.slots,
    cameraTrack: project.cameraTrack,
    sceneDocs: project.sceneDocs,
    theme: project.theme,
    sceneThemes: project.sceneThemes,
    projectLighting: project.projectLighting,
    sceneFrames: project.sceneFrames,
    compareBDocs: project.compareBDocs,
    compareBThemes: project.compareBThemes,
    motionBlur: project.renderSettings.motionBlur,
    audio: project.audio,
    codec: "libx264",
    encode: sel.encode,
    outputSuffix: sel.outputSuffix,
    destination: run.destination,
    signal: run.signal,
  };
}
