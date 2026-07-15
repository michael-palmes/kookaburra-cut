import { beforeEach, describe, expect, it, vi } from "vitest";

// The pipeline's two native commands, scripted per test: hash_file serves the current sha per path (throws when absent, a deleted file), extract_clip_frames stubs a sequence keyed by that sha.
const shas = new Map<string, string>();
let failExtract = false;

vi.mock("@tauri-apps/api/core", () => ({
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
