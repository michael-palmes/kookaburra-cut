import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveScreenshotTimeMs } from "../engine/autorun";
import { captureFrameRgba } from "../engine/exporter";
import { type AspectName, FORMATS } from "../engine/format";
import { loadProject } from "../engine/project";
import { withProjectAssetRevision } from "../engine/projectAssetRevision";
import { startBridgeService } from "./bridgeService";

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
