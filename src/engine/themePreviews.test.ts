import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setExporting } from "./exportState";
import type { LoadedProject } from "./project";
import { loadProject } from "./project";
import { captureFrameAt } from "./snapshots";
import { ensureUserThemePreviews, themePreviewKey } from "./themePreviews";

const state = vi.hoisted(() => ({
  applied: null as unknown,
  borrowing: false,
  starter: { slots: [{ startMs: 0, durationMs: 2000 }] },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./exportBridge", () => ({ canvasCommittedProject: () => state.applied }));
vi.mock("./exporter", () => ({ awaitSceneHostsCommitted: vi.fn() }));
vi.mock("./media", () => ({ fsUrl: (path: string) => path }));
vi.mock("../theme/schema", () => ({ parseThemeDoc: (doc: unknown) => doc }));
vi.mock("./project", () => ({ loadProject: vi.fn(async () => state.starter) }));
vi.mock("../toolkit/stage/backdrops", () => ({ preloadBundledBackdrops: vi.fn() }));
vi.mock("./snapshots", () => ({
  captureFrameAt: vi.fn(),
  withBorrowedClock: async (run: () => Promise<unknown>) => {
    if (state.borrowing) return null;
    state.borrowing = true;
    try {
      return await run();
    } finally {
      state.borrowing = false;
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.applied = null;
  state.borrowing = false;
  setExporting(false);
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(captureFrameAt).mockResolvedValue(new Uint8Array([1]));
});

describe("theme preview generation", () => {
  const apply = (project: LoadedProject) => {
    state.applied = project;
  };

  it("uses the same key before and after native JSON reformatting", async () => {
    expect(
      await themePreviewKey('{"name":"Demo","colors":{"text":"white","background":"black"}}'),
    ).toBe(
      await themePreviewKey('{ "colors": {"background":"black","text":"white"}, "name":"Demo" }'),
    );
    expect(await themePreviewKey('{"colors":["red","blue"]}')).not.toBe(
      await themePreviewKey('{"colors":["blue","red"]}'),
    );
  });

  it("never swaps projects during an export or another capture", async () => {
    const swap = vi.fn();
    setExporting(true);
    await ensureUserThemePreviews("ws:demo", "{}", swap, vi.fn());
    setExporting(false);
    state.borrowing = true;
    await ensureUserThemePreviews("ws:demo", "{}", swap, vi.fn());
    expect(swap).not.toHaveBeenCalled();
    expect(captureFrameAt).not.toHaveBeenCalled();
  });

  it("restores the user's project after a failed capture", async () => {
    vi.mocked(captureFrameAt).mockRejectedValue(new Error("capture failed"));
    const restore = vi.fn();
    await expect(ensureUserThemePreviews("ws:demo", "{}", apply, restore)).rejects.toThrow(
      "capture failed",
    );
    expect(restore).toHaveBeenCalledOnce();
  });

  it("renders the saved document and releases the clock before restoring", async () => {
    const restore = vi.fn(async () => {
      expect(state.borrowing).toBe(false);
    });
    await ensureUserThemePreviews("ws:demo", '{"name":"Saved version"}', apply, restore);
    expect(loadProject).toHaveBeenCalledWith("preview-lab-theme", {
      theme: { id: "ws:demo", name: "Saved version" },
    });
    expect(restore).toHaveBeenCalledOnce();
  });

  it("does not restore an old project after navigation", async () => {
    let current = true;
    vi.mocked(captureFrameAt).mockImplementation(async () => {
      current = false;
      return new Uint8Array([1]);
    });
    const restore = vi.fn();
    await ensureUserThemePreviews("ws:demo", "{}", apply, restore, () => current);
    expect(restore).not.toHaveBeenCalled();
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === "write_theme_preview"),
    ).toBe(false);
  });
});
