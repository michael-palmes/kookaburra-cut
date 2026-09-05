import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveScreenshotTimeMs } from "../engine/autorun";
import { captureFrameRgba } from "../engine/exporter";
import { FORMATS } from "../engine/format";
import { loadProject } from "../engine/project";
import { withProjectAssetRevision } from "../engine/projectAssetRevision";
import { startBridgeService } from "./bridgeService";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("../engine/autorun", () => ({ resolveScreenshotTimeMs: vi.fn(() => 2400) }));
vi.mock("../engine/exporter", () => ({
  awaitSceneHostsCommitted: vi.fn(),
  captureFrameRgba: vi.fn(),
  captureScreenshot: vi.fn(),
}));
vi.mock("../engine/themePreviews", () => ({ awaitProjectCommitted: vi.fn() }));
vi.mock("../engine/clips", () => ({ invalidateChangedClips: vi.fn() }));
vi.mock("../engine/project", () => ({
  bumpWorkspaceReloadToken: vi.fn(),
  isEditableProjectId: () => true,
  loadProject: vi.fn(),
  nativeProjectSlug: (id: string) => id,
  projectIdForNativeSlug: (id: string) => id,
  refreshBundledProjectAssets: vi.fn(),
  sceneFileStem: (file: string) => file,
}));

let stop: (() => void) | undefined;
let context: { playing: boolean; exportLocked: boolean; aspect: string };
let jobs: { slug: string; revision: string; atMs: number | null }[];
const project = {
  id: "preset:hero",
  slots: [{ durationMs: 4000, startMs: 0 }],
  totalMs: 4000,
  sceneFiles: ["hero.tsx"],
} as Awaited<ReturnType<typeof loadProject>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  context = { playing: false, exportLocked: false, aspect: "9:16" };
  jobs = [{ slug: "preset:hero", revision: "saved-a", atMs: 2400 }];
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "get_editor_context") return { ...context };
    if (command === "render_take_preset_poster") return jobs.shift() ?? null;
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
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("hidden preset poster rendering", () => {
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
      headers: { "x-kookaburra-slug": "preset:hero", "x-kookaburra-revision": "saved-a" },
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
        retry: true,
      });
      expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "write_preset_poster")).toBe(
        false,
      );
    },
  );

  it("reloads a newly queued source revision for the same preset", async () => {
    jobs.push({ ...jobs[0], revision: "saved-b" });
    stop = startBridgeService(vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadProject).toHaveBeenCalledTimes(2);
  });

  it("requests a new texture URL when a later saved revision replaces an asset in place", async () => {
    jobs.push({ ...jobs[0], revision: "image-replaced" });
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

  it("abandons an untrusted workspace preset and continues serving the next job", async () => {
    jobs.unshift({ slug: "ws-preset:untrusted", revision: "unapproved", atMs: null });
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
        retry: false,
      });
      expect(captureFrameRgba).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("write_preset_poster", expect.any(Uint8Array), {
        headers: { "x-kookaburra-slug": "preset:hero", "x-kookaburra-revision": "saved-a" },
      });
    } finally {
      warning.mockRestore();
    }
  });
});
