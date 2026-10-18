import { beforeAll, describe, expect, it, vi } from "vitest";

// The clip pipeline's native side, scripted: a conform job writes SRC until the test lands it.
const SRC = "/ws/product-tour/assets/rec.mp4";
const job = { slug: "product-tour", rel: "assets/rec.mp4", frame: 30, total: 120 };
let conforming = true;
const shas = new Map<string, string>();
const handlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "clip_conform_pending") return conforming ? job : null;
    if (cmd === "file_revisions") {
      return ((args?.paths ?? []) as string[]).map((path) => (shas.has(path) ? "10-1" : null));
    }
    if (cmd === "clip_info") {
      const sha = shas.get(args?.srcAbs as string);
      if (!sha) throw new Error("unreadable");
      return { cacheDir: `/cache/${sha}`, frameCount: 10, width: 64, height: 64, fps: 60, sha };
    }
    if (cmd === "set_clip_cache_pins") return null;
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => {};
  }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

let clips: typeof import("../../engine/clips");
let exportState: typeof import("../../engine/exportState");
let standIn: typeof import("./conformStandIn");

// Transform the module graph once, outside the 5 s test timeout.
beforeAll(async () => {
  clips = await import("../../engine/clips");
  exportState = await import("../../engine/exportState");
  standIn = await import("./conformStandIn");
}, 30_000);

describe("the conform stand-in", () => {
  it("shows while the clip's conform runs, never in an export, and gives way when it lands", async () => {
    const entry = clips.registerClip(SRC);
    await flush();
    await flush();
    const pending = clips.clipPendingState(SRC);
    expect(pending).toMatchObject({ rel: "assets/rec.mp4", progress: 0.25 });
    expect(standIn.clipStandInMode(pending, false)).toBe("conform");

    exportState.setExporting(true);
    expect(standIn.clipStandInMode(pending, exportState.isExporting())).toBe("preparing");
    exportState.setExporting(false);

    // Progress redraws the ring; the landing's media-changed swaps in the real frames.
    const changes = vi.fn();
    const off = clips.subscribeClipPending(changes);
    handlers.get("kookaburra://conform-progress")?.({
      payload: { ...job, stage: "conforming", frame: 90, error: null },
    });
    expect(clips.clipPendingState(SRC)?.progress).toBe(0.75);
    conforming = false;
    shas.set(SRC, "sha-mezz");
    handlers.get("kookaburra://media-changed")?.({
      payload: { slug: "product-tour", paths: ["assets/rec.mp4"], origin: "conform" },
    });
    expect((await entry.promise).cacheDir).toBe("/cache/sha-mezz");
    await flush();
    expect(changes).toHaveBeenCalled();
    expect(clips.clipPendingState(SRC)).toBeNull();
    expect(standIn.clipStandInMode(clips.clipPendingState(SRC), false)).toBe("preparing");
    off();
  });

  it("sweeps the ring with the job and labels the wait", () => {
    expect(standIn.conformRingSweep(null)).toBe(0);
    expect(standIn.conformRingSweep(0)).toBe(0);
    expect(standIn.conformRingSweep(0.5)).toBeCloseTo(Math.PI);
    expect(standIn.conformRingSweep(2)).toBeCloseTo(Math.PI * 2);
    expect(standIn.conformStandInLabel(null)).toBe("Waiting to conform");
    expect(standIn.conformStandInLabel(0.4)).toBe("Conforming");
  });

  it("cover-fits the poster to the screen", () => {
    // A landscape poster on a portrait screen crops its sides.
    expect(standIn.coverSourceRect(1920, 1080, 0.5)).toEqual({ sx: 690, sy: 0, sw: 540, sh: 1080 });
    // A portrait poster on a landscape card crops top and bottom.
    expect(standIn.coverSourceRect(1000, 2000, 2)).toEqual({ sx: 0, sy: 750, sw: 1000, sh: 500 });
  });

  it("draws the poster under the ring and its percentage", () => {
    const ops: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_, key) =>
          typeof key === "string" && !["fillStyle", "strokeStyle", "font"].includes(key)
            ? (...args: unknown[]) => ops.push(`${key}(${args.map(String).join(",")})`)
            : undefined,
        set: () => true,
      },
    );
    const canvas = {
      width: 400,
      height: 800,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    const poster = { width: 1179, height: 2556 } as unknown as ImageBitmap;
    standIn.drawConformStandIn(canvas, poster, 0.42);
    expect(ops.some((op) => op.startsWith("drawImage("))).toBe(true);
    expect(ops).toContain("fillText(42%,200,384)");
    expect(ops.some((op) => op.startsWith("fillText(Conforming,"))).toBe(true);
    ops.length = 0;
    standIn.drawConformStandIn(canvas, null, null);
    expect(ops.some((op) => op.startsWith("drawImage("))).toBe(false);
    expect(ops.some((op) => op.startsWith("fillText(Waiting to conform,"))).toBe(true);
    expect(ops.filter((op) => op.startsWith("arc(")).length).toBe(1);
  });
});

describe("the stand-in's mounts", () => {
  const testFs = (
    globalThis as unknown as {
      process: {
        getBuiltinModule: (name: "fs") => { readFileSync: (p: URL, e: "utf8") => string };
      };
    }
  ).process.getBuiltinModule("fs");
  const read = (path: string) => testFs.readFileSync(new URL(path, import.meta.url), "utf8");

  it("binds on a device screen only after the export branch has blacked it out", () => {
    const device = read("../device/Device.tsx");
    const onPending = device.slice(device.indexOf("const onPending = useCallback(() => {"));
    expect(onPending.indexOf("if (isExporting()) {")).toBeGreaterThan(-1);
    expect(onPending.indexOf("if (isExporting()) {")).toBeLessThan(
      onPending.indexOf("material.map = standIn;"),
    );
  });

  it("fills a media plane only while no frame has bound outside an export", () => {
    expect(read("./SceneMedia.tsx")).toMatch(
      /\{!ready && !isExporting\(\) && \(\s*<mesh[^>]*>\s*<planeGeometry[^>]*\/>\s*<meshBasicMaterial map=\{standIn\}/,
    );
  });
});
