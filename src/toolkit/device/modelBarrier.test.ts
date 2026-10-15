import { describe, expect, it, vi } from "vitest";

const loader = vi.hoisted(() => ({ loadAsync: vi.fn(async (_url: string) => ({})) }));
vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    loadAsync = loader.loadAsync;
  },
}));
vi.mock("@react-three/drei", () => ({
  useGLTF: Object.assign(() => ({ scene: null }), { preload: vi.fn() }),
}));

import { useGLTF } from "@react-three/drei";
import { HERO_MODELS, preloadHeroModels } from "../hero/models";
import { modelBarrierOnce } from "./modelBarrier";
import { DEVICE_MODELS, preloadDeviceModels } from "./models";

describe("modelBarrierOnce", () => {
  it("runs a key's load once and hands later barriers the settled promise", async () => {
    const load = vi.fn(async () => {});
    await modelBarrierOnce("once", load);
    await modelBarrierOnce("once", load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("evicts a failed load so the next barrier retries", async () => {
    const load = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("decode failed"))
      .mockResolvedValueOnce();
    await expect(modelBarrierOnce("retry", load)).rejects.toThrow("decode failed");
    await modelBarrierOnce("retry", load);
    await modelBarrierOnce("retry", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("model preloads", () => {
  it("parse each glb once across preambles while still warming drei every time", async () => {
    await preloadDeviceModels();
    await preloadHeroModels();
    await preloadDeviceModels();
    const device = Object.values(DEVICE_MODELS);
    const hero = Object.values(HERO_MODELS);
    expect(loader.loadAsync).toHaveBeenCalledTimes(new Set([...device, ...hero]).size);
    expect(useGLTF.preload).toHaveBeenCalledTimes(device.length * 2 + hero.length);
  });
});
