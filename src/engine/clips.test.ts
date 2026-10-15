import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The pipeline's two native commands, scripted per test: hash_file serves the current sha per path (throws when absent, a deleted file), extract_clip_frames stubs a sequence keyed by that sha.
const shas = new Map<string, string>();
let failExtract = false;

vi.mock("@tauri-apps/api/core", () => ({
  // Channel stands in for the ipc progress channel; tests never feed it messages.
  Channel: class {
    onmessage?: (msg: unknown) => void;
  },
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "hash_file") {
      const sha = shas.get(args?.path as string);
      if (!sha) throw new Error("unreadable");
      return sha;
    }
    if (cmd === "extract_clip_frames") {
      if (failExtract) throw new Error("extraction failed");
      return { cacheDir: `/cache/${args?.sha}`, frameCount: 10, width: 64, height: 64, fps: 60 };
    }
    throw new Error(`unexpected command ${cmd}`);
  }),
}));

// Fresh module state per test: the registry and its version counter are module-level.
async function freshClips() {
  vi.resetModules();
  return await import("./clips");
}

// Transform the module graph once outside the 5 s test timeout, which a cold transform under load can exceed.
beforeAll(async () => {
  await import("./clips");
}, 30_000);

beforeEach(() => {
  shas.clear();
  failExtract = false;
});

describe("invalidateChangedClips", () => {
  it("evicts a clip whose file changed on disk so it re-extracts", async () => {
    const clips = await freshClips();
    shas.set("/p/assets/a.mp4", "sha-old");
    const before = clips.registerClip("/p/assets/a.mp4");
    const oldInfo = await before.promise;
    expect(oldInfo.cacheDir).toBe("/cache/sha-old");

    shas.set("/p/assets/a.mp4", "sha-new");
    const version = clips.clipRegistryVersion();
    await clips.invalidateChangedClips();
    expect(clips.clipRegistryVersion()).toBe(version + 1);

    const after = clips.registerClip("/p/assets/a.mp4");
    expect(after).not.toBe(before);
    expect((await after.promise).cacheDir).toBe("/cache/sha-new");
  });

  it("keeps a clip whose file is unchanged", async () => {
    const clips = await freshClips();
    shas.set("/p/assets/a.mp4", "sha-1");
    const before = clips.registerClip("/p/assets/a.mp4");
    await before.promise;

    const version = clips.clipRegistryVersion();
    await clips.invalidateChangedClips();
    expect(clips.clipRegistryVersion()).toBe(version);
    expect(clips.registerClip("/p/assets/a.mp4")).toBe(before);
  });

  it("evicts a failed extraction so the next registration retries", async () => {
    const clips = await freshClips();
    shas.set("/p/assets/a.mp4", "sha-1");
    failExtract = true;
    const broken = clips.registerClip("/p/assets/a.mp4");
    await broken.promise.catch(() => {});
    expect(broken.error).toBeTruthy();

    failExtract = false;
    await clips.invalidateChangedClips();
    const retried = clips.registerClip("/p/assets/a.mp4");
    expect(retried).not.toBe(broken);
    expect((await retried.promise).cacheDir).toBe("/cache/sha-1");
  });

  it("evicts a clip whose file became unreadable", async () => {
    const clips = await freshClips();
    shas.set("/p/assets/a.mp4", "sha-1");
    const before = clips.registerClip("/p/assets/a.mp4");
    await before.promise;

    shas.delete("/p/assets/a.mp4");
    await clips.invalidateChangedClips();
    expect(clips.registerClip("/p/assets/a.mp4")).not.toBe(before);
  });

  it("skips entries still extracting", async () => {
    const clips = await freshClips();
    shas.set("/p/assets/a.mp4", "sha-1");
    const inflight = clips.registerClip("/p/assets/a.mp4");
    const version = clips.clipRegistryVersion();
    await clips.invalidateChangedClips();
    expect(clips.clipRegistryVersion()).toBe(version);
    expect(clips.registerClip("/p/assets/a.mp4")).toBe(inflight);
    await inflight.promise;
  });
});

describe("evictAllClips", () => {
  it("drops every registered clip and notifies subscribers", async () => {
    const clips = await freshClips();
    shas.set("/p/assets/a.mp4", "sha-a");
    shas.set("/p/assets/b.mp4", "sha-b");
    const a = clips.registerClip("/p/assets/a.mp4");
    const b = clips.registerClip("/p/assets/b.mp4");
    await Promise.all([a.promise, b.promise]);

    let notified = 0;
    const unsubscribe = clips.subscribeClipRegistry(() => notified++);
    clips.evictAllClips();
    unsubscribe();

    expect(notified).toBe(1);
    expect(clips.registerClip("/p/assets/a.mp4")).not.toBe(a);
    expect(clips.registerClip("/p/assets/b.mp4")).not.toBe(b);
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
