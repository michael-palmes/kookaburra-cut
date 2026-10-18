import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneDoc } from "./sceneDocSchema";

/** The load path for authored music: a fake workspace whose soundtrack never probes, so `music` must come from the manifest alone. */
const docs = new Map<string, SceneDoc | undefined>();
let manifest: Record<string, unknown> = {};
const commands: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(async (command: string) => {
    commands.push(command);
    switch (command) {
      case "get_settings":
        return { workspaceRoot: "/ws" };
      case "list_projects":
        return [{ slug: "demo", name: "Demo", path: "/ws/demo" }];
      case "read_project_manifest":
        return JSON.stringify(manifest);
      case "read_scene_source":
        return `export default { id: "s", durationMs: 1000, Scene: function Scene() { return null; } };`;
      case "list_project_environments":
        return [];
      case "probe_audio":
        throw new Error("no such file");
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
vi.mock("./sceneDoc", () => ({
  loadSceneDoc: vi.fn(async (_id: string, file: string) => docs.get(file)),
}));
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

const { bumpWorkspaceReloadToken, loadProject } = await import("./project");

const pose = { target: [0, 0, 0], azimuthDeg: 0, elevationDeg: 10, distance: 6 } as const;
const cameraDoc = (keys: { id: string; tMs: number; at?: string }[]): SceneDoc => ({
  version: 1,
  camera: { keys: keys.map((k) => ({ ...k, pose: { ...pose, target: [0, 0, 0] } })), segments: [] },
});

function setProject(audio: unknown, sceneDocs: (SceneDoc | undefined)[]) {
  docs.clear();
  sceneDocs.forEach((doc, i) => {
    docs.set(`scenes/0${i + 1}.tsx`, doc);
  });
  manifest = {
    id: "demo",
    name: "Demo",
    version: 2,
    themeId: "kookaburra-default",
    formats: ["16:9"],
    scenes: sceneDocs.map((_, i) => ({ file: `scenes/0${i + 1}.tsx`, durationMs: 4000 })),
    ...(audio === undefined ? {} : { audio }),
  };
}

beforeEach(() => {
  bumpWorkspaceReloadToken();
  commands.length = 0;
});

describe("loadProject music", () => {
  it("builds music from the manifest even when the soundtrack can't probe", async () => {
    setProject(
      {
        file: "assets/missing.mp3",
        startOffsetMs: 500,
        grid: { bpm: 120, offsetMs: 250, beatsPerBar: 4 },
        cues: { drop: "bar:3" },
      },
      [cameraDoc([{ id: "k1", tMs: 0 }])],
    );
    const project = await loadProject("ws:demo");
    expect(commands).toContain("probe_audio");
    expect(project.audio).toBeUndefined();
    expect(project.music).toEqual({
      grid: { bpm: 120, offsetMs: 250, beatsPerBar: 4 },
      startOffsetMs: 500,
      cues: { drop: "bar:3" },
      sections: {},
    });
  });

  it("resolves sidecar at positions against each scene's slot before anything reads them", async () => {
    // bar 3 is track 4250, project 3750: scene 1 sees 3750, scene 2 (starting at 4000) sees -250.
    setProject(
      { file: "assets/missing.mp3", startOffsetMs: 500, grid: { bpm: 120, offsetMs: 250 } },
      [
        cameraDoc([{ id: "k1", tMs: 0, at: "bar:3" }]),
        cameraDoc([{ id: "k1", tMs: -250, at: "bar:3" }]),
      ],
    );
    const project = await loadProject("ws:demo");
    expect(project.sceneDocs[0]?.camera?.keys[0]).toMatchObject({ tMs: 3750, at: "bar:3" });
    expect(project.sceneDocs[1]).toBe(docs.get("scenes/02.tsx"));
    expect(project.musicCacheRewrites).toEqual([0]);
    expect(project.loadWarnings).toEqual([]);
  });

  it("is null-for-legacy: no audio block means no music and the very same documents", async () => {
    const plain = cameraDoc([{ id: "k1", tMs: 1200 }]);
    setProject(undefined, [plain, undefined]);
    const project = await loadProject("ws:demo");
    expect(project.music).toBeUndefined();
    expect(project.musicCacheRewrites).toBeUndefined();
    expect(project.sceneDocs[0]).toBe(plain);
    expect(project.sceneDocs[1]).toBeUndefined();
  });

  it("keeps stored times and warns once when a position has nothing to resolve against", async () => {
    setProject({ file: "assets/missing.mp3" }, [cameraDoc([{ id: "k1", tMs: 900, at: "bar:3" }])]);
    const project = await loadProject("ws:demo");
    expect(project.music).toBeUndefined();
    expect(project.sceneDocs[0]?.camera?.keys[0]).toMatchObject({ tMs: 900, at: "bar:3" });
    expect(project.loadWarnings).toHaveLength(1);
    expect(project.loadWarnings?.[0]).toContain("couldn't resolve");
  });
});
