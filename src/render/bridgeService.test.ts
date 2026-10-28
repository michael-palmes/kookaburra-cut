import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshWorkspaceAssets } from "../engine/assetRevisions";
import { resolveScreenshotTimeMs } from "../engine/autorun";
import { invalidateChangedClips } from "../engine/clips";
import { canvasHandle } from "../engine/exportBridge";
import { awaitSceneHostsCommitted, captureFrameRgba } from "../engine/exporter";
import { type AspectName, FORMATS } from "../engine/format";
import { insertPresetScene } from "../engine/presetInsert";
import { bumpWorkspaceReloadToken, loadProject } from "../engine/project";
import { withProjectAssetRevision } from "../engine/projectAssetRevision";
import { TrustDeniedError } from "../engine/projectTrust";
import { GpuStallError } from "../engine/readback";
import { DEFAULT_RENDER_SETTINGS } from "../engine/renderSettings";
import { setStage } from "../engine/stageHandle";
import { awaitProjectCommitted } from "../engine/themePreviews";
import { createInlineStage } from "../stage/inlineStage";
import { startBridgeService } from "./bridgeService";

const sheets = vi.hoisted(() => [] as { size: number[]; labels: string[] }[]);
vi.mock("./contactSheet", () => ({
  ContactSheet: class {
    labels: string[] = [];
    constructor(count: number, width: number, height: number) {
      sheets.push({ size: [count, width, height], labels: this.labels });
    }
    draw(_n: number, _rgba: Uint8Array, _w: number, _h: number, label: string) {
      this.labels.push(label);
    }
    async png() {
      return new Uint8Array([137, 80, 78, 71]);
    }
  },
}));
vi.mock("../engine/presetInsert", () => ({ insertPresetScene: vi.fn() }));
vi.mock("./bridgeFonts", () => ({
  serveFontsRequest: vi.fn(async () => ({ ok: true, results: [{ ref: "Menlo@400", ok: true }] })),
}));
vi.mock("../engine/presets", () => ({
  refreshUserPresets: vi.fn(async () => []),
  listAllPresets: () => [
    {
      id: "title",
      slug: "title",
      projectId: "preset:title",
      name: "Title",
      source: "bundled",
      sceneCount: 1,
    },
  ],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("../engine/autorun", () => ({ resolveScreenshotTimeMs: vi.fn(() => 2400) }));
vi.mock("../engine/exporter", () => ({
  awaitSceneHostsCommitted: vi.fn(),
  captureFrameRgba: vi.fn(),
  captureScreenshot: vi.fn(),
}));
vi.mock("../engine/themePreviews", () => ({ awaitProjectCommitted: vi.fn() }));
vi.mock("../engine/clips", () => ({ invalidateChangedClips: vi.fn(async () => {}) }));
vi.mock("../engine/assetRevisions", () => ({
  projectAssetsStamp: vi.fn(async () => null),
  refreshWorkspaceAssets: vi.fn(async () => []),
}));
vi.mock("../engine/project", () => ({
  bumpWorkspaceReloadToken: vi.fn(),
  isEditableProjectId: () => true,
  isWorkspaceBackedProjectId: (id: string) => id.startsWith("ws"),
  isWorkspaceProjectId: (id: string) => id.startsWith("ws:"),
  loadProject: vi.fn(),
  nativeProjectSlug: (id: string) => id,
  projectIdForNativeSlug: (id: string) => id,
  refreshBundledProjectAssets: vi.fn(),
  sceneFileStem: (file: string) => file,
}));

let stop: (() => void) | undefined;
let context: { playing: boolean; exportLocked: boolean; aspect: string };
let jobs: {
  slug: string;
  revision: string;
  contentRevision: string;
  priority?: boolean;
  atMs: number | null;
  slot: number;
  sceneFile: string;
  aspect: AspectName;
}[];
const project = {
  id: "preset:hero",
  slots: [{ durationMs: 4000, startMs: 0 }],
  totalMs: 4000,
  sceneFiles: ["hero.tsx"],
  renderSettings: DEFAULT_RENDER_SETTINGS,
} as Awaited<ReturnType<typeof loadProject>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  context = { playing: false, exportLocked: false, aspect: "9:16" };
  jobs = [
    {
      slug: "preset:hero",
      revision: "saved-a",
      contentRevision: "saved-a",
      atMs: 2400,
      slot: 0,
      sceneFile: "hero.tsx",
      aspect: "16:9",
    },
  ];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_editor_context") return { ...context };
    if (command === "render_take_preset_poster") {
      const index = jobs.findIndex(
        (job) => !(args as { priorityOnly: boolean }).priorityOnly || job.priority,
      );
      return index < 0 ? null : jobs.splice(index, 1)[0];
    }
    if (command === "render_finish_preset_poster") return true;
    return null;
  });
  vi.mocked(loadProject).mockResolvedValue(project);
  vi.mocked(captureFrameRgba).mockResolvedValue({
    rgba: new Uint8Array(640 * 360 * 4),
    width: 640,
    height: 360,
  });
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: () => ({
        createImageData: (width: number, height: number) => ({
          data: new Uint8Array(width * height * 4),
        }),
        putImageData: vi.fn(),
      }),
      toBlob: (ready: (blob: Blob) => void) => ready(new Blob([new Uint8Array([137, 80, 78, 71])])),
    }),
  });
});

afterEach(() => {
  setStage(null);
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hidden library preview rendering", () => {
  it.each([
    ["16:9", 640, 360],
    ["9:16", 360, 640],
    ["1:1", 640, 640],
    ["4:5", 512, 640],
    ["5:4", 640, 512],
    ["3:2", 640, 427],
    ["2:3", 427, 640],
    ["phone", 294, 640],
    ["phone-landscape", 640, 294],
  ] as const)(
    "captures the saved %s aspect independently of the editor",
    async (aspect, width, height) => {
      jobs[0].aspect = aspect;
      stop = startBridgeService(vi.fn());
      await vi.advanceTimersByTimeAsync(1000);
      expect(captureFrameRgba).toHaveBeenCalledWith(
        expect.objectContaining({ format: { name: aspect, width, height } }),
        2400,
      );
      expect(context.aspect).toBe("9:16");
    },
  );

  it("captures all template slots using their saved scene identity", async () => {
    const fixture = {
      ...project,
      id: "ws-template:demo",
      sceneFiles: ["intro.tsx", "hero.tsx"],
      slots: [
        { index: 0, id: "intro", startMs: 0, endMs: 1000, durationMs: 1000 },
        { index: 1, id: "hero", startMs: 1000, endMs: 5000, durationMs: 4000 },
      ],
    };
    vi.mocked(loadProject).mockResolvedValue(fixture);
    jobs = [0, 1, 2, 3].map((slot) => ({ ...jobs[0], slug: fixture.id, slot }));
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(2000);
    expect(captureFrameRgba).toHaveBeenCalledTimes(4);
    expect(resolveScreenshotTimeMs).toHaveBeenCalledWith(fixture, "1", 2.4);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "write_preset_poster")
        .map(([, , options]) => new Headers(options?.headers).get("x-kookaburra-slot")),
    ).toEqual(["0", "1", "2", "3"]);
  });

  it("uses the canonical landscape format and saved preview independently of editor aspect", async () => {
    const apply = vi.fn();
    stop = startBridgeService(apply);
    await vi.advanceTimersByTimeAsync(1000);
    expect(apply).toHaveBeenCalledWith(project, FORMATS["16:9"]);
    expect(loadProject).toHaveBeenCalledWith("preset:hero", {
      trustMode: "stored-only",
      readSavedThemes: true,
    });
    expect(resolveScreenshotTimeMs).toHaveBeenCalledWith(project, "0", 2.4);
    expect(captureFrameRgba).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "preset:hero",
        format: { name: "16:9", width: 640, height: 360 },
      }),
      2400,
    );
    expect(invoke).toHaveBeenCalledWith("write_preset_poster", expect.any(Uint8Array), {
      headers: {
        "x-kookaburra-slug": "preset:hero",
        "x-kookaburra-revision": "saved-a",
        "x-kookaburra-slot": "0",
      },
    });
  });

  it("uses the established midpoint semantics when atMs is absent", async () => {
    jobs[0].atMs = null;
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolveScreenshotTimeMs).toHaveBeenCalledWith(project, "0", undefined);
  });

  it.each(["playing", "exportLocked"] as const)("parks queued jobs while %s", async (flag) => {
    context[flag] = true;
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadProject).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("render_take_preset_poster");
  });

  it.each(["playing", "exportLocked"] as const)(
    "requeues the same revision when %s starts during capture",
    async (flag) => {
      vi.mocked(captureFrameRgba).mockImplementation(async () => {
        context[flag] = true;
        return { rgba: new Uint8Array(640 * 360 * 4), width: 640, height: 360 };
      });
      stop = startBridgeService(vi.fn());
      await vi.advanceTimersByTimeAsync(1000);
      expect(invoke).toHaveBeenCalledWith("render_finish_preset_poster", {
        slug: "preset:hero",
        revision: "saved-a",
        slot: 0,
        retry: true,
      });
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "write_preset_poster")).toBe(
        false,
      );
    },
  );

  it("reloads a newly queued source revision for the same preset", async () => {
    jobs.push({ ...jobs[0], revision: "saved-b", contentRevision: "saved-b" });
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadProject).toHaveBeenCalledTimes(2);
  });

  it("requests a new texture URL when a later saved revision replaces an asset in place", async () => {
    jobs.push({ ...jobs[0], revision: "image-replaced", contentRevision: "image-replaced" });
    const requestedUrls: string[] = [];
    const apply = () =>
      requestedUrls.push(withProjectAssetRevision("preset:hero", "assets/app-icon.png"));
    stop = startBridgeService(apply);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestedUrls).toEqual([
      "assets/app-icon.png?poster=saved-a",
      "assets/app-icon.png?poster=image-replaced",
    ]);
  });

  it("lets capture prepare cold assets before checking scene readiness", async () => {
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(captureFrameRgba).toHaveBeenCalledTimes(1);
    expect(awaitSceneHostsCommitted).not.toHaveBeenCalled();
  });

  it("reuses loaded content when only the capture settings change", async () => {
    jobs.push({ ...jobs[0], revision: "different-point", atMs: 3000 });
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(captureFrameRgba).toHaveBeenCalledTimes(2);
    expect(resolveScreenshotTimeMs).toHaveBeenLastCalledWith(project, "0", 3);
  });

  it("serves a manual slot before thumbnails and automatic previews", async () => {
    jobs.push({ ...jobs[0], slot: 3, priority: true });
    const original = vi.mocked(invoke).getMockImplementation();
    let thumb = true;
    vi.mocked(invoke).mockImplementation(async (command, args, options) => {
      if (command === "render_take_thumb_job" && thumb) {
        thumb = false;
        return { slug: "preset:hero", stem: "hero.tsx", stamp: "thumb" };
      }
      return original?.(command, args, options);
    });
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    const writes = vi.mocked(invoke).mock.calls.filter(([name]) => name.startsWith("write_"));
    expect(writes.map(([name]) => name)).toEqual([
      "write_preset_poster",
      "write_scene_thumb",
      "write_preset_poster",
    ]);
    expect(new Headers(writes[0][2]?.headers).get("x-kookaburra-slot")).toBe("3");
  });

  it("wakes for a manual capture without waiting for the polling interval", async () => {
    const manual = { ...jobs[0], priority: true };
    jobs = [];
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(captureFrameRgba).not.toHaveBeenCalled();
    jobs.push(manual);
    const wake = vi.mocked(listen).mock.calls[0][1];
    wake({ event: "kookaburra://library-preview-queued", id: 1, payload: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(captureFrameRgba).toHaveBeenCalledTimes(1);
    stop();
    jobs.push(manual);
    wake({ event: "kookaburra://library-preview-queued", id: 2, payload: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(captureFrameRgba).toHaveBeenCalledTimes(1);
  });

  it("abandons an untrusted workspace preset and continues serving the next job", async () => {
    jobs.unshift({ ...jobs[0], slug: "ws-preset:untrusted", revision: "unapproved", atMs: null });
    vi.mocked(loadProject).mockRejectedValueOnce(new Error("Project was not opened"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stop = startBridgeService(vi.fn());
      await vi.advanceTimersByTimeAsync(1000);
      expect(loadProject).toHaveBeenCalledWith("ws-preset:untrusted", {
        trustMode: "stored-only",
        readSavedThemes: true,
      });
      expect(invoke).toHaveBeenCalledWith("render_finish_preset_poster", {
        slug: "ws-preset:untrusted",
        revision: "unapproved",
        slot: 0,
        retry: false,
      });
      expect(captureFrameRgba).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("write_preset_poster", expect.any(Uint8Array), {
        headers: {
          "x-kookaburra-slug": "preset:hero",
          "x-kookaburra-revision": "saved-a",
          "x-kookaburra-slot": "0",
        },
      });
    } finally {
      warning.mockRestore();
    }
  });
});

describe("bridge v2 requests", () => {
  let responses: Record<string, unknown>[];
  let queue: Record<string, unknown>[];
  let editor: Record<string, unknown>;
  let trusted: boolean;
  let assetChecks: unknown[];

  const demo = {
    id: "ws:demo",
    slots: [
      { index: 0, id: "hero", startMs: 0, endMs: 4000, durationMs: 4000 },
      { index: 1, id: "stats", startMs: 4000, endMs: 10000, durationMs: 6000 },
    ],
    totalMs: 10000,
    // The project mock's sceneFileStem is the identity, so files are written as stems here.
    sceneFiles: ["01-hero", "02-stats"],
    sceneDocs: [{ version: 1, media: { src: "assets/clip.mov" } }, undefined],
    compareBDocs: [undefined, undefined],
    renderSettings: DEFAULT_RENDER_SETTINGS,
  } as unknown as Awaited<ReturnType<typeof loadProject>>;

  const serve = async (request: Record<string, unknown>) => {
    queue.push({ version: 2, requestedAtMs: 1, id: "0001-1-abc", ...request });
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    return responses.at(-1) as Record<string, unknown>;
  };

  /** Serves `requests` in order on one running service (one per claim tick). */
  const serveAll = async (requests: Record<string, unknown>[], apply = vi.fn()) => {
    for (const [n, request] of requests.entries()) {
      queue.push({ version: 2, requestedAtMs: 1, id: `0001-1-${n}`, ...request });
    }
    stop = startBridgeService(apply);
    await vi.advanceTimersByTimeAsync(1000 * requests.length);
    return responses;
  };

  beforeEach(() => {
    responses = [];
    queue = [];
    sheets.length = 0;
    trusted = true;
    assetChecks = [{ path: "assets/clip.mov", ok: true }];
    editor = {
      projectId: "ws:demo",
      aspect: "9:16",
      currentMs: 5000,
      exportLocked: false,
      playing: false,
    };
    let named = "";
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const a = args as Record<string, unknown>;
      switch (command) {
        case "bridge_claim_request":
          return queue.shift() ?? null;
        case "get_editor_context":
          return { ...editor };
        case "bridge_write_response":
          responses.push(JSON.parse(a.jsonText as string));
          return null;
        case "begin_bridge_screenshot":
          named = a.name as string;
          return null;
        case "save_bridge_screenshot":
          return `/bridge/responses/${named}.png`;
        case "bridge_write_sheet":
          return "/bridge/responses/0001-1-abc-sheet.png";
        case "bridge_check_assets":
          return assetChecks;
        case "is_project_trusted":
          return trusted;
        case "project_fingerprint":
          return "sources-1";
        default:
          return null;
      }
    });
    vi.mocked(loadProject).mockResolvedValue(demo);
  });

  it("keeps v1 captures working: playhead of the open project at the editor's aspect", async () => {
    const response = await serve({ version: 1, kind: undefined, project: "ws:demo" });
    expect(response).toMatchObject({
      version: 1,
      id: "0001-1-abc",
      ok: true,
      path: "/bridge/responses/0001-1-abc.png",
      project: "ws:demo",
      tMs: 2400,
      format: "9:16",
      surface: "render-window",
    });
    expect(resolveScreenshotTimeMs).toHaveBeenCalledWith(demo, undefined, undefined, 5000);
    expect(loadProject).toHaveBeenCalledWith("ws:demo", { trustMode: "stored-only" });
    expect(invoke).toHaveBeenCalledWith("trust_project", { slug: "ws:demo" });
  });

  it("captures several frames at an overridden aspect with a contact sheet", async () => {
    vi.mocked(resolveScreenshotTimeMs).mockReturnValueOnce(1000).mockReturnValueOnce(5500);
    const response = await serve({
      kind: "capture",
      aspect: "1:1",
      frames: [
        { scene: "0", at: 1 },
        { scene: "02-stats", at: 1.5 },
      ],
      sheet: true,
    });
    expect(response).toMatchObject({
      version: 2,
      ok: true,
      path: "/bridge/responses/0001-1-abc.png",
      paths: ["/bridge/responses/0001-1-abc.png", "/bridge/responses/0001-1-abc-1.png"],
      frames: [
        { scene: "01-hero", at: 1, tMs: 1000, index: 0, path: "/bridge/responses/0001-1-abc.png" },
        {
          scene: "02-stats",
          at: 1.5,
          tMs: 5500,
          index: 1,
          path: "/bridge/responses/0001-1-abc-1.png",
        },
      ],
      sheetPath: "/bridge/responses/0001-1-abc-sheet.png",
      format: "1:1",
      size: { width: 1280, height: 1280 },
      nativeSize: { width: 2160, height: 2160 },
      timing: { queuedMs: expect.any(Number), renderMs: expect.any(Number) },
    });
    // Sheets render at the 1280 long edge; the store keeps the native format.
    expect(captureFrameRgba).toHaveBeenCalledWith(
      expect.objectContaining({ format: { name: "1:1", width: 1280, height: 1280 } }),
      1000,
    );
    expect(sheets).toEqual([
      { size: [2, 1280, 1280], labels: ["0  01-hero  @ 1.00s", "1  02-stats  @ 1.50s"] },
    ]);
    expect(editor.aspect).toBe("9:16");
  });

  it("captures one frame native unless it is sized, and refuses a bad size", async () => {
    const served = await serveAll([
      { kind: "capture", scene: "0", aspect: "16:9" },
      { kind: "capture", scene: "0", aspect: "16:9", scale: 0.5 },
      { kind: "capture", scene: "0", aspect: "16:9", width: 640 },
      {
        kind: "capture",
        scene: "0",
        aspect: "16:9",
        frames: [{ scene: "0" }],
        sheet: true,
        probe: [[1, 1]],
      },
      { kind: "capture", scene: "0", scale: 1.5 },
      { kind: "capture", scene: "0", width: 12.5 },
    ]);
    expect(served.map((r) => r.size ?? r.error)).toEqual([
      { width: 3840, height: 2160 },
      { width: 1920, height: 1080 },
      { width: 640, height: 360 },
      { width: 3840, height: 2160 },
      "Error: scale must be in (0, 1], got 1.5",
      "Error: width must be a whole number of pixels, got 12.5",
    ]);
  });

  it("samples probe points from the readback, top-left origin, per frame", async () => {
    const rgba = new Uint8Array(4 * 2 * 4);
    rgba.set([10, 20, 30, 255], 0); // bottom-left in GL rows
    rgba.set([245, 245, 245, 255], (1 * 4 + 3) * 4); // top-right
    vi.mocked(captureFrameRgba).mockResolvedValue({ rgba, width: 4, height: 2 });
    const response = await serve({
      kind: "capture",
      scene: "0",
      width: 64,
      probe: [
        [3, 0],
        [0, 1],
      ],
    });
    expect(response.frames).toEqual([
      expect.objectContaining({
        probes: [
          { x: 3, y: 0, rgba: [245, 245, 245, 255], hex: "#f5f5f5" },
          { x: 0, y: 1, rgba: [10, 20, 30, 255], hex: "#0a141e" },
        ],
      }),
    ]);
    stop?.();
    // The editor's 9:16 at 64 wide is 64x114.
    const outside = await serve({ kind: "capture", scene: "0", width: 64, probe: [[64, 0]] });
    expect(outside.error).toContain("probe point 64,0 is outside the 64x114 capture");
  });

  it("answers too large before rendering anything", async () => {
    const response = await serve({
      kind: "capture",
      aspect: "16:9",
      scale: 1,
      frames: Array.from({ length: 17 }, () => ({ scene: "0" })),
    });
    expect(response).toMatchObject({ ok: false, tooLarge: true, units: 153, maxUnits: 144 });
    expect(captureFrameRgba).not.toHaveBeenCalled();
  });

  it("stops between frames when the client gave up or an export began", async () => {
    let checks = 0;
    const base = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "bridge_request_live") {
        checks += 1;
        return checks === 2 ? { live: false, reason: "cancelled" } : { live: true };
      }
      return base?.(command, args);
    });
    const response = await serve({
      kind: "capture",
      frames: [{ scene: "0" }, { scene: "1" }, { scene: "1" }],
    });
    expect(response).toMatchObject({ ok: false, cancelled: true });
    expect(captureFrameRgba).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("bridge_request_live", { id: "0001-1-abc", frame: 1 });
    checks = 1;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "bridge_request_live") return { live: false, reason: "busy" };
      return base?.(command, args);
    });
    stop?.();
    const busy = await serve({ kind: "capture", scene: "0" });
    expect(busy).toMatchObject({ ok: false, busy: true });
  });

  it("answers a GPU stall once on every path, then stops serving on that canvas", async () => {
    vi.mocked(captureFrameRgba).mockRejectedValue(
      new GpuStallError(
        "blankReadback",
        "GPU stalled (capture at 0ms): readPixels returned an all-zero frame",
      ),
    );
    const served = await serveAll([
      { kind: "capture", scene: "0" },
      { kind: "check", render: true },
    ]);
    expect(served[0]).toMatchObject({
      ok: false,
      gpuStalled: true,
      reason: "blankReadback",
      error: "Error: GPU stalled (capture at 0ms): readPixels returned an all-zero frame",
    });
    expect(served[1]).toMatchObject({ ok: false, gpuStalled: true, reason: "blankReadback" });
    expect(captureFrameRgba).toHaveBeenCalledTimes(1);
  });

  it("stops a render check at the first stall instead of failing every scene", async () => {
    vi.mocked(captureFrameRgba).mockRejectedValue(
      new GpuStallError(
        "contextLost",
        "GPU stalled (capture at 2000ms): the WebGL context was lost",
      ),
    );
    const response = await serve({ kind: "check", render: true });
    expect(response).toMatchObject({ ok: false, gpuStalled: true, reason: "contextLost" });
    expect(response.scenes).toBeUndefined();
    expect(captureFrameRgba).toHaveBeenCalledTimes(1);
  });

  it("forces a context loss on its own stage for debug lose-context", async () => {
    setStage(createInlineStage());
    const forceContextLoss = vi.fn();
    canvasHandle.current = { gl: { forceContextLoss } } as unknown as NonNullable<
      typeof canvasHandle.current
    >;
    try {
      const response = await serve({ kind: "debug", op: "lose-context", window: "render" });
      expect(response).toMatchObject({ ok: true, op: "lose-context", lost: true, recycling: true });
      expect(forceContextLoss).toHaveBeenCalledTimes(1);
    } finally {
      canvasHandle.current = null;
    }
    stop?.();
    const unknown = await serve({ kind: "debug", op: "explode" });
    expect(unknown.error).toContain('debug op "explode"');
  });

  it("switches only the format when the loaded project is captured at another aspect", async () => {
    const apply = vi.fn();
    const served = await serveAll(
      [
        { kind: "capture", scene: "0", aspect: "1:1" },
        { kind: "capture", scene: "1", aspect: "16:9" },
      ],
      apply,
    );
    expect(served.map((r) => [r.ok, r.format])).toEqual([
      [true, "1:1"],
      [true, "16:9"],
    ]);
    expect(loadProject).toHaveBeenCalledTimes(1);
    expect(bumpWorkspaceReloadToken).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls).toEqual([
      [demo, FORMATS["1:1"]],
      [demo, FORMATS["16:9"]],
    ]);
    // A fresh identity retries errored scene boundaries and is what the commit barrier waits on.
    const switched = apply.mock.calls[1][0];
    expect(switched).not.toBe(demo);
    expect(awaitProjectCommitted).toHaveBeenLastCalledWith(switched);
    expect(captureFrameRgba).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: FORMATS["16:9"] }),
      2400,
    );
  });

  it("captures from the load a check of the same project made", async () => {
    const served = await serveAll([{ kind: "check" }, { kind: "capture", scene: "1" }]);
    expect(served.map((r) => r.ok)).toEqual([true, true]);
    expect(loadProject).toHaveBeenCalledTimes(1);
  });

  it("reloads after a format switch that never committed", async () => {
    vi.mocked(awaitProjectCommitted)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("Canvas tree never committed the swapped project."));
    const served = await serveAll([
      { kind: "capture", scene: "0", aspect: "1:1" },
      { kind: "capture", scene: "0", aspect: "16:9" },
      { kind: "capture", scene: "0", aspect: "16:9" },
    ]);
    expect(served.map((r) => r.ok)).toEqual([true, false, true]);
    expect(loadProject).toHaveBeenCalledTimes(2);
  });

  it("reloads when the source fingerprint can't be read", async () => {
    const original = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args, options) =>
      command === "project_fingerprint"
        ? Promise.reject(new Error("unreadable"))
        : original?.(command, args, options),
    );
    await serveAll([
      { kind: "capture", scene: "0" },
      { kind: "capture", scene: "0" },
    ]);
    expect(loadProject).toHaveBeenCalledTimes(2);
  });

  it("reloads when the project's sources changed since the last request", async () => {
    const original = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args, options) =>
      command === "project_fingerprint"
        ? `sources-${responses.length}`
        : original?.(command, args, options),
    );
    await serveAll([
      { kind: "capture", scene: "0" },
      { kind: "capture", scene: "0" },
    ]);
    expect(loadProject).toHaveBeenCalledTimes(2);
    expect(bumpWorkspaceReloadToken).toHaveBeenCalledTimes(2);
  });

  it("refuses an unknown aspect without rendering", async () => {
    const response = await serve({ kind: "capture", scene: "0", aspect: "21:9" });
    expect(response).toMatchObject({ ok: false });
    expect(String(response.error)).toContain('unknown aspect "21:9"');
    expect(captureFrameRgba).not.toHaveBeenCalled();
  });

  it("answers needsTrust for a project whose stored grant no longer matches, never prompting", async () => {
    vi.mocked(loadProject).mockRejectedValueOnce(new TrustDeniedError("other"));
    const response = await serve({ kind: "capture", project: "ws:other", scene: "0" });
    expect(response).toMatchObject({ version: 2, ok: false, needsTrust: true });
    expect(String(response.error)).toMatch(/^"other" changed since you last allowed it/);
    expect(loadProject).toHaveBeenCalledWith("ws:other", { trustMode: "stored-only" });
    expect(invoke).not.toHaveBeenCalledWith("trust_project", expect.anything());
  });

  it("checks a project from a real load, including assets and a render pass", async () => {
    vi.mocked(loadProject).mockResolvedValue({
      ...demo,
      fontIssues: [{ ref: "Menlo@400", message: "unknown cmap table format 6", fallback: null }],
    });
    vi.mocked(captureFrameRgba).mockRejectedValueOnce(new Error("context lost"));
    assetChecks = [{ path: "assets/clip.mov", ok: false, error: "no such file" }];
    const response = await serve({ kind: "check", render: true });
    expect(invoke).toHaveBeenCalledWith("bridge_check_assets", {
      slug: "ws:demo",
      paths: ["assets/clip.mov"],
    });
    expect(captureFrameRgba).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({
      version: 2,
      ok: false,
      project: "ws:demo",
      rendered: true,
      scenes: [
        {
          index: 0,
          file: "01-hero",
          id: "hero",
          ok: false,
          phase: "render",
          error: "Error: context lost",
          warnings: ["assets/clip.mov: no such file"],
        },
        { index: 1, file: "02-stats", id: "stats", ok: true, warnings: [] },
      ],
      fonts: [{ ref: "Menlo@400", ok: false, error: "unknown cmap table format 6" }],
      assets: [{ path: "assets/clip.mov", ok: false, error: "no such file" }],
      warnings: [],
    });
  });

  it("reports a project that fails to load as a check result, not a crash", async () => {
    vi.mocked(loadProject).mockRejectedValueOnce(new Error("project.json isn't valid JSON"));
    const response = await serve({ kind: "check", project: "ws:demo" });
    expect(response).toMatchObject({
      ok: false,
      error: "Error: project.json isn't valid JSON",
      scenes: [],
      rendered: false,
    });
  });

  it("inserts a preset through the app's copy path and keeps a closed project trusted", async () => {
    vi.mocked(insertPresetScene).mockResolvedValue({
      file: "scenes/03-highlights.tsx",
      docFile: "scenes/03-highlights.json",
      sceneId: "highlights",
      durationMs: 4000,
      index: 2,
      name: "Highlights",
    });
    const response = await serve({
      kind: "insertPreset",
      project: "ws:closed",
      preset: "title",
      position: 2,
      name: "Highlights",
    });
    expect(insertPresetScene).toHaveBeenCalledWith({
      destSlug: "ws:closed",
      presetProjectId: "preset:title",
      position: 2,
      name: "Highlights",
      trustMode: "stored-only",
    });
    expect(invoke).toHaveBeenCalledWith("trust_project", { slug: "ws:closed" });
    expect(response).toMatchObject({
      version: 2,
      ok: true,
      file: "scenes/03-highlights.tsx",
      index: 2,
      id: "highlights",
      name: "Highlights",
    });
  });

  it("names an unknown preset and never touches the project", async () => {
    const response = await serve({ kind: "insertPreset", preset: "nope" });
    expect(response).toMatchObject({ ok: false });
    expect(String(response.error)).toContain('no scene preset "nope"');
    expect(insertPresetScene).not.toHaveBeenCalled();
  });

  it("is busy while the editor exports, except for font checks", async () => {
    editor.exportLocked = true;
    expect(await serve({ kind: "check" })).toMatchObject({ ok: false, busy: true });
    stop?.();
    expect(await serve({ kind: "fonts", refs: ["Menlo@400"] })).toMatchObject({
      ok: true,
      results: [{ ref: "Menlo@400", ok: true }],
    });
  });

  it("rejects a kind this build does not serve", async () => {
    const response = await serve({ kind: "teleport" });
    expect(response).toMatchObject({ version: 2, ok: false });
    expect(String(response.error)).toContain("capture, check, fonts, insertPreset");
  });

  it.each(["mediaChanged", "openEdit"])("never serves the native %s kind", async (kind) => {
    editor.exportLocked = true;
    const response = await serve({ kind, project: "ws:demo", name: "clip" });
    expect(response).toMatchObject({ version: 2, ok: false });
    expect(response.busy).toBeUndefined();
    expect(String(response.error)).toContain(`${kind} is served natively by the app`);
    expect(loadProject).not.toHaveBeenCalled();
  });
});

describe("media changed in the render window", () => {
  let claims: number;

  const mediaChanged = (payload: unknown) => {
    const call = vi
      .mocked(listen)
      .mock.calls.find(([name]) => name === "kookaburra://media-changed");
    if (!call) throw new Error("no media-changed listener");
    call[1]({ event: "kookaburra://media-changed", id: 1, payload });
  };

  beforeEach(() => {
    claims = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "bridge_claim_request") claims++;
      return null;
    });
  });

  it("sweeps changed clips and the project's assets before the next claim", async () => {
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidateChangedClips).not.toHaveBeenCalled();
    const before = claims;
    mediaChanged({ slug: "demo", paths: ["assets/clip-edited.mp4"], origin: "agent" });
    expect(invalidateChangedClips).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refreshWorkspaceAssets).toHaveBeenCalledWith("ws:demo");
    expect(invalidateChangedClips).toHaveBeenCalledTimes(1);
    const sweptAt = vi.mocked(invalidateChangedClips).mock.invocationCallOrder[0];
    const claimedAt = vi
      .mocked(invoke)
      .mock.calls.map(
        (call, n) => [call[0], vi.mocked(invoke).mock.invocationCallOrder[n]] as const,
      )
      .filter(([name, order]) => name === "bridge_claim_request" && order > sweptAt);
    expect(claimedAt.length).toBeGreaterThan(0);
    expect(claims).toBeGreaterThan(before);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidateChangedClips).toHaveBeenCalledTimes(1);
  });

  it("sweeps clips for a broadcast that names no project", async () => {
    stop = startBridgeService(vi.fn());
    mediaChanged(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invalidateChangedClips).toHaveBeenCalledTimes(1);
    expect(refreshWorkspaceAssets).not.toHaveBeenCalled();
  });
});

describe("GPU stalls in the idle queues", () => {
  const stall = new GpuStallError(
    "contextLost",
    "GPU stalled (capture at 2400ms): the WebGL context was lost",
  );

  it("puts a stalled preset poster back, reports the stall and stops draining", async () => {
    jobs.push({ ...jobs[0], slot: 1 });
    vi.mocked(captureFrameRgba).mockRejectedValue(stall);
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(3000);
    expect(captureFrameRgba).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "render_finish_preset_poster",
      expect.objectContaining({ retry: true }),
    );
    expect(invoke).toHaveBeenCalledWith("render_report_gpu_event", {
      reason: "contextLost",
      deliberate: false,
    });
  });

  it("reports a stalled thumb and never takes another", async () => {
    jobs = [];
    let taken = 0;
    const base = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "render_take_thumb_job") {
        taken += 1;
        return { slug: "preset:hero", generation: 1, stem: "hero.tsx", stamp: "s", remaining: 3 };
      }
      return base?.(command, args);
    });
    vi.mocked(captureFrameRgba).mockRejectedValue(stall);
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(3000);
    expect(taken).toBe(1);
    expect(invoke).toHaveBeenCalledWith("render_report_gpu_event", {
      reason: "contextLost",
      deliberate: false,
    });
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "write_scene_thumb")).toBe(false);
  });
});
