import { invoke } from "@tauri-apps/api/core";
import { PerspectiveCamera, Scene } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClockStore } from "./clock";
import { canvasHandle, trackContextLosses } from "./exportBridge";
import { captureFrameRgba, type ExportOptions, exportProject } from "./exporter";
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
