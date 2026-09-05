import { useTexture } from "@react-three/drei";
import { invoke } from "@tauri-apps/api/core";
import { Texture, TextureLoader } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preloadProjectImages,
  refreshBundledProjectAssets,
  rememberWorkspaceLibraryPath,
  resolveAssetUrl,
  resolveProjectHdrUrl,
} from "./project";
import { setProjectAssetRevision, withProjectAssetRevision } from "./projectAssetRevision";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("poster source asset revisions", () => {
  it("refreshes new and deleted bundled asset entries independently of HMR", async () => {
    const id = "preset:inventory-test";
    let images = ["assets/kooka-icon-sample.png", "assets/new.png"];
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "list_project_environments" ? ["assets/studio.hdr"] : images,
    );
    await refreshBundledProjectAssets(id);
    expect(resolveAssetUrl(id, "assets/new.png")).toBe("/presets/inventory-test/assets/new.png");
    expect(resolveAssetUrl(id, "assets/kooka-icon-sample.png")).toBe(
      "/presets/inventory-test/assets/kooka-icon-sample.png",
    );
    expect(resolveProjectHdrUrl(id, "assets/studio.hdr")).toBe(
      "/presets/inventory-test/assets/studio.hdr",
    );
    images = [];
    await refreshBundledProjectAssets(id);
    expect(() => resolveAssetUrl(id, "assets/new.png")).toThrow("not found");
    expect(resolveAssetUrl(id, "assets/kooka-icon-sample.png")).toContain("/projects/_samples/");
  });
  it("leaves ordinary editor and export asset URLs unchanged", () => {
    expect(
      withProjectAssetRevision("ws:ordinary", "asset:///workspace/ordinary/assets/photo.png"),
    ).toBe("asset:///workspace/ordinary/assets/photo.png");
  });

  it("refreshes direct image consumers and preload URLs together after an in-place replacement", async () => {
    const id = "ws-preset:asset-test";
    rememberWorkspaceLibraryPath(id, "/workspace/presets/asset-test");
    vi.mocked(invoke).mockResolvedValue(["assets/screen.png"]);
    const preload = vi.spyOn(useTexture, "preload").mockImplementation(() => {});
    vi.spyOn(TextureLoader.prototype, "loadAsync").mockResolvedValue(new Texture());
    setProjectAssetRevision(id, "before");
    const before = resolveAssetUrl(id, "assets/screen.png");
    await preloadProjectImages(id);
    expect(preload).toHaveBeenLastCalledWith(before);
    setProjectAssetRevision(id, "replacement");
    const after = resolveAssetUrl(id, "assets/screen.png");
    await preloadProjectImages(id);
    expect(after).not.toBe(before);
    expect(after).toContain("poster=replacement");
    expect(preload).toHaveBeenLastCalledWith(after);
  });

  it("makes a revised development LUT fetchable at its original same-origin path", () => {
    vi.stubGlobal("location", { href: "http://localhost:1420/render.html" });
    setProjectAssetRevision("preset:colour", "new-cube");
    expect(withProjectAssetRevision("preset:colour", "/presets/colour/assets/grade.cube")).toBe(
      "http://localhost:1420/presets/colour/assets/grade.cube?poster=new-cube",
    );
  });
});
