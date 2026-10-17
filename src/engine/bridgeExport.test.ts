import { describe, expect, it } from "vitest";
import { BUNDLED_EXPORT_PRESETS, findBundledPreset } from "../export/presetRegistry";
import type { ExportPresetDoc } from "../export/presetSchema";
import {
  buildVideoExportOptions,
  type LoudnessMeasure,
  measureLoudnessArgs,
  resolveVideoSelection,
  type VideoChoice,
  type VideoExportSelection,
} from "../export/selection";
import { CUSTOM_ID, customSeed, KOOKABURRA_STANDARD_ID } from "../ui/exportOptions";
import {
  BridgeProgressTracker,
  bridgeExportFacts,
  bridgeExportRefusal,
  bridgeFailureFor,
  type EditorActivity,
  isBridgeFailure,
  isHardwareLane,
  outputSize,
  parseBridgeExportRequest,
  resolveBridgeChoice,
  type SourceSync,
  syncSources,
} from "./bridgeExport";
import { FORMATS, FPS } from "./format";
import type { LoadedProject, ProjectAudio } from "./project";
import { GpuStallError } from "./readback";

const REQ = parseBridgeExportRequest({ id: "0001-1-a", project: "ws:demo" });
if (!REQ) throw new Error("fixture request");

const IDLE: EditorActivity = {
  view: "editor",
  openProjectId: "ws:demo",
  exporting: false,
  themePreviewRunning: false,
  exportModalOpen: false,
  pointerDown: false,
  fieldFocused: false,
};

const AUDIO: ProjectAudio = {
  file: "assets/track.m4a",
  abs: "/Users/x/Kookaburra Cut/demo/assets/track.m4a",
  durationMs: 9_000,
  sampleRate: 48_000,
  gainDb: -1,
};
const TOTAL_MS = 8_200;

const reading = (fps: number, poster: boolean): LoudnessMeasure => ({
  integratedLufs: -18.5 - fps / 1000 - (poster ? 0.01 : 0),
  truePeakDbtp: -4,
});
const measure = async (fps: number, poster: boolean) => reading(fps, poster);

const find = (id: string): ExportPresetDoc | undefined => findBundledPreset(id);

describe("parseBridgeExportRequest", () => {
  it("reads the event payload and drops what it cannot use", () => {
    expect(
      parseBridgeExportRequest({
        id: "x",
        project: "ws:demo",
        aspect: "9:16",
        preset: "tiktok",
        fps: 30,
        shortEdge: null,
        posterFrame: false,
        verify: true,
        client: "alpha",
        sources: { "project.json": "ab", "scenes/a.tsx": 3 },
      }),
    ).toStrictEqual({
      id: "x",
      project: "ws:demo",
      projectPath: null,
      client: "alpha",
      aspect: "9:16",
      preset: "tiktok",
      fps: 30,
      shortEdge: null,
      posterFrame: false,
      verify: true,
      sources: { "project.json": "ab" },
    });
    expect(parseBridgeExportRequest({ project: "ws:demo" })).toBeNull();
    expect(parseBridgeExportRequest("nope")).toBeNull();
    expect(parseBridgeExportRequest({ id: "x", project: "ws:demo" })?.posterFrame).toBeNull();
  });
});

describe("bridgeExportRefusal (the acceptance rules)", () => {
  const code = (activity: Partial<EditorActivity>) =>
    bridgeExportRefusal(REQ, { ...IDLE, ...activity })?.code ?? null;

  it("accepts only the project open in the editor, with the person idle", () => {
    expect(code({})).toBeNull();
    expect(code({ view: "welcome" })).toBe("notOpen");
    expect(code({ openProjectId: null })).toBe("notOpen");
    expect(code({ openProjectId: "ws:other" })).toBe("wrongProject");
  });

  it("answers busy while the canvas is taken or the person is mid-edit", () => {
    for (const busy of [
      { exporting: true },
      { themePreviewRunning: true },
      { exportModalOpen: true },
      { pointerDown: true },
      { fieldFocused: true },
    ]) {
      const refusal = bridgeExportRefusal(REQ, { ...IDLE, ...busy });
      expect(refusal?.busy, JSON.stringify(busy)).toBe(true);
      expect(refusal?.retryAfterMs).toBeGreaterThan(0);
    }
    expect(code({ exporting: true })).toBe("busy");
    expect(code({ pointerDown: true })).toBe("editing");
    expect(code({ exportModalOpen: true })).toBe("editing");
  });

  it("names the open project and the next step", () => {
    const wrong = bridgeExportRefusal(REQ, { ...IDLE, openProjectId: "ws:other" });
    expect(wrong?.error).toContain("ws:other");
    expect(wrong?.hint).toMatch(/open this project/);
  });
});

describe("resolveBridgeChoice (kb export flags as the modal sets them)", () => {
  const req = (fields: Record<string, unknown>) => {
    const parsed = parseBridgeExportRequest({ id: "x", project: "ws:demo", ...fields });
    if (!parsed) throw new Error("request");
    return parsed;
  };

  it("defaults to High quality in the editor's aspect, and a preset keeps it when allowed", () => {
    expect(resolveBridgeChoice(req({}), "9:16", find)).toStrictEqual({
      choice: { kind: "standard" },
      aspect: "9:16",
    });
    const tiktok = resolveBridgeChoice(req({ preset: "tiktok" }), "16:9", find);
    expect(tiktok).toMatchObject({ choice: { kind: "preset", id: "tiktok" }, aspect: "9:16" });
    const share = resolveBridgeChoice(req({ preset: "share-h264" }), "4:5", find);
    expect(share).toMatchObject({ aspect: "4:5" });
  });

  it("takes an explicit aspect only when the row allows it", () => {
    expect(resolveBridgeChoice(req({ aspect: "1:1" }), "16:9", find)).toMatchObject({
      aspect: "1:1",
    });
    const refused = resolveBridgeChoice(req({ preset: "tiktok", aspect: "16:9" }), "16:9", find);
    expect(isBridgeFailure(refused) && refused.code).toBe("invalid");
    const unknown = resolveBridgeChoice(req({ aspect: "21:9" }), "16:9", find);
    expect(isBridgeFailure(unknown) && unknown.error).toMatch(/unknown aspect "21:9"/);
  });

  it("refuses what the Custom panel cannot set", () => {
    for (const fields of [{ fps: 24 }, { shortEdge: 999 }, { preset: "nope" }]) {
      const out = resolveBridgeChoice(req(fields), "16:9", find);
      expect(isBridgeFailure(out) && out.code, JSON.stringify(fields)).toBe("invalid");
    }
  });
});

describe("the bridge export runs the Export button's selection", () => {
  const project = {
    id: "ws:demo",
    totalMs: TOTAL_MS,
    slots: [{ index: 0, id: "a", startMs: 0, endMs: TOTAL_MS, durationMs: TOTAL_MS }],
    sceneFiles: ["scenes/01-a.tsx"],
    cameraTrack: [],
    sceneDocs: [{ version: 1 }],
    theme: { id: "kookaburra-default" },
    sceneThemes: [{ id: "kookaburra-default" }],
    projectLighting: undefined,
    sceneFrames: [undefined],
    compareBDocs: [undefined],
    compareBThemes: [undefined],
    renderSettings: { motionBlur: undefined },
    audio: AUDIO,
  } as unknown as LoadedProject;

  /** What the modal resolves for a row, and what kb export resolves for the same flags. */
  async function both(
    row: VideoChoice,
    fields: Record<string, unknown>,
    aspect: (typeof FORMATS)[keyof typeof FORMATS]["name"],
    posterFrame: boolean,
  ) {
    const modal = await resolveVideoSelection(row, aspect, posterFrame, measure);
    const parsed = parseBridgeExportRequest({ id: "x", project: "ws:demo", aspect, ...fields });
    if (!parsed) throw new Error("request");
    const picked = resolveBridgeChoice(parsed, "16:9", find);
    if (isBridgeFailure(picked)) throw new Error(picked.error);
    const bridge = await resolveVideoSelection(picked.choice, picked.aspect, posterFrame, measure);
    return { modal, bridge };
  }

  it("selects exactly what the modal selects for High quality, every preset and Custom", async () => {
    for (const posterFrame of [false, true]) {
      const hq = await both({ kind: "standard" }, {}, "16:9", posterFrame);
      expect(hq.bridge).toStrictEqual(hq.modal);
      for (const doc of BUNDLED_EXPORT_PRESETS) {
        const { modal, bridge } = await both(
          { kind: "preset", id: doc.id, doc },
          { preset: doc.id },
          doc.favouredAspect,
          posterFrame,
        );
        expect(bridge, doc.id).toStrictEqual(modal);
      }
      const custom = await both(
        { kind: "custom", draft: { ...customSeed(), fps: 30, shortEdge: 1080 } },
        { fps: 30, shortEdge: 1080 },
        "16:9",
        posterFrame,
      );
      expect(custom.bridge).toStrictEqual(custom.modal);
      expect(custom.bridge.sel?.presetId).toBe(CUSTOM_ID);
    }
  });

  it("builds the button's options apart from the destination and the signal", async () => {
    const signal = new AbortController().signal;
    for (const posterFrame of [false, true]) {
      for (const doc of [undefined, ...BUNDLED_EXPORT_PRESETS]) {
        const row: VideoChoice = doc ? { kind: "preset", id: doc.id, doc } : { kind: "standard" };
        const { sel } = await resolveVideoSelection(
          row,
          doc?.favouredAspect ?? "16:9",
          posterFrame,
          measure,
        );
        if (!sel) continue;
        const button = buildVideoExportOptions(project, sel, { destination: "downloads", signal });
        const bridge = buildVideoExportOptions(project, sel, {
          signal: new AbortController().signal,
        });
        const { destination: _a, signal: _b, ...buttonRest } = button;
        const { destination: _c, signal: _d, ...bridgeRest } = bridge;
        expect(bridgeRest).toStrictEqual(buttonRest);
        expect(bridge.destination).toBeUndefined();
      }
    }
  });

  it("with the poster frame off and no preset it is the frozen path in-app Verify runs", async () => {
    const { bridge } = await both({ kind: "standard" }, {}, "16:9", false);
    expect(bridge.sel).toStrictEqual({
      kind: "video",
      presetId: KOOKABURRA_STANDARD_ID,
      aspect: "16:9",
    });
    const opts = buildVideoExportOptions(project, bridge.sel as VideoExportSelection);
    expect(opts.encode).toBeUndefined();
    expect(opts.outputSuffix).toBeUndefined();
    expect(opts.fps).toBe(FPS);
    expect(opts.codec).toBe("libx264");
  });

  it("measures loudness with the export graph's own arguments", () => {
    expect(measureLoudnessArgs(AUDIO, TOTAL_MS, 30, true)).toMatchObject({
      totalFrames: 247,
      fps: 30,
      posterFrame: true,
    });
  });

  it("refuses --verify on a VideoToolbox lane", async () => {
    const vt = BUNDLED_EXPORT_PRESETS.find((d) => d.video.codec.endsWith("_videotoolbox"));
    const sw = (await resolveVideoSelection({ kind: "standard" }, "16:9", true, measure)).sel;
    expect(sw && isHardwareLane(sw)).toBe(false);
    if (vt) {
      const { sel } = await resolveVideoSelection(
        { kind: "preset", id: vt.id, doc: vt },
        vt.favouredAspect,
        false,
        measure,
      );
      expect(sel && isHardwareLane(sel)).toBe(true);
    }
    expect(
      isHardwareLane({
        kind: "video",
        presetId: CUSTOM_ID,
        aspect: "16:9",
        encode: { ...((sw?.encode ?? {}) as object), codec: "h264_videotoolbox" },
      } as VideoExportSelection),
    ).toBe(true);
  });

  it("reports the export's facts as the record keeps them", async () => {
    const { sel } = await resolveVideoSelection({ kind: "standard" }, "16:9", true, measure);
    if (!sel) throw new Error("selection");
    const opts = buildVideoExportOptions(project, sel);
    const facts = bridgeExportFacts(project, sel, opts, null, ["w"]);
    expect(facts).toMatchObject({
      ok: true,
      aspect: "16:9",
      preset: KOOKABURRA_STANDARD_ID,
      lane: "spec",
      codec: "libx264",
      fps: 60,
      width: 3840,
      height: 2160,
      posterFrame: true,
      frames: 493,
      totalMs: TOTAL_MS,
      verify: null,
      warnings: ["w"],
    });
    expect(facts.timeline).toStrictEqual([
      {
        index: 0,
        stem: "01-a",
        startMs: 0,
        endMs: TOTAL_MS,
        durationMs: TOTAL_MS,
        transitionIn: null,
      },
    ]);
    const frozen = bridgeExportFacts(
      project,
      { kind: "video", presetId: KOOKABURRA_STANDARD_ID, aspect: "9:16" },
      { fps: 60, format: FORMATS["9:16"], codec: "libx264" },
      { identical: true, hashA: "a", hashB: "a" },
      [],
    );
    expect(frozen).toMatchObject({ lane: "frozen", frames: 492, posterFrame: false, width: 2160 });
    expect(frozen.verify).toStrictEqual({ identical: true, hashA: "a", hashB: "a" });
  });

  it("scales the short edge like encode.rs", () => {
    expect(outputSize(3840, 2160, 1080)).toStrictEqual([1920, 1080]);
    expect(outputSize(1206, 2622, 720)).toStrictEqual([720, 1566]);
    expect(outputSize(1206, 2622, 1440)).toStrictEqual([1206, 2622]);
    expect(outputSize(3840, 2160, undefined)).toStrictEqual([3840, 2160]);
  });
});

describe("BridgeProgressTracker", () => {
  const clock = () => {
    let t = 1_000;
    return { now: () => t, tick: (ms: number) => (t += ms) };
  };

  it("moves through syncing, preparing, render and finalising with a rate and an ETA", () => {
    const c = clock();
    const tracker = new BridgeProgressTracker(c.now);
    expect(tracker.snapshot()).toMatchObject({ stage: "syncing", percent: 0, etaMs: null });
    tracker.onPrepareStep(2);
    expect(tracker.snapshot()).toMatchObject({
      stage: "preparing",
      prepareStep: 2,
      prepareSteps: 4,
      prepareLabel: "Loading effects and assets",
    });
    for (let f = 1; f <= 41; f++) {
      tracker.onProgress({ frame: f, total: 401, stage: "render" });
      c.tick(250);
    }
    const mid = tracker.snapshot();
    expect(mid.stage).toBe("render");
    expect(mid.renderFps).toBe(4);
    expect(mid.etaMs).toBe(90_000);
    expect(mid.percent).toBe(10.2);
    tracker.onProgress({ frame: 401, total: 401, stage: "render" });
    expect(tracker.snapshot()).toMatchObject({ stage: "finalising", percent: 100, etaMs: null });
    tracker.onProgress({ frame: 401, total: 401, stage: "pass1" });
    expect(tracker.snapshot().stage).toBe("pass1");
  });

  it("counts a verify's two renders as one export", () => {
    const c = clock();
    const tracker = new BridgeProgressTracker(c.now, 2);
    for (let f = 1; f <= 100; f++) {
      tracker.onProgress({ frame: f, total: 100, stage: "render" });
      c.tick(100);
    }
    expect(tracker.snapshot()).toMatchObject({ run: 1, runs: 2, percent: 50 });
    tracker.onProgress({ frame: 1, total: 100, stage: "render" });
    c.tick(100);
    tracker.onProgress({ frame: 11, total: 100, stage: "render" });
    const second = tracker.snapshot();
    expect(second).toMatchObject({ run: 2, percent: 55.5, renderFps: 100 });
    expect(second.etaMs).toBe(890);
  });
});

describe("syncSources", () => {
  const stamp = (file: string, stamp = "1") => ({ file, stamp });
  function io(over: Partial<SourceSync> & { files?: Record<string, string> } = {}) {
    let t = 0;
    const files = over.files ?? { "project.json": "1", "scenes/01-a.tsx": "1" };
    const stamps = Object.entries(files).map(([f, s]) => stamp(f, s));
    const base: SourceSync = {
      settleWrites: async () => {},
      stamps: async () => stamps,
      baseline: () => new Map(stamps.map((s) => [s.file, s.stamp])),
      loadInFlight: () => false,
      reloadError: () => null,
      hashes: async (list) => list.map((f) => `h-${f}`),
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      aborted: () => false,
    };
    return { ...base, ...over };
  }
  const sources = { "project.json": "h-project.json", "scenes/01-a.tsx": "h-scenes/01-a.tsx" };

  it("passes when the stage already shows the disk and kb saw the same bytes", async () => {
    expect(await syncSources(sources, io())).toBeNull();
    expect(await syncSources(null, io())).toBeNull();
  });

  it("waits for the poll's reload to land, and gives up after 20 s", async () => {
    let ticks = 0;
    const landed = new Map([
      ["project.json", "1"],
      ["scenes/01-a.tsx", "1"],
    ]);
    const settling = io({
      baseline: () => {
        ticks += 1;
        return ticks <= 3 ? new Map([["project.json", "0"]]) : landed;
      },
      loadInFlight: () => ticks < 6,
    });
    expect(await syncSources(sources, settling)).toBeNull();
    expect(ticks).toBe(6);
    const stuck = await syncSources(sources, io({ loadInFlight: () => true }));
    expect(stuck).toMatchObject({ code: "stale" });
    expect(stuck?.error).toMatch(/20 s/);
  });

  it("refuses after a failed reload, and when kb's view of the files moved", async () => {
    const failed = await syncSources(sources, io({ reloadError: () => "line 4: oops\nmore" }));
    expect(failed).toMatchObject({ code: "stale", reloadFailed: true });
    expect(failed?.error).toMatch(/line 4: oops$/);
    const edited = await syncSources({ ...sources, "scenes/01-a.tsx": "old" }, io());
    expect(edited).toMatchObject({ code: "stale" });
    expect(edited?.error).toMatch(/scenes\/01-a.tsx changed/);
    const added = await syncSources(
      sources,
      io({ files: { "project.json": "1", "scenes/01-a.tsx": "1", "scenes/02-b.tsx": "1" } }),
    );
    expect(added?.error).toMatch(/new scenes\/02-b.tsx/);
  });

  it("stops at once when cancelled", async () => {
    expect(await syncSources(sources, io({ aborted: () => true }))).toMatchObject({
      code: "cancelled",
    });
  });
});

describe("bridgeFailureFor", () => {
  it("tells a cancel, a stalled frame and a lost context apart", () => {
    expect(bridgeFailureFor(new Error("x"), true, "client")).toMatchObject({
      code: "cancelled",
      cancelled: true,
      by: "client",
    });
    expect(
      bridgeFailureFor(
        new Error("GPU stalled (frame 3): readPixels returned an all-zero frame"),
        false,
        "user",
      ),
    ).toMatchObject({ code: "gpuStalled", retryAfterMs: 10_000 });
    expect(
      bridgeFailureFor(new Error("GPU stalled (x): the WebGL context was lost"), false, "user")
        .code,
    ).toBe("gpuWedged");
    expect(bridgeFailureFor(new GpuStallError("contextLost", "lost"), false, "user").code).toBe(
      "gpuWedged",
    );
    expect(bridgeFailureFor(new GpuStallError("blankReadback", "blank"), false, "user").code).toBe(
      "gpuStalled",
    );
    expect(bridgeFailureFor("an export is already in progress", false, "user")).toMatchObject({
      code: "busy",
      busy: true,
    });
    expect(bridgeFailureFor(new Error("ffmpeg exited"), false, "user")).toMatchObject({
      code: "failed",
      error: "ffmpeg exited",
    });
  });
});
