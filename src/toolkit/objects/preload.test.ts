import { beforeEach, describe, expect, it, vi } from "vitest";

const loadAsync = vi.fn(async (url: string) => ({ scene: url }));
vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    loadAsync = loadAsync;
  },
}));
const warmObjectAsset = vi.fn();
vi.mock("./registry", () => ({ warmObjectAsset }));

const { loadUsedObject, peekUsedObject, settleUsedObjects } = await import("./preload");

describe("TSX-placed objects", () => {
  beforeEach(() => {
    loadAsync.mockClear();
    warmObjectAsset.mockReset();
  });

  it("is pending until both the asset and its glb have landed, and loads once", async () => {
    warmObjectAsset.mockResolvedValue({ manifest: {}, glbUrl: "one.glb" });
    expect(peekUsedObject("one")).toBeUndefined();
    const first = loadUsedObject("one");
    expect(loadUsedObject("one")).toBe(first);
    expect(peekUsedObject("one")).toBeUndefined();
    await first;
    expect(peekUsedObject("one")).toMatchObject({ glbUrl: "one.glb" });
    expect(loadAsync).toHaveBeenCalledTimes(1);
  });

  it("degrades an unknown id to nothing rendered, without a pending state left behind", async () => {
    warmObjectAsset.mockResolvedValue(undefined);
    await loadUsedObject("nope");
    expect(peekUsedObject("nope")).toBeNull();
    expect(loadAsync).not.toHaveBeenCalled();
  });

  it("degrades a glb that fails to load, so a capture never waits forever", async () => {
    warmObjectAsset.mockResolvedValue({ manifest: {}, glbUrl: "bad.glb" });
    loadAsync.mockRejectedValueOnce(new Error("corrupt"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadUsedObject("bad");
    warn.mockRestore();
    expect(peekUsedObject("bad")).toBeNull();
  });

  it("settles only once every load in flight has finished, including one queued meanwhile", async () => {
    let release: (a: unknown) => void = () => {};
    warmObjectAsset.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    let settled = false;
    void loadUsedObject("slow");
    const barrier = settleUsedObjects().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ manifest: {}, glbUrl: "slow.glb" });
    await barrier;
    expect(peekUsedObject("slow")).toMatchObject({ glbUrl: "slow.glb" });
  });
});
