import { invoke } from "@tauri-apps/api/core";
import { PerspectiveCamera, Scene } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadAppFonts } from "../theme/fonts";
import { useClockStore } from "./clock";
import { renderComposited } from "./compositor";
import { pageFromReadback } from "./downscale";
import { canvasHandle, trackContextLosses } from "./exportBridge";
import { type ExportOptions, exportProject } from "./exporter";
import { isExporting } from "./exportState";
import { FORMATS } from "./format";
import {
  clearSceneHolds,
  hasSceneHolds,
  replaceSceneHolds,
  subscribeSceneHolds,
} from "./presentHold";
import { reportPresentTimingPending } from "./presentTimingRegistry";
import {
  awaitPresentTimingsSettled,
  compareStillsRuns,
  exportStills,
  type StillsExportResult,
  type StillsSettings,
  verifyPassBSuffix,
  verifyStills,
} from "./stillsExport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("./exportBridge", async (original) => {
  const { sceneHoldsVersion } = await import("./presentHold");
  return {
    ...(await original<typeof import("./exportBridge")>()),
    canvasCommittedClockMs: () => useClockStore.getState().currentMs,
    canvasCommittedHoldsVersion: () => sceneHoldsVersion(),
  };
});
vi.mock("./sceneHostRegistry", async (original) => ({
  ...(await original<typeof import("./sceneHostRegistry")>()),
  getSceneHosts: () => [{ side: undefined }, { side: undefined }],
}));
vi.mock("./compositor", async (original) => ({
  ...(await original<typeof import("./compositor")>()),
  renderComposited: vi.fn(),
}));
vi.mock("./clips", async (original) => ({
  ...(await original<typeof import("./clips")>()),
  preextractClips: vi.fn(async () => {}),
  awaitVideoFramesReady: vi.fn(async () => {}),
}));
vi.mock("./effects", async (original) => ({
  ...(await original<typeof import("./effects")>()),
  preloadEffectLuts: vi.fn(async () => {}),
}));
vi.mock("./project", async (original) => ({
  ...(await original<typeof import("./project")>()),
  preloadProjectImages: vi.fn(async () => {}),
}));
vi.mock("./titleBlockMeasure", async (original) => ({
  ...(await original<typeof import("./titleBlockMeasure")>()),
  awaitTitleMeasuresSettled: vi.fn(async () => {}),
}));
vi.mock("../theme/fonts", async (original) => ({
  ...(await original<typeof import("../theme/fonts")>()),
  preloadAppFonts: vi.fn(async () => {}),
}));
vi.mock("../toolkit/device/catalog", async (original) => ({
  ...(await original<typeof import("../toolkit/device/catalog")>()),
  preloadCatalogModels: vi.fn(async () => {}),
}));
vi.mock("../toolkit/device/models", async (original) => ({
  ...(await original<typeof import("../toolkit/device/models")>()),
  preloadDeviceModels: vi.fn(async () => {}),
}));
vi.mock("../toolkit/frame/chipIcons", async (original) => ({
  ...(await original<typeof import("../toolkit/frame/chipIcons")>()),
  preloadChipIcons: vi.fn(async () => {}),
}));
vi.mock("../toolkit/hero/models", async (original) => ({
  ...(await original<typeof import("../toolkit/hero/models")>()),
  preloadHeroModels: vi.fn(async () => {}),
}));
vi.mock("../toolkit/objects/preload", async (original) => ({
  ...(await original<typeof import("../toolkit/objects/preload")>()),
  preloadSceneObjects: vi.fn(async () => {}),
}));
vi.mock("../toolkit/stage/backdrops", async (original) => ({
  ...(await original<typeof import("../toolkit/stage/backdrops")>()),
  preloadBundledBackdrops: vi.fn(async () => {}),
}));
vi.mock("../toolkit/text/emojiRaster", async (original) => ({
  ...(await original<typeof import("../toolkit/text/emojiRaster")>()),
  awaitEmojiRastersIdle: vi.fn(async () => {}),
  preloadEmojiRasters: vi.fn(async () => {}),
}));
vi.mock("../toolkit/text3d/fonts", async (original) => ({
  ...(await original<typeof import("../toolkit/text3d/fonts")>()),
  preloadText3dFonts: vi.fn(async () => {}),
}));

const format = { ...FORMATS["16:9"], width: 8, height: 4 };
const opts: ExportOptions = {
  projectId: "demo",
  fps: 60,
  durationMs: 200,
  format,
  slots: [
    { index: 0, id: "one", startMs: 0, endMs: 100, durationMs: 100 },
    { index: 1, id: "two", startMs: 100, endMs: 200, durationMs: 100 },
  ],
  sceneDocs: [{ name: "Opening" } as never, undefined],
};
const png: StillsSettings = { format: "png-zip", size: "1080p", title: "Demo" };
const PAGE_BYTES = format.width * format.height * 4;

/** The frame at `tMs`: varied pixels, never all zero, a pure function of the clock. */
const drawn = (tMs: number) =>
  Uint8Array.from({ length: PAGE_BYTES }, (_, i) => (i % 4 === 3 ? 200 : (tMs * 31 + i) % 256));

function mountCanvas(stalled: number[] = []) {
  const canvas = new EventTarget() as HTMLCanvasElement;
  trackContextLosses(canvas);
  let reads = 0;
  const ctx = {
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    isContextLost: () => false,
    readPixels: (...args: unknown[]) => {
      const read = reads++;
      if (!stalled.includes(read)) {
        (args[6] as Uint8Array).set(drawn(useClockStore.getState().currentMs));
      }
    },
  };
  let size = { x: 1280, y: 720 };
  canvasHandle.current = {
    gl: {
      domElement: canvas,
      getContext: () => ctx,
      getSize: (v: { set: (x: number, y: number) => unknown }) => v.set(size.x, size.y),
      setSize: (x: number, y: number) => {
        size = { x, y };
      },
      getPixelRatio: () => 1,
      setPixelRatio: () => {},
    },
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    advance: () => {},
  } as unknown as NonNullable<typeof canvasHandle.current>;
}

interface Push {
  body: number[];
  headers: Record<string, string>;
}
let pushes: Push[] = [];
let onPush: () => void = () => {};
let runStart = 0;
let log: string[] = [];
const called = (cmd: string) => vi.mocked(invoke).mock.calls.some(([c]) => c === cmd);
function startOptions(): Record<string, unknown> {
  const call = vi.mocked(invoke).mock.calls.find(([c]) => c === "start_stills_export");
  if (!call) throw new Error("start_stills_export was never called");
  return (call[1] as { options: Record<string, unknown> }).options;
}

const metaOf = (push: Push) => JSON.parse(atob(push.headers["x-kookaburra-meta"]));

const nativeResult = (pages: number, sha = "file") => ({
  path: "/out/demo-16x9.zip",
  kind: "png-zip",
  pages,
  bytes: 1234,
  sha256: sha,
  pageSha256: Array.from({ length: pages }, (_, i) => `page${i}`),
  zipFolder: "demo-16x9",
});

let unsubscribe: (() => void)[] = [];

beforeEach(() => {
  pushes = [];
  onPush = () => {};
  log = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, body?: unknown, options?: unknown) => {
    if (cmd === "push_still") {
      pushes.push({
        body: Array.from(body as Uint8Array),
        headers: (options as { headers: Record<string, string> }).headers,
      });
      onPush();
    }
    if (cmd === "start_stills_export") {
      runStart = pushes.length;
      return "/out/demo-16x9.zip";
    }
    if (cmd === "finish_stills_export") return nativeResult(pushes.length - runStart);
    return undefined;
  });
  vi.mocked(renderComposited).mockImplementation(() => {
    log.push(`draw ${useClockStore.getState().currentMs}`);
  });
  useClockStore.getState().setCurrentMs(0);
  unsubscribe = [
    useClockStore.subscribe((s, prev) => {
      if (s.currentMs !== prev.currentMs) log.push(`clock ${s.currentMs}`);
    }),
    subscribeSceneHolds(() => log.push(`holds ${hasSceneHolds()}`)),
  ];
});

afterEach(() => {
  for (const off of unsubscribe) off();
  canvasHandle.current = null;
  clearSceneHolds();
  vi.unstubAllGlobals();
});

describe("exportStills", () => {
  it("runs the preamble once, holds the automatic stills, then draws the first page twice", async () => {
    mountCanvas();
    const result = await exportStills(opts, png);
    expect(vi.mocked(preloadAppFonts)).toHaveBeenCalledTimes(1);
    // Two automatic stills at their solo windows' centres (no timings, nothing keyed).
    expect(result.pageTimesMs).toEqual([50, 150]);
    expect(log).toEqual([
      "holds true",
      "clock 50",
      "draw 50",
      "draw 50",
      "clock 150",
      "draw 150",
      "holds false",
      "clock 0",
    ]);
    expect(hasSceneHolds()).toBe(false);
    expect(isExporting()).toBe(false);
    expect(useClockStore.getState().currentMs).toBe(0);
  });

  it("streams one top-down opaque page per still with its headers, then finishes", async () => {
    mountCanvas();
    const result = await exportStills(opts, { ...png, reproducible: true, destination: "autorun" });
    expect(startOptions()).toMatchObject({
      kind: "png-zip",
      projectId: "demo",
      aspect: "16x9",
      destination: "autorun",
      title: "Demo",
      formatWidth: 8,
      formatHeight: 4,
      pageWidth: 8,
      pageHeight: 4,
      totalPages: 2,
      reproducible: true,
    });
    expect(pushes).toHaveLength(2);
    pushes.forEach((push, i) => {
      expect(push.body).toEqual(Array.from(pageFromReadback(drawn([50, 150][i]), 8, 4, 8, 4)));
      expect(push.headers).toMatchObject({
        "x-kookaburra-still": String(i),
        "x-kookaburra-width": "8",
        "x-kookaburra-height": "4",
      });
      expect(push.headers["x-kookaburra-text-bytes"]).toBeUndefined();
    });
    expect(metaOf(pushes[0])).toEqual({
      sceneIndex: 0,
      sceneName: "Opening",
      kind: "auto",
      sceneMs: 50,
      globalMs: 50,
    });
    expect(metaOf(pushes[1])).toMatchObject({ sceneIndex: 1, sceneName: "Scene 2" });
    expect(called("finish_stills_export")).toBe(true);
    expect(result).toMatchObject({ path: "/out/demo-16x9.zip", pages: 2, sha256: "file" });
    expect(result.pageHashes).toHaveLength(2);
    expect(result.pagesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends a PDF page as its JPEG followed by the text layer", async () => {
    mountCanvas();
    const jpeg = Uint8Array.from([0xff, 0xd8, 7, 7, 0xff, 0xd9]);
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    );
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({ putImageData: () => {} }),
        toBlob: (done: (blob: Blob) => void) => done(new Blob([jpeg])),
      }),
    });
    await exportStills(opts, { ...png, format: "pdf" });
    expect(startOptions().kind).toBe("pdf");
    for (const push of pushes) {
      expect(push.headers["x-kookaburra-text-bytes"]).toBe("2");
      expect(push.body).toEqual([...jpeg, ...new TextEncoder().encode("[]")]);
    }
  });

  it("stops at a stalled readback, cancels the writer and clears the holds", async () => {
    mountCanvas([1]);
    await expect(exportStills(opts, png)).rejects.toThrow(
      "GPU stalled (still 2/2): readPixels returned an all-zero frame",
    );
    expect(pushes).toHaveLength(1);
    expect(called("cancel_stills_export")).toBe(true);
    expect(called("finish_stills_export")).toBe(false);
    expect(hasSceneHolds()).toBe(false);
    expect(isExporting()).toBe(false);
  });

  it("stops between pages on cancel", async () => {
    mountCanvas();
    const abort = new AbortController();
    onPush = () => abort.abort();
    await expect(exportStills({ ...opts, signal: abort.signal }, png)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(pushes).toHaveLength(1);
    expect(called("cancel_stills_export")).toBe(true);
    expect(hasSceneHolds()).toBe(false);
  });

  it("refuses to plan when every scene is left out, before the writer starts", async () => {
    mountCanvas();
    const excluded = { stills: { exclude: true } } as never;
    await expect(exportStills({ ...opts, sceneDocs: [excluded, excluded] }, png)).rejects.toThrow(
      "Every scene is left out of stills",
    );
    expect(called("start_stills_export")).toBe(false);
  });
});

describe("video export while scenes are held", () => {
  it("refuses to start", async () => {
    mountCanvas();
    replaceSceneHolds(new Map([[0, 10]]));
    await expect(exportProject(opts)).rejects.toThrow("Scene holds are active");
    expect(called("start_export")).toBe(false);
  });
});

describe("awaitPresentTimingsSettled", () => {
  it("waits for pending timings to clear", async () => {
    const clear = reportPresentTimingPending(0);
    let cleared = false;
    setTimeout(() =>
      setTimeout(() => {
        cleared = true;
        clear();
      }, 0),
    );
    await awaitPresentTimingsSettled(new Scene());
    expect(cleared).toBe(true);
  });
});

describe("verifyStills", () => {
  it("renders twice in one hold and matches page for page", async () => {
    mountCanvas();
    const v = await verifyStills(opts, png);
    expect(v.identical).toBe(true);
    expect(v.a.pagesHash).toBe(v.b.pagesHash);
    const starts = vi
      .mocked(invoke)
      .mock.calls.filter(([c]) => c === "start_stills_export")
      .map((call) => (call[1] as { options: Record<string, unknown> }).options);
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ outputSuffix: null, zipFolder: null });
    expect(starts[1]).toMatchObject({ outputSuffix: "b", zipFolder: "demo-16x9" });
  });

  it("suffixes pass B after any suffix the run already carries", () => {
    expect(verifyPassBSuffix(undefined)).toBe("b");
    expect(verifyPassBSuffix("custom")).toBe("custom-b");
  });
});

describe("compareStillsRuns", () => {
  const run = (overrides: Partial<StillsExportResult> = {}): StillsExportResult => ({
    path: "/out.pdf",
    kind: "pdf",
    pages: 2,
    bytes: 10,
    sha256: "f",
    pageSha256: ["p0", "p1"],
    pagesHash: "h",
    pageHashes: ["a", "b"],
    pageTimesMs: [50, 150],
    warnings: [],
    digests: [0, 1].map((i) => ({
      tiles: new Uint32Array(64).fill(i),
      text: "[]",
      meta: `{${i}}`,
    })),
    ...overrides,
  });

  it("names the first divergent page and its tiles", () => {
    const b = run();
    b.digests[1] = {
      ...b.digests[1],
      tiles: Uint32Array.from({ length: 64 }, (_, t) => (t === 9 ? 7 : 1)),
    };
    const v = compareStillsRuns(run(), b, "pdf");
    expect(v.identical).toBe(false);
    expect(v.divergentPages).toEqual([1]);
    expect(v.firstDivergence).toEqual({
      page: 1,
      tiles: [9],
      text: false,
      meta: false,
      payload: false,
    });
  });

  it("treats a PDF's JPEG and file bytes as advisory, a PNG zip's as required", () => {
    const b = run({ sha256: "g", pageSha256: ["p0", "q1"] });
    const pdf = compareStillsRuns(run(), b, "pdf");
    expect(pdf).toMatchObject({ identical: true, fileIdentical: false, divergentPages: [] });
    const zip = compareStillsRuns(run({ kind: "png-zip" }), { ...b, kind: "png-zip" }, "png-zip");
    expect(zip.identical).toBe(false);
    expect(zip.firstDivergence).toMatchObject({ page: 1, tiles: [], payload: true });
  });

  it("fails on a text layer difference", () => {
    const b = run();
    b.digests[0] = { ...b.digests[0], text: '[{"text":"x"}]' };
    expect(compareStillsRuns(run(), b, "pdf").firstDivergence).toMatchObject({
      page: 0,
      text: true,
    });
  });
});
