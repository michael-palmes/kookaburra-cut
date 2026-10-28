import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConformProgressPayload, NativePort } from "./stageRealm";

// The pipeline's native side, scripted per test through a fake stage port: clipHash serves the current sha per source (throws when absent, a deleted file), clipRevisions the current stamp (null when unset, the legacy full re-hash), clipInfo a cold entry keyed by that sha, clipEnsureChunks records each request, clipConformPending serves the scripted conform jobs.
const shas = new Map<string, string>();
const revs = new Map<string, string>();
const frameCounts = new Map<string, number>();
const conformJobs = new Map<string, { slug: string; rel: string; frame: number; total: number }>();
const ensureCalls: { srcAbs: string; chunks: number[] }[] = [];
const pinCalls: string[][] = [];
const infoCalls: string[] = [];
let failExtract = false;
let failChunks = false;
let hashCalls = 0;
const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();

/** A clip source key for the test project. */
const src = (rel: string, projectId = "ws:p") => `${projectId}\u0001${rel}`;

const fakePort: NativePort = {
  async clipRevisions(keys) {
    return keys.map((key) => revs.get(key) ?? null);
  },
  async clipInfo(key) {
    infoCalls.push(key);
    if (failExtract) throw new Error("extraction failed");
    const sha = shas.get(key);
    if (!sha) throw new Error("unreadable");
    return {
      cacheDir: `/cache/${sha}`,
      frameCount: frameCounts.get(key) ?? 10,
      width: 64,
      height: 64,
      fps: 60,
      sha,
      chunks: [],
      previewChunks: [],
    };
  },
  async clipHash(key) {
    hashCalls++;
    const sha = shas.get(key);
    if (!sha) throw new Error("unreadable");
    return sha;
  },
  async clipEnsureChunks(key, _cacheDir, chunks) {
    if (failChunks) throw new Error("ffmpeg died");
    ensureCalls.push({ srcAbs: key, chunks: [...chunks] });
  },
  async clipEnsurePreviews() {},
  async clipReadFrame() {
    return new ArrayBuffer(8);
  },
  async clipSetPins(dirs) {
    pinCalls.push([...dirs]);
  },
  async clipConformPending(key) {
    return conformJobs.get(key) ?? null;
  },
  async watchConforms(handlers) {
    eventHandlers.set("kookaburra://conform-progress", ({ payload }) =>
      handlers.progress(payload as ConformProgressPayload),
    );
    eventHandlers.set("kookaburra://media-changed", ({ payload }) => {
      const p = payload as { slug?: string; paths?: string[]; origin?: string } | null;
      if (p?.origin !== "conform" || !Array.isArray(p.paths)) return;
      handlers.mediaChanged(p.slug, p.paths);
    });
  },
  async conformPoster() {
    return null;
  },
  async emojiRead() {
    return null;
  },
  async emojiWrite() {},
  async readObject() {
    throw new Error("no objects here");
  },
  async decodePng() {
    throw new Error("no PNGs here");
  },
};

const flush = () => new Promise((r) => setTimeout(r, 0));

function chunksRequested(srcAbs: string): number[] {
  return ensureCalls
    .filter((call) => call.srcAbs === srcAbs)
    .flatMap((call) => call.chunks)
    .sort((a, b) => a - b);
}

// Fresh module state per test: the registry and its version counter are module-level, and the reset realm needs the port again.
async function freshClips() {
  vi.resetModules();
  (await import("./stageRealm")).setNativePort(fakePort);
  return await import("./clips");
}

// Transform the module graph once outside the 5 s test timeout, which a cold transform under load can exceed.
beforeAll(async () => {
  await import("./clips");
}, 30_000);

beforeEach(() => {
  shas.clear();
  revs.clear();
  frameCounts.clear();
  conformJobs.clear();
  ensureCalls.length = 0;
  pinCalls.length = 0;
  infoCalls.length = 0;
  eventHandlers.clear();
  failExtract = false;
  failChunks = false;
  hashCalls = 0;
});

describe("invalidateChangedClips", () => {
  it("evicts a clip whose file changed on disk so it re-extracts", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-old");
    const before = clips.registerClip(src("assets/a.mp4"));
    const oldInfo = await before.promise;
    expect(oldInfo.cacheDir).toBe("/cache/sha-old");

    shas.set(src("assets/a.mp4"), "sha-new");
    const version = clips.clipRegistryVersion();
    await clips.invalidateChangedClips();
    expect(clips.clipRegistryVersion()).toBe(version + 1);

    const after = clips.registerClip(src("assets/a.mp4"));
    expect(after).not.toBe(before);
    expect((await after.promise).cacheDir).toBe("/cache/sha-new");
  });

  it("keeps a clip whose file is unchanged", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-1");
    const before = clips.registerClip(src("assets/a.mp4"));
    await before.promise;

    const version = clips.clipRegistryVersion();
    await clips.invalidateChangedClips();
    expect(clips.clipRegistryVersion()).toBe(version);
    expect(clips.registerClip(src("assets/a.mp4"))).toBe(before);
  });

  it("evicts a failed extraction so the next registration retries", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-1");
    failExtract = true;
    const broken = clips.registerClip(src("assets/a.mp4"));
    await broken.promise.catch(() => {});
    expect(broken.error).toBeTruthy();

    failExtract = false;
    await clips.invalidateChangedClips();
    const retried = clips.registerClip(src("assets/a.mp4"));
    expect(retried).not.toBe(broken);
    expect((await retried.promise).cacheDir).toBe("/cache/sha-1");
  });

  it("evicts a clip whose file became unreadable", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-1");
    const before = clips.registerClip(src("assets/a.mp4"));
    await before.promise;

    shas.delete(src("assets/a.mp4"));
    await clips.invalidateChangedClips();
    expect(clips.registerClip(src("assets/a.mp4"))).not.toBe(before);
  });

  it("never re-hashes a clip whose stamp has not moved", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-1");
    revs.set(src("assets/a.mp4"), "100-1");
    const before = clips.registerClip(src("assets/a.mp4"));
    await before.promise;
    const hashed = hashCalls;

    await clips.invalidateChangedClips();
    await clips.invalidateChangedClips();
    expect(hashCalls).toBe(hashed);
    expect(clips.registerClip(src("assets/a.mp4"))).toBe(before);
  });

  it("re-hashes once when the stamp moves over the same bytes, then adopts it", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-1");
    revs.set(src("assets/a.mp4"), "100-1");
    const before = clips.registerClip(src("assets/a.mp4"));
    await before.promise;
    const hashed = hashCalls;

    revs.set(src("assets/a.mp4"), "100-2");
    const version = clips.clipRegistryVersion();
    await clips.invalidateChangedClips();
    expect(hashCalls).toBe(hashed + 1);
    expect(clips.clipRegistryVersion()).toBe(version);
    await clips.invalidateChangedClips();
    expect(hashCalls).toBe(hashed + 1);
    expect(clips.registerClip(src("assets/a.mp4"))).toBe(before);
  });

  it("evicts a clip replaced in place once its stamp moves", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-old");
    revs.set(src("assets/a.mp4"), "100-1");
    const before = clips.registerClip(src("assets/a.mp4"));
    await before.promise;

    shas.set(src("assets/a.mp4"), "sha-new");
    revs.set(src("assets/a.mp4"), "120-2");
    await clips.invalidateChangedClips();
    const after = clips.registerClip(src("assets/a.mp4"));
    expect(after).not.toBe(before);
    expect((await after.promise).cacheDir).toBe("/cache/sha-new");
  });

  it("skips entries still extracting", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-1");
    const inflight = clips.registerClip(src("assets/a.mp4"));
    const version = clips.clipRegistryVersion();
    await clips.invalidateChangedClips();
    expect(clips.clipRegistryVersion()).toBe(version);
    expect(clips.registerClip(src("assets/a.mp4"))).toBe(inflight);
    await inflight.promise;
  });
});

describe("evictAllClips", () => {
  it("drops every registered clip and notifies subscribers", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-a");
    shas.set(src("assets/b.mp4"), "sha-b");
    const a = clips.registerClip(src("assets/a.mp4"));
    const b = clips.registerClip(src("assets/b.mp4"));
    await Promise.all([a.promise, b.promise]);

    let notified = 0;
    const unsubscribe = clips.subscribeClipRegistry(() => notified++);
    clips.evictAllClips();
    unsubscribe();

    expect(notified).toBe(1);
    expect(clips.registerClip(src("assets/a.mp4"))).not.toBe(a);
    expect(clips.registerClip(src("assets/b.mp4"))).not.toBe(b);
  });

  it("is a no-op on an empty registry", async () => {
    const clips = await freshClips();
    const version = clips.clipRegistryVersion();
    clips.evictAllClips();
    expect(clips.clipRegistryVersion()).toBe(version);
  });
});

describe("pendingFrameReady", () => {
  function track(promise: Promise<void>) {
    const state = { done: false };
    void promise.then(() => {
      state.done = true;
    });
    return state;
  }

  function deferred() {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("waits for the extraction, then the first bind to complete", async () => {
    const clips = await import("./clips");
    const extraction = deferred();
    const firstBind = clips.createFirstBind(extraction.promise);
    const ready = track(clips.pendingFrameReady(firstBind, "assets/a.mp4"));

    extraction.resolve();
    await tick();
    expect(ready.done).toBe(false);

    firstBind.start();
    await tick();
    expect(ready.done).toBe(false);

    firstBind.settle();
    await tick();
    expect(ready.done).toBe(true);
  });

  it("is released by the consumer when the extraction fails", async () => {
    const clips = await import("./clips");
    const extraction = deferred();
    const firstBind = clips.createFirstBind(extraction.promise);
    const ready = track(clips.pendingFrameReady(firstBind, "assets/a.mp4"));
    extraction.reject(new Error("no"));
    await tick();
    firstBind.settle();
    await tick();
    expect(ready.done).toBe(true);
  });

  it("is released at once when the consumer unmounts mid-extraction", async () => {
    const clips = await import("./clips");
    const firstBind = clips.createFirstBind(deferred().promise);
    const ready = track(clips.pendingFrameReady(firstBind, "assets/a.mp4"));
    firstBind.settle();
    await tick();
    expect(ready.done).toBe(true);
  });

  it("follows a consumer that moved on to a newer extraction", async () => {
    const clips = await import("./clips");
    const first = deferred();
    const firstBind = clips.createFirstBind(first.promise);
    const waiting = clips.pendingFrameReady(firstBind, "assets/a.mp4", 20);
    const ready = track(waiting);
    first.resolve();
    await Promise.resolve();
    const next = deferred();
    firstBind.extraction = next.promise;
    await new Promise((r) => setTimeout(r, 40));
    expect(ready.done).toBe(false);
    next.resolve();
    firstBind.settle();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("fails the run when the first bind never starts", async () => {
    const clips = await import("./clips");
    const firstBind = clips.createFirstBind(Promise.resolve());
    await expect(clips.pendingFrameReady(firstBind, "assets/a.mp4", 10)).rejects.toThrow(
      /assets\/a\.mp4.*never bound/,
    );
  });
});

describe("prepareExportClips", () => {
  const SRC = src("assets/rec.mp4");
  // Frames 0..150 of a 600-frame clip: a scene-length window from frame 0 touches chunks 0 and 1.
  const fromStart = {
    window: [-500, 2000] as const,
    frameAt: (ms: number, info: { fps: number; frameCount: number }) =>
      Math.min(info.frameCount - 1, Math.max(0, Math.floor((ms / 1000) * info.fps))),
  };

  it("extracts only the chunks a declared slot shows", async () => {
    const clips = await freshClips();
    shas.set(SRC, "sha-rec");
    frameCounts.set(SRC, 600);
    await clips.prepareExportClips(new Map([[SRC, [fromStart]]]), { consumers: false });
    expect(chunksRequested(SRC)).toEqual([0, 1]);
  });

  it("adds every mounted consumer's window and held frame on the consumer pass", async () => {
    const clips = await freshClips();
    shas.set(SRC, "sha-rec");
    frameCounts.set(SRC, 600);
    const entry = clips.registerClip(SRC);
    await entry.promise;
    clips.publishClipConsumer(entry, {}, () => ({
      window: [-500, 1500],
      frameAt: (ms) => 300 + Math.max(0, Math.floor((ms / 1000) * 60)),
      heldFrame: 590,
    }));
    await clips.prepareExportClips(new Map(), { consumers: true });
    expect(chunksRequested(SRC)).toEqual([2, 3, 4]);
  });

  it("extracts only the instant's chunk for a one-frame capture", async () => {
    const clips = await freshClips();
    shas.set(SRC, "sha-rec");
    frameCounts.set(SRC, 600);
    const entry = clips.registerClip(SRC);
    await entry.promise;
    // A later scene starting at 10 s, held off the playhead at frame 0.
    clips.publishClipConsumer(entry, {}, () => ({
      ...fromStart,
      sceneStartMs: 10_000,
      heldFrame: 0,
    }));
    const declared = new Map([[SRC, [{ ...fromStart, sceneStartMs: 0 }]]]);
    await clips.prepareExportClips(declared, { consumers: true, atMs: 1500 });
    expect(chunksRequested(SRC)).toEqual([0]);
    await clips.prepareExportClips(declared, { consumers: true, atMs: 12_000 });
    // 2 s into the later scene is frame 120; the first scene is past its window.
    expect(chunksRequested(SRC)).toEqual([0, 1]);
  });

  it("takes the whole clip for a declared source nobody can time", async () => {
    const clips = await freshClips();
    shas.set(SRC, "sha-rec");
    frameCounts.set(SRC, 600);
    const declared = new Map([[SRC, []]]);
    await clips.prepareExportClips(declared, { consumers: false });
    expect(chunksRequested(SRC)).toEqual([]);
    await clips.prepareExportClips(declared, { consumers: true });
    expect(chunksRequested(SRC)).toEqual([0, 1, 2, 3, 4]);
  });

  it("extracts nothing for a known clip no consumer or slot needs", async () => {
    const clips = await freshClips();
    shas.set(SRC, "sha-rec");
    frameCounts.set(SRC, 600);
    await clips.registerClip(SRC).promise;
    await clips.prepareExportClips(new Map(), { consumers: true });
    expect(ensureCalls).toEqual([]);
  });

  it("fails loudly when a chunk cannot be extracted", async () => {
    const clips = await freshClips();
    shas.set(SRC, "sha-rec");
    frameCounts.set(SRC, 600);
    failChunks = true;
    await expect(
      clips.prepareExportClips(new Map([[SRC, [fromStart]]]), { consumers: false }),
    ).rejects.toBeInstanceOf(clips.ClipChunkError);
  });

  it("degrades an unreadable source as before instead of failing the run", async () => {
    const clips = await freshClips();
    await expect(
      clips.prepareExportClips(new Map([[SRC, [fromStart]]]), { consumers: true }),
    ).resolves.toBeUndefined();
    expect(clips.registerClip(SRC).error).toBeTruthy();
  });

  it("pins what a running export holds and lets go when it ends", async () => {
    const clips = await freshClips();
    const exportState = await import("./exportState");
    shas.set(SRC, "sha-rec");
    frameCounts.set(SRC, 600);
    exportState.setExporting(true);
    await clips.prepareExportClips(new Map([[SRC, [fromStart]]]), { consumers: false });
    await flush();
    expect(pinCalls.at(-1)).toEqual(["/cache/sha-rec"]);
    exportState.setExporting(false);
    await flush();
    expect(pinCalls.at(-1)).toEqual([]);
  });
});

describe("clip consumers", () => {
  it("pin their entry while mounted", async () => {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-a");
    const entry = clips.registerClip(src("assets/a.mp4"));
    await entry.promise;
    const unpublish = clips.publishClipConsumer(entry, {}, () => ({
      window: null,
      frameAt: () => 0,
    }));
    await flush();
    expect(pinCalls.at(-1)).toEqual(["/cache/sha-a"]);
    unpublish();
    await flush();
    expect(pinCalls.at(-1)).toEqual([]);
  });
});

describe("ClipFrames chunks", () => {
  beforeAll(() => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 8, height: 8, close() {} }));
  });

  async function readyEntry(frameCount = 600) {
    const clips = await freshClips();
    shas.set(src("assets/a.mp4"), "sha-a");
    frameCounts.set(src("assets/a.mp4"), frameCount);
    const entry = clips.registerClip(src("assets/a.mp4"));
    await entry.promise;
    if (!entry.frames) throw new Error("no frames");
    return { clips, entry, frames: entry.frames };
  }

  it("extracts a frame's chunk once however many frames ask for it", async () => {
    const { frames } = await readyEntry();
    frames.request({}, 130);
    const a = frames.get(130);
    frames.request({}, 131);
    const b = frames.get(131);
    await Promise.all([a, b]);
    expect(ensureCalls).toEqual([{ srcAbs: src("assets/a.mp4"), chunks: [1] }]);
    expect(frames.hasFrame(239)).toBe(true);
    expect(frames.hasFrame(240)).toBe(false);
  });

  it("skips the decode of a frame its consumer moved past while the chunk extracted", async () => {
    const { clips, frames } = await readyEntry();
    const owner = {};
    frames.request(owner, 10);
    const stale = frames.get(10);
    frames.request(owner, 250);
    const fresh = frames.get(250);
    await expect(stale).rejects.toBeInstanceOf(clips.ClipLoadSuperseded);
    await expect(fresh).resolves.toBeTruthy();
  });

  it("reads a whole entry's frames without extracting", async () => {
    const { ClipFrames } = await freshClips();
    const frames = new ClipFrames({
      cacheDir: "/cache/whole",
      frameCount: 300,
      width: 8,
      height: 8,
      fps: 60,
    });
    frames.request({}, 299);
    await frames.get(299);
    expect(ensureCalls).toEqual([]);
  });

  it("stops asking for a chunk that failed twice", async () => {
    const { clips, frames } = await readyEntry();
    failChunks = true;
    await expect(frames.ensureChunks([0])).rejects.toBeInstanceOf(clips.ClipChunkError);
    await expect(frames.ensureChunks([0])).rejects.toBeInstanceOf(clips.ClipChunkError);
    failChunks = false;
    await expect(frames.ensureChunks([0])).rejects.toBeInstanceOf(clips.ClipChunkError);
    expect(ensureCalls).toEqual([]);
    await frames.ensureChunks([1]);
    expect(ensureCalls).toEqual([{ srcAbs: src("assets/a.mp4"), chunks: [1] }]);
  });

  it("maps frame indices to their chunks for ensureFrames", async () => {
    const { clips, entry } = await readyEntry(250);
    await clips.ensureFrames(entry, [0, 119, 120, 999]);
    expect(chunksRequested(src("assets/a.mp4"))).toEqual([0, 1, 2]);
  });
});

describe("pending conforms", () => {
  const SRC = src("assets/rec.mp4", "ws:demo");
  const job = { slug: "demo", rel: "assets/rec.mp4", frame: 30, total: 120 };

  it("hold a clip with no extraction until its conform lands", async () => {
    const clips = await freshClips();
    conformJobs.set(SRC, job);
    const entry = clips.registerClip(SRC);
    await flush();
    await flush();
    expect(clips.clipPendingState(SRC)).toMatchObject({ rel: "assets/rec.mp4", progress: 0.25 });
    expect(infoCalls).toEqual([]);
    expect(entry.error).toBeUndefined();

    eventHandlers.get("kookaburra://conform-progress")?.({
      payload: { ...job, stage: "conforming", frame: 60, error: null },
    });
    expect(clips.clipPendingState(SRC)?.progress).toBe(0.5);

    shas.set(SRC, "sha-mezz");
    revs.set(SRC, "10-1");
    conformJobs.delete(SRC);
    eventHandlers.get("kookaburra://media-changed")?.({
      payload: { slug: "demo", paths: ["assets/rec.mp4"], origin: "conform" },
    });
    expect((await entry.promise).cacheDir).toBe("/cache/sha-mezz");
    expect(clips.clipPendingState(SRC)).toBeNull();
  });

  it("fail the clip, and an export of it, when the conform fails", async () => {
    const clips = await freshClips();
    conformJobs.set(SRC, job);
    const entry = clips.registerClip(SRC);
    const run = clips.prepareExportClips(new Map([[SRC, []]]), { consumers: false });
    await flush();
    await flush();
    eventHandlers.get("kookaburra://conform-progress")?.({
      payload: { ...job, stage: "failed", error: "refused" },
    });
    await expect(entry.promise).rejects.toBeInstanceOf(clips.ClipConformError);
    await expect(run).rejects.toThrow(/Conforming "assets\/rec\.mp4" failed: refused/);
  });

  it("fail an export with a clear message past the bounded wait", async () => {
    const clips = await freshClips();
    conformJobs.set(SRC, job);
    const lines: string[] = [];
    await expect(
      clips.prepareExportClips(new Map([[SRC, []]]), {
        consumers: false,
        conformWaitMs: 50,
        onStatus: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/"rec\.mp4" is still conforming/);
    expect(lines.some((line) => line.includes('waiting for "rec.mp4" to finish conforming'))).toBe(
      true,
    );
  });

  it("leave a missing file nobody is conforming to fail as before", async () => {
    const clips = await freshClips();
    const entry = clips.registerClip(SRC);
    await expect(entry.promise).rejects.toThrow(/unreadable/);
    expect(clips.clipPendingState(SRC)).toBeNull();
  });
});
