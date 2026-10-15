import { beforeEach, describe, expect, it, vi } from "vitest";

/** Scene sources by file; the mocked compiler turns each into an importable data: module. */
const sources = new Map<string, string>();
let manifest: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(async (command: string, args?: { file?: string }) => {
    switch (command) {
      case "get_settings":
        return { workspaceRoot: "/ws" };
      case "list_projects":
        return [{ slug: "demo", name: "Demo", path: "/ws/demo" }];
      case "read_project_manifest":
        return JSON.stringify(manifest);
      case "read_scene_source": {
        const source = sources.get(args?.file ?? "");
        if (source === undefined) throw `no such file: ${args?.file}`;
        return source;
      }
      case "list_project_environments":
        return [];
      default:
        throw new Error(`unexpected invoke ${command}`);
    }
  }),
}));

vi.mock("./sceneCompiler", () => ({
  compileSceneModule: vi.fn(async (source: string, file: string) => {
    if (source.includes("SYNTAX ERROR")) {
      throw new Error(
        `Scene "${file}" failed to compile:\n  line 2: Expected ";" but found "ERROR"`,
      );
    }
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  }),
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

const { bumpWorkspaceReloadToken, loadProject } = await import("./project");
const { isSceneErrorCard } = await import("./SceneErrorCard");
const { reportRenderError, projectRenderErrors } = await import("./loadDiagnostics");
const { sceneErrorRefusal } = await import("./sceneErrors");
const { preloadEffectLuts } = await import("./effects");
const { vetProjectFonts } = await import("../theme/fontSafety");

const healthy = (id: string) =>
  `export default { id: "${id}", durationMs: 1000, Scene: function Scene() { return null; } };`;

function setProject(
  scenes: Record<string, string | undefined>,
  extra: Record<string, unknown> = {},
) {
  sources.clear();
  for (const [file, source] of Object.entries(scenes)) {
    if (source !== undefined) sources.set(file, source);
  }
  manifest = {
    id: "demo",
    name: "Demo",
    version: 2,
    themeId: "kookaburra-default",
    formats: ["16:9"],
    scenes: Object.keys(scenes).map((file, i) => ({ file, durationMs: 1000 + i * 500 })),
    ...extra,
  };
}

beforeEach(() => {
  bumpWorkspaceReloadToken();
});

describe("loadProject scene isolation", () => {
  it("loads a healthy project with no diagnostics", async () => {
    setProject({ "scenes/01-a.tsx": healthy("a"), "scenes/02-b.tsx": healthy("b") });
    const project = await loadProject("ws:demo");
    expect(project.sceneErrors).toEqual([]);
    expect(project.scenes.map((s) => s.id)).toEqual(["a", "b"]);
    expect(project.scenes.some(isSceneErrorCard)).toBe(false);
  });

  it("turns each failing scene into an error card and loads the rest", async () => {
    setProject({
      "scenes/01-ok.tsx": healthy("ok"),
      "scenes/02-syntax.tsx": "export default {\n SYNTAX ERROR",
      "scenes/03-throws.tsx": 'throw new TypeError("boom at the top level");',
      "scenes/04-no-default.tsx": "export const x = 1;",
      "scenes/05-missing.tsx": undefined,
      "scenes/06-ok.tsx": healthy("ok-2"),
    });
    const project = await loadProject("ws:demo");
    expect(project.sceneErrors).toEqual([
      {
        index: 1,
        file: "scenes/02-syntax.tsx",
        phase: "compile",
        message: 'line 2: Expected ";" but found "ERROR"',
      },
      {
        index: 2,
        file: "scenes/03-throws.tsx",
        phase: "evaluate",
        message: "TypeError: boom at the top level",
      },
      {
        index: 3,
        file: "scenes/04-no-default.tsx",
        phase: "export",
        message: "it must default-export defineScene({ id, durationMs, Scene })",
      },
      {
        index: 4,
        file: "scenes/05-missing.tsx",
        phase: "compile",
        message: "couldn't read the file: no such file: scenes/05-missing.tsx",
      },
    ]);
    expect(project.scenes.map(isSceneErrorCard)).toEqual([false, true, true, true, true, false]);
    expect(project.scenes.map((s) => s.durationMs)).toEqual([1000, 1500, 2000, 2500, 3000, 3500]);
    expect(project.slots).toHaveLength(6);
  });

  it("keeps a broken scene's manifest duration, else 3000", async () => {
    setProject({ "scenes/01-bad.tsx": "SYNTAX ERROR" });
    (manifest.scenes as { durationMs?: number }[])[0].durationMs = undefined;
    const project = await loadProject("ws:demo");
    expect(project.scenes[0].durationMs).toBe(3000);
  });

  it("records a broken persistent module without failing the project", async () => {
    setProject(
      { "scenes/01-a.tsx": healthy("a"), "scenes/persist.tsx": "SYNTAX ERROR" },
      { persistent: "scenes/persist.tsx" },
    );
    manifest.scenes = [{ file: "scenes/01-a.tsx", durationMs: 1000 }];
    const project = await loadProject("ws:demo");
    expect(project.persistent).toBeUndefined();
    expect(project.sceneErrors).toEqual([
      expect.objectContaining({ index: -1, file: "scenes/persist.tsx", phase: "compile" }),
    ]);
  });

  it("still fails the whole project on a broken manifest", async () => {
    setProject({ "scenes/01-a.tsx": healthy("a") });
    manifest = { ...manifest, scenes: [] };
    await expect(loadProject("ws:demo")).rejects.toThrow('needs a non-empty "scenes" array');
  });

  it("clears render errors on each load", async () => {
    setProject({ "scenes/01-a.tsx": healthy("a") });
    reportRenderError("ws:demo", { index: 0, file: "scenes/01-a.tsx", message: "x" });
    expect(projectRenderErrors("ws:demo")).toHaveLength(1);
    await loadProject("ws:demo");
    expect(projectRenderErrors("ws:demo")).toEqual([]);
  });
});

describe("export blockers", () => {
  it("records a dropped LUT and an unreadable font so deliverables refuse", async () => {
    setProject({ "scenes/01-a.tsx": healthy("a") });
    vi.mocked(preloadEffectLuts).mockRejectedValueOnce(new Error("HTTP 404"));
    vi.mocked(vetProjectFonts).mockResolvedValueOnce([
      { ref: "Locked@400", message: "couldn't read", fallback: "Inter@400", transient: true },
    ]);
    const loaded = await loadProject("ws:demo");
    expect(loaded.exportBlockers).toEqual([
      "the font file for Locked@400 couldn't be read (couldn't read)",
      "the colour LUT couldn't load (HTTP 404)",
    ]);
    expect(sceneErrorRefusal(loaded, "export")).toMatch(/^Can't export while the font file/);
  });
});

describe("sceneErrorRefusal", () => {
  it("refuses on export blockers after any broken files", () => {
    expect(
      sceneErrorRefusal({ exportBlockers: ["the colour LUT couldn't load (404)"] }, "export"),
    ).toBe("Can't export while the colour LUT couldn't load (404)");
  });

  it("names every broken file and its first error line", () => {
    expect(sceneErrorRefusal({ sceneErrors: [] }, "export")).toBeNull();
    expect(
      sceneErrorRefusal(
        {
          sceneErrors: [
            { index: 1, file: "scenes/02-x.tsx", phase: "compile", message: "line 4: bad\nmore" },
            { index: 2, file: "scenes/03-y.tsx", phase: "evaluate", message: "boom" },
          ],
        },
        "export",
      ),
    ).toBe(
      "Can't export while 2 files can't load: scenes/02-x.tsx (compile): line 4: bad; scenes/03-y.tsx (evaluate): boom",
    );
  });
});
