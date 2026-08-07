import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedProject } from "./project";

/** The native thumb cache, scripted per test; `writes` records which stems were captured. */
let listing = {
  stamp: null as string | null,
  thumbs: {} as Record<string, string>,
  stamps: {} as Record<string, string>,
  sourceStamps: {} as Record<string, string>,
};
const writes: { stem: string; stamp: string }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    async (cmd: string, _arg?: unknown, opts?: { headers?: Record<string, string> }) => {
      if (cmd === "list_scene_thumbs") return listing;
      if (cmd === "write_scene_thumb") {
        writes.push({
          stem: opts?.headers?.["x-kookaburra-stem"] ?? "",
          stamp: opts?.headers?.["x-kookaburra-stamp"] ?? "",
        });
        return undefined;
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  ),
}));

const captured: number[] = [];
let onCapture: (() => void) | null = null;
vi.mock("./snapshots", () => ({
  withBorrowedClock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  captureFrameAt: vi.fn(async (tMs: number) => {
    captured.push(tMs);
    onCapture?.();
    return new Uint8Array([1]);
  }),
}));

function project(stems: string[]): LoadedProject {
  return {
    id: "ws:demo",
    sceneFiles: stems.map((s) => `scenes/${s}.tsx`),
    slots: stems.map((_, i) => ({ startMs: i * 1000, durationMs: 1000 })),
  } as unknown as LoadedProject;
}

beforeEach(() => {
  writes.length = 0;
  captured.length = 0;
  onCapture = null;
  listing = { stamp: null, thumbs: {}, stamps: {}, sourceStamps: {} };
});

describe("ensureSceneThumbs", () => {
  it("captures nothing when every thumb matches its source stamp", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = {
      stamp: null,
      thumbs: { a: "/t/a.png", b: "/t/b.png" },
      stamps: { a: "1", b: "2" },
      sourceStamps: { a: "1", b: "2" },
    };
    const thumbs = await ensureSceneThumbs(project(["a", "b"]));
    expect(writes).toEqual([]);
    expect(captured).toEqual([]);
    expect(thumbs).toEqual({ a: "/t/a.png", b: "/t/b.png" });
  });

  it("captures only the added scene, not the whole project", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = {
      stamp: null,
      thumbs: { a: "/t/a.png", b: "/t/b.png" },
      stamps: { a: "1", b: "2" },
      sourceStamps: { a: "1", b: "2", c: "3" },
    };
    await ensureSceneThumbs(project(["a", "b", "c"]));
    expect(writes).toEqual([{ stem: "c", stamp: "3" }]);
    // Third slot, so the centre frame of 2000..3000.
    expect(captured).toEqual([2500]);
  });

  it("recaptures a scene whose sources moved, and stamps it with the new value", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = {
      stamp: null,
      thumbs: { a: "/t/a.png", b: "/t/b.png" },
      stamps: { a: "1", b: "2" },
      sourceStamps: { a: "1", b: "2-edited" },
    };
    await ensureSceneThumbs(project(["a", "b"]));
    expect(writes).toEqual([{ stem: "b", stamp: "2-edited" }]);
  });

  it("skips a stem with no scene module on disk instead of capturing forever", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = { stamp: null, thumbs: {}, stamps: {}, sourceStamps: {} };
    await ensureSceneThumbs(project(["ghost"]));
    expect(writes).toEqual([]);
    expect(captured).toEqual([]);
  });

  it("an aborted signal stops between scenes, keeping thumbs already captured", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = { stamp: null, thumbs: {}, stamps: {}, sourceStamps: { a: "1", b: "2", c: "3" } };
    const controller = new AbortController();
    onCapture = () => controller.abort();
    await ensureSceneThumbs(project(["a", "b", "c"]), { signal: controller.signal });
    expect(writes).toEqual([{ stem: "a", stamp: "1" }]);
    expect(captured).toEqual([500]);
  });

  it("ignores non-workspace projects", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    const bundled = { ...project(["a"]), id: "showcase-tour" } as LoadedProject;
    expect(await ensureSceneThumbs(bundled)).toEqual({});
    expect(writes).toEqual([]);
  });
});
