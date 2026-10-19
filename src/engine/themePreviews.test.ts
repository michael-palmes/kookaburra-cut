import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setExporting } from "./exportState";
import type { LoadedProject } from "./project";
import { loadProject } from "./project";
import { captureFrameAt } from "./snapshots";
import { ensureUserThemePreviews, themePreviewKey, themeVariantsOf } from "./themePreviews";

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

  it("keys and renders a variant on its merged document", async () => {
    const base = { version: 2, id: "base", name: "Base", mode: "dark", colors: { accent: "red" } };
    const variant = { version: 3, id: "night", name: "Night", extends: "ws:base", mode: "light" };
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "read_theme" ? JSON.stringify(base) : null,
    );
    await ensureUserThemePreviews("ws:night", JSON.stringify(variant), apply, vi.fn());
    const merged = {
      mode: "light",
      colors: { accent: "red" },
      version: 3,
      id: "night",
      name: "Night",
    };
    expect(loadProject).toHaveBeenCalledWith("preview-lab-theme", {
      theme: { ...merged, id: "ws:night" },
    });
    const key = await themePreviewKey(JSON.stringify(merged));
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([command, args]) =>
            command === "list_theme_previews" && (args as { key: string }).key === key,
        ),
    ).toBe(true);
  });

  it("lists the variants a base edit should re-render", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { slug: "base", json: '{"version":2}' },
      { slug: "night", json: '{"version":3,"extends":"ws:base"}' },
      { slug: "late", json: '{"version":3,"extends":"ws:night"}' },
      { slug: "solo", json: '{"version":3}' },
    ]);
    expect(await themeVariantsOf("ws:base")).toEqual([
      ["ws:night", '{"version":3,"extends":"ws:base"}'],
      ["ws:late", '{"version":3,"extends":"ws:night"}'],
    ]);
  });
});
