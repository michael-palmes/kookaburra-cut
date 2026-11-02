import { afterEach, describe, expect, it, vi } from "vitest";
import { assetAllowed, revokeReach } from "./realmGuard";
import { createWorkerNativePort } from "./workerNativePort";

const asset = (path: string) => new URL(`asset://localhost/${encodeURIComponent(path)}`);

describe("readObject", () => {
  afterEach(() => {
    revokeReach("object:cube");
    vi.restoreAllMocks();
  });

  it("grants the worker the object's glb and thumbnail, and nothing beside them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const glb = asset("/w/objects/cube/cube.glb");
    const thumb = asset("/w/objects/cube/thumb.png");
    expect(assetAllowed(glb)).toBe(false);
    const read = { json: "{}", glbUrl: glb.href, thumbnailUrl: thumb.href };
    const port = createWorkerNativePort(async () => read);
    await expect(port.readObject("cube")).resolves.toEqual(read);
    expect(assetAllowed(glb)).toBe(true);
    expect(assetAllowed(thumb)).toBe(true);
    expect(assetAllowed(asset("/w/objects/cube/other.glb"))).toBe(false);
  });
});
