import { invoke } from "@tauri-apps/api/core";
import { Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from "three";
import { Text } from "troika-three-text";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClockStore } from "./clock";
import { canvasHandle, trackContextLosses } from "./exportBridge";
import {
  awaitTextSync,
  captureFrameRgba,
  type ExportOptions,
  exportProject,
  verifyAllFormats,
} from "./exporter";
import { isExporting } from "./exportState";
import { FORMATS } from "./format";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("./exportBridge", async (original) => ({
  ...(await original<typeof import("./exportBridge")>()),
  canvasCommittedClockMs: () => useClockStore.getState().currentMs,
}));
vi.mock("./sceneHostRegistry", async (original) => ({
  ...(await original<typeof import("./sceneHostRegistry")>()),
  getSceneHosts: () => [{ side: undefined }],
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
  durationMs: 50,
  format,
  slots: [{ index: 0, id: "one", startMs: 0, endMs: 50, durationMs: 50 }],
};
const FRAMES = 3;

/** One drawn frame per export frame: opaque, so a real frame is never all zero. */
const drawn = (frame: number) =>
  Uint8Array.from({ length: format.width * format.height * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : (frame * 31 + i) % 256,
  );

/** Mounts a fake live canvas whose readback delivers `drawn(n)` for the nth read, except reads `stalled` names. */
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
      if (!stalled.includes(read)) (args[6] as Uint8Array).set(drawn(read));
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
  return { loseContext: () => canvas.dispatchEvent(new Event("webglcontextlost")) };
}

/** Frames handed to the encoder, copied at push time as the IPC does (the export reuses its buffer). */
let pushed: number[][] = [];
let onPush: () => void = () => {};
const called = (cmd: string) => vi.mocked(invoke).mock.calls.some(([c]) => c === cmd);

beforeEach(() => {
  pushed = [];
  onPush = () => {};
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, bytes?: unknown) => {
    if (cmd === "push_frame") {
      pushed.push(Array.from(bytes as Uint8Array));
      onPush();
    }
    return cmd === "finish_export" ? "/out.mp4" : undefined;
  });
  useClockStore.getState().setCurrentMs(0);
});

afterEach(() => {
  canvasHandle.current = null;
});

describe("export readback guard", () => {
  it("encodes every delivered frame exactly as read", async () => {
    mountCanvas();
    await expect(exportProject(opts)).resolves.toBe("/out.mp4");
    expect(pushed).toEqual([0, 1, 2].map((f) => Array.from(drawn(f))));
  });

  it("stops at a stalled readback rather than encode it, and cancels the encoder", async () => {
    mountCanvas([1]);
    await expect(exportProject(opts)).rejects.toThrow(
      `GPU stalled (export frame 2/${FRAMES}): readPixels returned an all-zero frame`,
    );
    expect(pushed).toEqual([Array.from(drawn(0))]);
    expect(called("cancel_export")).toBe(true);
    expect(called("finish_export")).toBe(false);
  });

  it("stops when the context is lost and restored between frames", async () => {
    const canvas = mountCanvas();
    onPush = () => {
      if (pushed.length === 1) canvas.loseContext();
    };
    await expect(exportProject(opts)).rejects.toThrow(
      `GPU stalled (export frame 2/${FRAMES}): the WebGL context was lost`,
    );
    expect(pushed).toHaveLength(1);
    expect(called("cancel_export")).toBe(true);
  });

  it("refuses to start on a canvas that lost its context earlier in the session", async () => {
    mountCanvas().loseContext();
    await expect(exportProject(opts)).rejects.toThrow("GPU stalled (before the export)");
    expect(called("start_export")).toBe(false);
  });

  it("fails a single-frame capture whose readback stalled", async () => {
    mountCanvas([0]);
    await expect(captureFrameRgba(opts, 0)).rejects.toThrow(
      "GPU stalled (capture at 0ms): readPixels returned an all-zero frame",
    );
  });

  it("returns a delivered capture untouched", async () => {
    mountCanvas();
    const shot = await captureFrameRgba(opts, 0);
    expect(Array.from(shot.rgba)).toEqual(Array.from(drawn(0)));
  });
});

describe("export cancel", () => {
  it("stops between frames, cancels the encoder and releases the export hold", async () => {
    mountCanvas();
    const abort = new AbortController();
    onPush = () => {
      if (pushed.length === 1) abort.abort();
    };
    await expect(exportProject({ ...opts, signal: abort.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(pushed).toHaveLength(1);
    expect(called("cancel_export")).toBe(true);
    expect(called("finish_export")).toBe(false);
    expect(isExporting()).toBe(false);
  });

  it("never starts the encoder once already cancelled", async () => {
    mountCanvas();
    const abort = new AbortController();
    abort.abort();
    await expect(exportProject({ ...opts, signal: abort.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(called("start_export")).toBe(false);
  });

  it("kills the native encode when the cancel lands while it finalises", async () => {
    mountCanvas();
    const abort = new AbortController();
    let rejectFinish: (e: Error) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "finish_export") {
        return new Promise((_, reject) => {
          rejectFinish = reject;
          abort.abort();
        });
      }
      if (cmd === "cancel_export") rejectFinish(new Error("Export cancelled."));
      return undefined;
    });
    await expect(exportProject({ ...opts, signal: abort.signal })).rejects.toThrow(
      "Export cancelled.",
    );
    expect(called("cancel_export")).toBe(true);
  });

  it("runs no further verify legs after a cancel", async () => {
    mountCanvas();
    const abort = new AbortController();
    onPush = () => abort.abort();
    const commitFormat = vi.fn(async () => {});
    const { format: _, ...base } = opts;
    await expect(
      verifyAllFormats({ ...base, signal: abort.signal }, [format, format], commitFormat),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(commitFormat).toHaveBeenCalledTimes(1);
  });
});

/** Real troika Text whose `sync` starts a typeset that only lands when `land` fires `synccomplete`. */
class FakeTroikaText extends Text {
  syncs = 0;
  override sync() {
    this.syncs++;
    this._needsSync = false;
    this._isSyncing = true;
  }
  land() {
    this._isSyncing = false;
    this.dispatchEvent({ type: "synccomplete" });
  }
}

/** Mounts one pending text mesh, outlined (troika's `[outline, main]` material) or plain. */
function mountText(outlined: boolean) {
  const scene = new Scene();
  const text = new FakeTroikaText();
  text.outlineBlur = outlined ? 0.05 : 0;
  text._needsSync = true;
  scene.add(text);
  return { scene, text };
}

describe("awaitTextSync", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** Starts the barrier and reports whether it has resolved yet. */
  function track(scene: Scene) {
    let settled = false;
    const done = awaitTextSync(scene).then(() => {
      settled = true;
    });
    return { done, settled: () => settled };
  }

  it.each([
    ["plain", false],
    ["outlined", true],
  ])("kicks and awaits %s text", async (_, outlined) => {
    const { scene, text } = mountText(outlined);
    expect(Array.isArray(text.material)).toBe(outlined);
    const barrier = track(scene);
    await flush();
    expect(text.syncs).toBe(1);
    expect(barrier.settled()).toBe(false);
    text.land();
    await barrier.done;
    expect(barrier.settled()).toBe(true);
  });

  it("keeps awaiting text whose outline appears mid-scene", async () => {
    const { scene, text } = mountText(false);
    const first = track(scene);
    text.land();
    await first.done;
    text.outlineBlur = 0.05;
    text._needsSync = true;
    expect(Array.isArray(text.material)).toBe(true);
    const second = track(scene);
    await flush();
    expect(text.syncs).toBe(2);
    expect(second.settled()).toBe(false);
    text.land();
    await second.done;
  });

  it("skips non-text meshes, whatever their material", async () => {
    const scene = new Scene();
    const sync = vi.fn();
    scene.add(Object.assign(new Mesh(undefined, [new MeshBasicMaterial()]), { sync }));
    await awaitTextSync(scene);
    expect(sync).not.toHaveBeenCalled();
  });

  it("fails, naming the text, when a typeset never lands", async () => {
    vi.useFakeTimers();
    try {
      const { scene, text } = mountText(true);
      text.text = "HALO";
      const failed = expect(awaitTextSync(scene)).rejects.toThrow(
        'never settled: 1 pending ("HALO")',
      );
      await vi.runAllTimersAsync();
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });
});
