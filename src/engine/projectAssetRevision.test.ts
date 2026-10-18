import { useTexture } from "@react-three/drei";
import { invoke } from "@tauri-apps/api/core";
import { Texture, TextureLoader } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshWorkspaceAssets } from "./assetRevisions";
import {
  assetFileUrl,
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

  it("folds the file revision in after the poster query, and preloads the URL consumers request", async () => {
    const id = "ws-preset:revision-test";
    rememberWorkspaceLibraryPath(id, "/workspace/presets/revision-test");
    let size = 10;
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "list_project_asset_stamps"
        ? { stamp: `s${size}`, assets: [{ rel: "assets/screen.png", size, mtimeNs: "99" }] }
        : ["assets/screen.png"],
    );
    const preload = vi.spyOn(useTexture, "preload").mockImplementation(() => {});
    const clear = vi.spyOn(useTexture, "clear").mockImplementation(() => {});
    vi.spyOn(TextureLoader.prototype, "loadAsync").mockResolvedValue(new Texture());
    await refreshWorkspaceAssets(id);
    const base = "asset:///workspace/presets/revision-test/assets/screen.png";
    expect(resolveAssetUrl(id, "assets/screen.png")).toBe(`${base}?r=10-99`);
    expect(assetFileUrl(id, "assets/screen.png")).toBe(`${base}?r=10-99`);
    setProjectAssetRevision(id, "p1");
    expect(resolveAssetUrl(id, "assets/screen.png")).toBe(`${base}?poster=p1&r=10-99`);
    await preloadProjectImages(id);
    expect(preload).toHaveBeenLastCalledWith(`${base}?poster=p1&r=10-99`);

    size = 11;
    await refreshWorkspaceAssets(id);
    expect(resolveAssetUrl(id, "assets/screen.png")).toBe(`${base}?poster=p1&r=11-99`);
    expect(clear).toHaveBeenCalledWith([`${base}?poster=p1&r=10-99`]);
  });

  it("makes a revised development LUT fetchable at its original same-origin path", () => {
    vi.stubGlobal("location", { href: "http://localhost:1420/render.html" });
    setProjectAssetRevision("preset:colour", "new-cube");
    expect(withProjectAssetRevision("preset:colour", "/presets/colour/assets/grade.cube")).toBe(
      "http://localhost:1420/presets/colour/assets/grade.cube?poster=new-cube",
    );
  });
});
