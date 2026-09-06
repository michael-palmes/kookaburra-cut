import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canQueuePresetPoster, queuePresetPoster } from "./presetPosters";
import { ensureProjectTrusted } from "./projectTrust";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../ui/settleContentEdits", () => ({ settlePendingContentEdits: vi.fn(async () => {}) }));
vi.mock("./projectTrust", () => ({ ensureProjectTrusted: vi.fn() }));
vi.mock("./project", () => ({
  parseProjectId: (id: string) => ({ scope: id.split(":")[0] }),
  nativeProjectSlug: (id: string) => id,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ensureProjectTrusted).mockResolvedValue();
});

describe("preset poster scheduling", () => {
  it("permits personal templates and presets, and bundled originals in development", () => {
    expect(canQueuePresetPoster("ws-preset:hero", false)).toBe(true);
    expect(canQueuePresetPoster("preset:hero", true)).toBe(true);
    expect(canQueuePresetPoster("preset:hero", false)).toBe(false);
    expect(canQueuePresetPoster("ws-template:hero", false)).toBe(true);
    expect(canQueuePresetPoster("template:hero", true)).toBe(true);
    expect(canQueuePresetPoster("template:hero", false)).toBe(false);
    for (const id of ["hero", "ws:hero"]) {
      expect(canQueuePresetPoster(id, true)).toBe(false);
    }
  });

  it("queues the scoped saved source without reading or seeking the editor canvas", async () => {
    await queuePresetPoster("ws-preset:hero");
    expect(ensureProjectTrusted).toHaveBeenCalledWith("ws-preset:hero", "ws-preset:hero");
    expect(vi.mocked(ensureProjectTrusted).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invoke).mock.invocationCallOrder[0],
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith("render_submit_preset_poster", {
      slug: "ws-preset:hero",
      prioritySlot: undefined,
    });
  });

  it("promotes only the manually selected slot after pending edits settle", async () => {
    await queuePresetPoster("ws-template:hero", 3);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("render_submit_preset_poster", {
      slug: "ws-template:hero",
      prioritySlot: 3,
    });
  });

  it("never submits a workspace preset after consent is declined", async () => {
    vi.mocked(ensureProjectTrusted).mockRejectedValue(new Error("Trust declined"));
    await expect(queuePresetPoster("ws-preset:imported")).rejects.toThrow("Trust declined");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves ordinary workspace snapshots on their existing path", async () => {
    await queuePresetPoster("ws:hero");
    expect(invoke).not.toHaveBeenCalled();
  });
});
