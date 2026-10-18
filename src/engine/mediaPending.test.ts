import { beforeEach, describe, expect, it, vi } from "vitest";

// Native commands scripted per test: media_meta serves the files on disk, list_conform_jobs the running jobs.
const files = new Map<string, Record<string, unknown>>();
let jobs: { slug: string; rel: string; original: string; frame: number; total: number }[] = [];
const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
const emitted: { name: string; payload: unknown }[] = [];
const handlers = new Map<string, (event: { payload: unknown }) => void>();
let removed = { count: 1, bytes: 10 };

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "media_meta") {
      const meta = files.get(args?.rel as string);
      if (!meta) throw new Error(`asset not found: ${args?.rel}`);
      return meta;
    }
    if (cmd === "list_conform_jobs") return jobs;
    if (cmd === "cancel_conform") return null;
    if (cmd === "remove_original" || cmd === "remove_originals") return removed;
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (name: string, payload: unknown) => {
    emitted.push({ name, payload });
  }),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));

const media = await import("./media");

const flush = () => new Promise((r) => setTimeout(r, 0));

const meta = (rel: string, extra: Record<string, unknown> = {}) => ({
  rel,
  kind: "video",
  width: 1179,
  height: 2556,
  fps: 59.94,
  durationMs: 30_000,
  posterPath: `/cache/${rel}/poster.jpg`,
  scrubPaths: [],
  sha: "a".repeat(64),
  ...extra,
});

const job = {
  slug: "product-tour",
  rel: "assets/rec.mp4",
  original: "assets/.originals/rec.mov",
  frame: 0,
  total: 0,
};

beforeEach(() => {
  files.clear();
  jobs = [];
  calls.length = 0;
  emitted.length = 0;
  handlers.clear();
  removed = { count: 1, bytes: 10 };
});

describe("media meta for a clip still conforming", () => {
  it("answers once the mezzanine lands, so a drop or a probe made early still resolves", async () => {
    jobs = [job];
    let resolved: unknown = null;
    const pending = media.mediaMeta("product-tour", "assets/rec.mp4").then((m) => {
      resolved = m;
    });
    await flush();
    await flush();
    expect(resolved).toBeNull();
    files.set("assets/rec.mp4", meta("assets/rec.mp4", { fps: 60 }));
    jobs = [];
    handlers.get(media.CONFORM_PROGRESS_EVENT)?.({
      payload: { ...job, stage: "done", frame: 1800, total: 1800, error: null },
    });
    await pending;
    expect(resolved).toMatchObject({ rel: "assets/rec.mp4", fps: 60 });
  });

  it("fails at once for a missing file nobody is writing", async () => {
    await expect(media.mediaMeta("product-tour", "assets/gone.mp4")).rejects.toThrow(
      /asset not found/,
    );
  });

  it("ignores other files' conforms and fails when the conform does", async () => {
    jobs = [job];
    const pending = media.mediaMeta("product-tour", "assets/rec.mp4");
    await flush();
    await flush();
    handlers.get(media.CONFORM_PROGRESS_EVENT)?.({
      payload: { ...job, rel: "assets/other.mp4", stage: "done", error: null },
    });
    jobs = [];
    handlers.get(media.CONFORM_PROGRESS_EVENT)?.({
      payload: { ...job, stage: "failed", error: media.CONFORM_CANCELLED },
    });
    await expect(pending).rejects.toThrow(/asset not found/);
  });

  it("reads a pending card off the original, under the final path at 60 fps", async () => {
    files.set(job.original, meta(job.original));
    const card = await media.pendingConformMeta("product-tour", job);
    expect(card).toMatchObject({
      rel: "assets/rec.mp4",
      fps: media.CONFORM_FPS,
      width: 1179,
      height: 2556,
      posterPath: `/cache/${job.original}/poster.jpg`,
    });
    // A job seen first through a progress event has no original yet: the job list names it.
    jobs = [job];
    const looked = await media.pendingConformMeta("product-tour", { rel: job.rel, original: "" });
    expect(looked.posterPath).toBe(card.posterPath);
    await expect(
      media.pendingConformMeta("product-tour", { rel: "assets/gone.mp4", original: "" }),
    ).rejects.toThrow(/isn't conforming/);
  });
});

describe("conform cancel and kept originals", () => {
  it("cancels by project and rel", async () => {
    await media.cancelConform("product-tour", "assets/rec.mp4");
    expect(calls.at(-1)).toEqual({
      cmd: "cancel_conform",
      args: { slug: "product-tour", rel: "assets/rec.mp4" },
    });
  });

  it("removes one or every original and tells the other windows", async () => {
    await expect(media.removeOriginal("product-tour", "assets/rec.mp4")).resolves.toEqual({
      count: 1,
      bytes: 10,
    });
    expect(calls.at(-1)).toEqual({
      cmd: "remove_original",
      args: { slug: "product-tour", rel: "assets/rec.mp4" },
    });
    expect(emitted).toEqual([{ name: "kookaburra://media-changed", payload: null }]);
    removed = { count: 0, bytes: 0 };
    await media.removeOriginals("product-tour");
    expect(calls.at(-1)?.cmd).toBe("remove_originals");
    expect(emitted).toHaveLength(1);
  });
});
