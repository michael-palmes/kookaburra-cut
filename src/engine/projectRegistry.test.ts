import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the mocked native side answers; each test sets its own listing. */
let listing: (() => unknown) | null = null;
let instance: (() => unknown) | null = null;
const calls: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(async (command: string) => {
    calls.push(command);
    switch (command) {
      case "list_projects":
        return listing?.();
      case "bridge_instance":
        return instance?.();
      case "read_project_manifest":
        return JSON.stringify({
          id: "demo",
          name: "Demo",
          version: 2,
          themeId: "kookaburra-default",
          formats: ["16:9"],
          scenes: [{ file: "scenes/01-a.tsx", durationMs: 1000 }],
        });
      case "read_scene_source":
        return `export default { id: "a", durationMs: 1000, Scene: function Scene() { return null; } };`;
      case "list_project_environments":
        return [];
      default:
        throw new Error(`unexpected invoke ${command}`);
    }
  }),
}));

vi.mock("./sceneCompiler", () => ({
  compileSceneModule: vi.fn(
    async (source: string) => `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`,
  ),
}));
vi.mock("./projectTrust", () => ({ ensureProjectTrusted: vi.fn(async () => {}) }));
vi.mock("./sceneIds", () => ({ ensureUniqueSceneIds: vi.fn(async () => null) }));
vi.mock("./sampleAssets", () => ({ ensureSampleAssets: vi.fn(async () => {}) }));
vi.mock("./assetInventory", () => ({
  refreshWorkspaceAssets: vi.fn(async () => {}),
  workspaceAssetMissing: () => false,
}));
vi.mock("./sceneDoc", () => ({ loadSceneDoc: vi.fn(async () => undefined) }));
vi.mock("./systemFonts", () => ({ ensureFontRefsPinned: vi.fn(async () => {}) }));
vi.mock("../theme/fontSafety", () => ({ vetProjectFonts: vi.fn(async () => []) }));
vi.mock("../toolkit/text/emojiRaster", () => ({ preloadEmojiRasters: vi.fn(async () => {}) }));
vi.mock("../theme/fonts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../theme/fonts")>()),
  preloadAppFonts: vi.fn(async () => {}),
}));
vi.mock("./effects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./effects")>()),
  preloadEffectLuts: vi.fn(async () => {}),
}));

const { bumpWorkspaceReloadToken, listAllProjects, loadProject } = await import("./project");

const project = (slug: string) => ({ slug, name: slug, path: `/Users/x/Kookaburra Cut/${slug}` });
const acceptance = {
  pid: 4242,
  bundleId: "com.mpalmes.kookaburracut.acceptance.x1",
  build: "dev",
  workspaceRoot: "/Users/x/throwaway",
};

beforeEach(() => {
  calls.length = 0;
  instance = () => acceptance;
  bumpWorkspaceReloadToken();
});

describe("the workspace project registry", () => {
  it("lists through list_projects alone and never asks who it is on the happy path", async () => {
    listing = () => [project("demo")];
    const loaded = await loadProject("ws:demo");
    expect(loaded.scenes.map((s) => s.id)).toEqual(["a"]);
    expect(calls).not.toContain("get_settings");
    expect(calls).not.toContain("bridge_instance");
    expect(calls.filter((c) => c === "list_projects")).toHaveLength(1);
  });

  it("names the root, the instance and what it listed when a project is missing", async () => {
    listing = () => [project("demo"), project("product-tour")];
    await expect(loadProject("ws:missing")).rejects.toThrow(
      'Workspace project "missing" not found in /Users/x/throwaway (Kookaburra Cut pid 4242, com.mpalmes.kookaburracut.acceptance.x1, dev; 2 projects listed: demo, product-tour)',
    );
    expect(calls).toContain("bridge_instance");
  });

  it("caps the listed names at eight", async () => {
    listing = () => Array.from({ length: 11 }, (_, i) => project(`p${i}`));
    await expect(loadProject("ws:missing")).rejects.toThrow(
      "11 projects listed: p0, p1, p2, p3, p4, p5, p6, p7, +3 more)",
    );
  });

  it("says so when the workspace is empty or the instance can't describe itself", async () => {
    listing = () => [];
    instance = () => {
      throw new Error("the bridge has not started yet");
    };
    await expect(loadProject("ws:missing")).rejects.toThrow(
      'Workspace project "missing" not found in an unconfigured workspace (Kookaburra Cut; 0 projects listed)',
    );
  });

  it("throws a listing failure with the instance but keeps the picker resilient", async () => {
    listing = () => {
      throw "no workspace configured: complete first-run setup";
    };
    await expect(loadProject("ws:elsewhere")).rejects.toThrow(
      "Couldn't list workspace projects (Kookaburra Cut pid 4242, com.mpalmes.kookaburracut.acceptance.x1, dev): no workspace configured: complete first-run setup",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listed = await listAllProjects();
    expect(listed.every((p) => p.source === "bundled")).toBe(true);
    expect(warn).toHaveBeenCalledWith("[workspace]", expect.stringContaining("Couldn't list"));
    warn.mockRestore();
  });
});
