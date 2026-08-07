import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedProject } from "./project";

/** The native thumb cache, scripted per test; `submitted`/`cancelled` record the queue traffic to the render window. */
let listing = {
  stamp: null as string | null,
  thumbs: {} as Record<string, string>,
  stamps: {} as Record<string, string>,
  sourceStamps: {} as Record<string, string>,
};
const submitted: { slug: string; generation: number; jobs: { stem: string; stamp: string }[] }[] =
  [];
const cancelled: number[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, arg?: unknown) => {
    if (cmd === "list_scene_thumbs") return listing;
    if (cmd === "render_submit_thumbs") {
      submitted.push((arg as { batch: (typeof submitted)[number] }).batch);
      return undefined;
    }
    if (cmd === "render_cancel_thumbs") {
      cancelled.push((arg as { generation: number }).generation);
      return undefined;
    }
    throw new Error(`unexpected command ${cmd}`);
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
  submitted.length = 0;
  cancelled.length = 0;
  listing = { stamp: null, thumbs: {}, stamps: {}, sourceStamps: {} };
});

describe("ensureSceneThumbs", () => {
  it("submits nothing when every thumb matches its source stamp", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = {
      stamp: null,
      thumbs: { a: "/t/a.png", b: "/t/b.png" },
      stamps: { a: "1", b: "2" },
      sourceStamps: { a: "1", b: "2" },
    };
    const thumbs = await ensureSceneThumbs(project(["a", "b"]));
    expect(submitted).toEqual([]);
    expect(thumbs).toEqual({ a: "/t/a.png", b: "/t/b.png" });
  });

  it("submits only the added scene, not the whole project", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = {
      stamp: null,
      thumbs: { a: "/t/a.png", b: "/t/b.png" },
      stamps: { a: "1", b: "2" },
      sourceStamps: { a: "1", b: "2", c: "3" },
    };
    const thumbs = await ensureSceneThumbs(project(["a", "b", "c"]));
    expect(submitted).toHaveLength(1);
    expect(submitted[0].slug).toBe("demo");
    expect(submitted[0].jobs).toEqual([{ stem: "c", stamp: "3" }]);
    // Resolves immediately with the cached set; the fresh thumb announces itself later.
    expect(thumbs).toEqual({ a: "/t/a.png", b: "/t/b.png" });
  });

  it("resubmits a scene whose sources moved, stamped with the new value", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = {
      stamp: null,
      thumbs: { a: "/t/a.png", b: "/t/b.png" },
      stamps: { a: "1", b: "2" },
      sourceStamps: { a: "1", b: "2-edited" },
    };
    await ensureSceneThumbs(project(["a", "b"]));
    expect(submitted[0].jobs).toEqual([{ stem: "b", stamp: "2-edited" }]);
  });

  it("skips a stem with no scene module on disk instead of queueing forever", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = { stamp: null, thumbs: {}, stamps: {}, sourceStamps: {} };
    await ensureSceneThumbs(project(["ghost"]));
    expect(submitted).toEqual([]);
  });

  it("an aborted signal cancels this submission's generation", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    listing = { stamp: null, thumbs: {}, stamps: {}, sourceStamps: { a: "1" } };
    const controller = new AbortController();
    await ensureSceneThumbs(project(["a"]), { signal: controller.signal });
    expect(submitted).toHaveLength(1);
    controller.abort();
    await Promise.resolve();
    expect(cancelled).toEqual([submitted[0].generation]);
  });

  it("ignores non-workspace projects", async () => {
    const { ensureSceneThumbs } = await import("./sceneThumbs");
    const bundled = { ...project(["a"]), id: "showcase-tour" } as LoadedProject;
    expect(await ensureSceneThumbs(bundled)).toEqual({});
    expect(submitted).toEqual([]);
  });
});
