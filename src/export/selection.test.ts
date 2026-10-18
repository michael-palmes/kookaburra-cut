import { describe, expect, it } from "vitest";
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
  resolveDraft,
  withPosterFrame,
} from "../ui/exportOptions";
import { BUNDLED_EXPORT_PRESETS, findBundledPreset } from "./presetRegistry";
import { type ExportPresetDoc, resolvePresetToEncodeSpec } from "./presetSchema";
import {
  aspectForPreset,
  buildVideoExportOptions,
  choiceForRequest,
  type LoudnessMeasure,
  type MeasureLoudness,
  measureLoudnessArgs,
  resolveVideoSelection,
  type VideoChoice,
  type VideoExportSelection,
} from "./selection";

const AUDIO: ProjectAudio = {
  file: "assets/track.m4a",
  abs: "/Users/x/Kookaburra Cut/product-tour/assets/track.m4a",
  durationMs: 61_234.5,
  sampleRate: 48_000,
  gainDb: -2,
  fadeInMs: 250,
  fadeOutMs: 1000,
  fadeOutCurve: "smooth",
};
const TOTAL_MS = 12_345;

/** A loudness reading that depends on both inputs, so a wrong rate or poster flag moves the gain. */
const reading = (fps: number, posterFrame: boolean): LoudnessMeasure => ({
  integratedLufs: -19.37 - fps / 1000 - (posterFrame ? 0.011 : 0),
  truePeakDbtp: -3.2,
});

/** The modal's own measure: the invoke it made before the move, recorded. */
function modalMeasure(audio: ProjectAudio | undefined, calls: unknown[]): MeasureLoudness {
  return async (fps, posterFrame) => {
    if (!audio) return null;
    calls.push(measureLoudnessArgs(audio, TOTAL_MS, fps, posterFrame));
    return reading(fps, posterFrame);
  };
}

// The pre-move modal code, verbatim apart from `invoke`: the oracle the helpers must match.
async function legacyDoExport(
  selectedId: string,
  selectedRow: { id: string; doc: ExportPresetDoc } | null,
  draft: CustomDraft,
  fitted: ExportPresetDoc["video"]["rate"] | null,
  aspect: AspectName,
  posterFrame: boolean,
  audio: ProjectAudio | undefined,
  calls: unknown[],
): Promise<VideoExportSelection | { error: string } | undefined> {
  const measure = async (outFps: number, posterFrame: boolean) => {
    if (!audio) return null;
    const outFrames = Math.max(1, Math.round((TOTAL_MS / 1000) * outFps)) + (posterFrame ? 1 : 0);
    calls.push({
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
    });
    return reading(outFps, posterFrame);
  };
  const loudnessGainFor = async (target: number | null, outFps: number, posterFrame: boolean) => {
    if (target == null || !audio) return undefined;
    const m = await measure(outFps, posterFrame);
    if (!m) return undefined;
    return Math.round((target - m.integratedLufs) * 100) / 100;
  };
  try {
    if (selectedId === KOOKABURRA_STANDARD_ID) {
      const encode = highQualityEncode(posterFrame);
      return {
        kind: "video",
        presetId: KOOKABURRA_STANDARD_ID,
        ...(encode ? { encode } : {}),
        aspect,
      };
    }
    if (selectedId === CUSTOM_ID) {
      const resolved = resolveDraft(draft);
      if (!resolved.spec) return { error: resolved.error };
      const spec = withPosterFrame({ ...resolved.spec }, posterFrame);
      const gain = await loudnessGainFor(draft.loudnessTarget, draft.fps, posterFrame);
      if (gain !== undefined && spec.audio) spec.audio = { ...spec.audio, loudnessGainDb: gain };
      return { kind: "video", presetId: CUSTOM_ID, encode: spec, outputSuffix: "custom", aspect };
    }
    const row = selectedRow;
    if (!row) return undefined;
    const doc = fitted ? { ...row.doc, video: { ...row.doc.video, rate: fitted } } : row.doc;
    const gain = await loudnessGainFor(
      doc.audio.loudnessTarget ?? null,
      doc.video.fps,
      posterFrame,
    );
    const spec = withPosterFrame(resolvePresetToEncodeSpec(doc, gain), posterFrame);
    return {
      kind: "video",
      presetId: row.id,
      encode: spec,
      outputSuffix: row.id.startsWith("ws:") ? row.id.slice(3) : row.id,
      aspect,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function helperSelection(
  choice: VideoChoice,
  aspect: AspectName,
  posterFrame: boolean,
  audio: ProjectAudio | undefined,
  calls: unknown[],
): Promise<VideoExportSelection | { error: string }> {
  const out = await resolveVideoSelection(choice, aspect, posterFrame, modalMeasure(audio, calls));
  return out.error !== undefined ? { error: out.error } : out.sel;
}

function bundled(id: string): ExportPresetDoc {
  const doc = findBundledPreset(id);
  if (!doc) throw new Error(`bundled preset missing: ${id}`);
  return doc;
}

const USER_PRESET: ExportPresetDoc = {
  ...bundled("youtube"),
  id: "ws:client-cut",
  name: "Client cut",
  platform: "Custom",
};

interface Case {
  label: string;
  id: string;
  row: { id: string; doc: ExportPresetDoc } | null;
  choice: VideoChoice;
  draft?: CustomDraft;
  fitted?: ExportPresetDoc["video"]["rate"] | null;
  aspect: AspectName;
}

const custom30 = { ...customSeed(), fps: 30 as const, shortEdge: 1080 };

const CASES: Case[] = [
  {
    label: "High quality",
    id: KOOKABURRA_STANDARD_ID,
    row: null,
    choice: { kind: "standard" },
    aspect: "16:9",
  },
  ...BUNDLED_EXPORT_PRESETS.map(
    (doc): Case => ({
      label: doc.id,
      id: doc.id,
      row: { id: doc.id, doc },
      choice: { kind: "preset", id: doc.id, doc },
      aspect: doc.favouredAspect,
    }),
  ),
  {
    label: "x fitted to its cap",
    id: "x",
    row: { id: "x", doc: bundled("x") },
    choice: {
      kind: "preset",
      id: "x",
      doc: bundled("x"),
      fitted: { targetKbps: 4100, maxKbps: 5000, bufsizeKbps: 9000 },
    },
    fitted: { targetKbps: 4100, maxKbps: 5000, bufsizeKbps: 9000 },
    aspect: "1:1",
  },
  {
    label: "a user preset",
    id: USER_PRESET.id,
    row: { id: USER_PRESET.id, doc: USER_PRESET },
    choice: { kind: "preset", id: USER_PRESET.id, doc: USER_PRESET },
    aspect: "16:9",
  },
  {
    label: "Custom seed",
    id: CUSTOM_ID,
    row: null,
    choice: { kind: "custom", draft: customSeed() },
    draft: customSeed(),
    aspect: "16:9",
  },
  {
    label: "Custom 30 fps 1080p",
    id: CUSTOM_ID,
    row: null,
    choice: { kind: "custom", draft: custom30 },
    draft: custom30,
    aspect: "9:16",
  },
  {
    label: "Custom from youtube with a loudness target",
    id: CUSTOM_ID,
    row: null,
    choice: { kind: "custom", draft: { ...draftFromDoc(bundled("youtube")), fps: 30 } },
    draft: { ...draftFromDoc(bundled("youtube")), fps: 30 },
    aspect: "16:9",
  },
  {
    label: "Custom rejected (VideoToolbox CRF)",
    id: CUSTOM_ID,
    row: null,
    choice: { kind: "custom", draft: { ...customSeed(), codec: "h264_videotoolbox" } },
    draft: { ...customSeed(), codec: "h264_videotoolbox" },
    aspect: "16:9",
  },
  {
    label: "preset rejected (PCM in mp4)",
    id: "ws:broken",
    row: {
      id: "ws:broken",
      doc: { ...bundled("share-h264"), id: "ws:broken", audio: { codec: { pcmBits: 16 } } },
    },
    choice: {
      kind: "preset",
      id: "ws:broken",
      doc: { ...bundled("share-h264"), id: "ws:broken", audio: { codec: { pcmBits: 16 } } },
    },
    aspect: "16:9",
  },
];

describe("resolveVideoSelection", () => {
  for (const posterFrame of [false, true]) {
    for (const audio of [undefined, AUDIO]) {
      const tag = `poster ${posterFrame ? "on" : "off"}, ${audio ? "with" : "no"} soundtrack`;
      it(`matches the pre-move modal code for every row (${tag})`, async () => {
        for (const c of CASES) {
          const legacyCalls: unknown[] = [];
          const helperCalls: unknown[] = [];
          const legacy = await legacyDoExport(
            c.id,
            c.row,
            c.draft ?? customSeed(),
            c.fitted ?? null,
            c.aspect,
            posterFrame,
            audio,
            legacyCalls,
          );
          const helper = await helperSelection(c.choice, c.aspect, posterFrame, audio, helperCalls);
          expect(helper, c.label).toStrictEqual(legacy);
          expect(helperCalls, c.label).toStrictEqual(legacyCalls);
        }
      });
    }
  }

  it("keeps the frozen path (no spec, legacy name) for High quality with the poster frame off", async () => {
    const out = await helperSelection({ kind: "standard" }, "16:9", false, AUDIO, []);
    expect(out).toStrictEqual({ kind: "video", presetId: KOOKABURRA_STANDARD_ID, aspect: "16:9" });
  });

  it("sends High quality's spec lane, legacy name, with the poster frame on", async () => {
    const out = await helperSelection({ kind: "standard" }, "16:9", true, AUDIO, []);
    expect(out).toStrictEqual({
      kind: "video",
      presetId: KOOKABURRA_STANDARD_ID,
      encode: {
        codec: "libx264",
        scaleShortEdgeTo: undefined,
        fps: 60,
        rate: { crf: 18 },
        profile: undefined,
        level: undefined,
        gopSeconds: undefined,
        bFrames: undefined,
        entropy: undefined,
        tenBit: undefined,
        faststart: false,
        colourTags: false,
        audio: { codec: { aacKbps: 192 } },
        posterFrame: true,
      },
      aspect: "16:9",
    });
  });

  it("pins every row's selection (golden)", async () => {
    const lineup: Record<string, unknown> = {};
    for (const posterFrame of [false, true]) {
      for (const c of CASES) {
        lineup[`${c.label} | poster ${posterFrame ? "on" : "off"}`] = await helperSelection(
          c.choice,
          c.aspect,
          posterFrame,
          AUDIO,
          [],
        );
      }
    }
    expect(JSON.parse(JSON.stringify(lineup))).toMatchSnapshot();
  });

  it("passes measure failures through, as the modal's catch expects", async () => {
    const failing: MeasureLoudness = async () => {
      throw new Error("ffmpeg failed");
    };
    await expect(
      resolveVideoSelection(
        { kind: "preset", id: "youtube", doc: bundled("youtube") },
        "16:9",
        true,
        failing,
      ),
    ).rejects.toThrow("ffmpeg failed");
  });
});

describe("aspectForPreset", () => {
  it("keeps the working aspect when allowed, else the favoured one, else the first", () => {
    expect(aspectForPreset(bundled("share-h264"), "4:5")).toBe("4:5");
    expect(aspectForPreset(bundled("tiktok"), "1:1")).toBe("1:1");
    expect(aspectForPreset(bundled("tiktok"), "16:9")).toBe("9:16");
    expect(aspectForPreset({ ...bundled("reddit"), favouredAspect: "9:16" }, "4:5")).toBe("1:1");
  });
});

describe("choiceForRequest (kb export flags)", () => {
  const find = (id: string) => (id === USER_PRESET.id ? USER_PRESET : findBundledPreset(id));

  it("maps no flags to High quality and a bare preset to its row", () => {
    expect(choiceForRequest({}, find)).toStrictEqual({ kind: "standard" });
    expect(choiceForRequest({ preset: KOOKABURRA_STANDARD_ID }, find)).toStrictEqual({
      kind: "standard",
    });
    expect(choiceForRequest({ preset: "share-h264" }, find)).toStrictEqual({
      kind: "preset",
      id: "share-h264",
      doc: bundled("share-h264"),
    });
    expect(choiceForRequest({ preset: USER_PRESET.id }, find)).toStrictEqual({
      kind: "preset",
      id: USER_PRESET.id,
      doc: USER_PRESET,
    });
  });

  it("seeds Custom from High quality's seed, then the fps and short edge, as the panel does", async () => {
    const choice = choiceForRequest({ fps: 30, shortEdge: 1080 }, find);
    expect(choice).toStrictEqual({ kind: "custom", draft: custom30 });
    const panel = await helperSelection(
      { kind: "custom", draft: { ...customSeed(), fps: 30, shortEdge: 1080 } },
      "16:9",
      true,
      AUDIO,
      [],
    );
    const kb = await helperSelection(choice as VideoChoice, "16:9", true, AUDIO, []);
    expect(kb).toStrictEqual(panel);
    expect(kb).toMatchObject({ presetId: CUSTOM_ID, outputSuffix: "custom" });
  });

  it("seeds Custom from a preset (Duplicate…) when a preset comes with fps or a short edge", () => {
    expect(choiceForRequest({ preset: "youtube", fps: 30 }, find)).toStrictEqual({
      kind: "custom",
      draft: { ...draftFromDoc(bundled("youtube")), fps: 30 },
    });
    expect(choiceForRequest({ preset: "custom" }, find)).toStrictEqual({
      kind: "custom",
      draft: customSeed(),
    });
  });

  it("refuses what the panel cannot set", () => {
    expect(choiceForRequest({ fps: 24 }, find)).toHaveProperty("error");
    expect(choiceForRequest({ shortEdge: 1000 }, find)).toHaveProperty("error");
    expect(choiceForRequest({ shortEdge: 2160 }, find)).toHaveProperty("error");
    expect(choiceForRequest({ preset: "nope" }, find)).toStrictEqual({
      error: 'no export preset "nope"',
    });
  });
});

describe("buildVideoExportOptions", () => {
  const project = {
    id: "ws:product-tour",
    totalMs: TOTAL_MS,
    slots: [{ index: 0, id: "a", startMs: 0, endMs: TOTAL_MS, durationMs: TOTAL_MS }],
    cameraTrack: [{ tMs: 0 }],
    sceneDocs: [{ version: 1 }],
    theme: { id: "kookaburra-default" },
    sceneThemes: [{ id: "kookaburra-default" }],
    projectLighting: { sun: {} },
    sceneFrames: [undefined],
    compareBDocs: [undefined],
    compareBThemes: [undefined],
    renderSettings: { motionBlur: { shutter: 0.5 } },
    audio: AUDIO,
  } as unknown as LoadedProject;

  // The pre-move App literal, verbatim apart from `targetFormat`.
  const legacy = (
    sel: VideoExportSelection,
    toDownloads: boolean,
    signal: AbortSignal,
  ): ExportOptions => ({
    projectId: project.id,
    fps: sel.encode?.fps ?? FPS,
    durationMs: project.totalMs,
    format: FORMATS[sel.aspect],
    slots: project.slots,
    cameraTrack: project.cameraTrack,
    sceneDocs: project.sceneDocs,
    music: project.music,
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
    destination: toDownloads ? "downloads" : undefined,
    signal,
  });

  it("builds the Export button's options for every row", async () => {
    const signal = new AbortController().signal;
    for (const posterFrame of [false, true]) {
      for (const c of CASES) {
        const sel = await helperSelection(c.choice, c.aspect, posterFrame, AUDIO, []);
        if ("error" in sel) continue;
        for (const toDownloads of [false, true]) {
          const built = buildVideoExportOptions(project, sel, {
            destination: toDownloads ? "downloads" : undefined,
            signal,
          });
          expect(built, c.label).toStrictEqual(legacy(sel, toDownloads, signal));
          expect(Object.keys(built)).toStrictEqual(Object.keys(legacy(sel, toDownloads, signal)));
        }
      }
    }
  });

  it("renders 30 fps specs at 30 and everything else at the engine rate", async () => {
    const hq = buildVideoExportOptions(project, { kind: "video", presetId: "x", aspect: "16:9" });
    expect(hq.fps).toBe(FPS);
    expect(hq.format).toBe(FORMATS["16:9"]);
    expect(hq.encode).toBeUndefined();
    expect(hq.outputSuffix).toBeUndefined();
    const sel = await helperSelection(
      { kind: "custom", draft: custom30 },
      "9:16",
      false,
      AUDIO,
      [],
    );
    if ("error" in sel) throw new Error(sel.error);
    const built = buildVideoExportOptions(project, sel);
    expect(built.fps).toBe(30);
    expect(built.format).toBe(FORMATS["9:16"]);
    expect(built.encode?.scaleShortEdgeTo).toBe(1080);
    expect(built.outputSuffix).toBe("custom");
    expect(built.destination).toBeUndefined();
  });
});
