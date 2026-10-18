import { beforeEach, describe, expect, it, vi } from "vitest";

/** loadProject's parse-warning tail: what the theme, scene-doc and project parsers drop surfaces per file, deduped and capped, and never blocks export. */

const themes = new Map<string, unknown>();
const sidecarWarnings: string[] = [];
let manifest: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(async (command: string, args?: { slug?: string }) => {
    switch (command) {
      case "get_settings":
        return { workspaceRoot: "/ws" };
      case "list_projects":
        return [{ slug: "demo", name: "Demo", path: "/ws/demo" }];
      case "read_project_manifest":
        return JSON.stringify(manifest);
      case "read_scene_source":
        return `export default { id: "a", durationMs: 1000, Scene: function Scene() { return null; } };`;
      case "read_theme": {
        const doc = themes.get(args?.slug ?? "");
        if (doc === undefined) throw `no theme ${args?.slug}`;
        return JSON.stringify(doc);
      }
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
vi.mock("./sceneDoc", () => ({
  loadSceneDoc: vi.fn(
    async (
      _id: string,
      _file: string,
      _glob: unknown,
      _dir: string | undefined,
      warnings?: string[],
    ) => {
      warnings?.push(...sidecarWarnings);
      return undefined;
    },
  ),
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
const { defaultTheme } = await import("../theme/registry");

const brand = {
  version: 2,
  id: "brand",
  name: "Brand",
  colors: { background: "#101010", text: "#fafafa", accent: "#ff5a36", muted: "#888888" },
  typography: { headline: "Inter@600", body: "Inter", scale: 1.25 },
  motion: {
    durations: { fast: 200, base: 500, slow: 900 },
    easings: { standard: "outCubic", emphasized: "outExpo" },
  },
};

function setProject(extra: Record<string, unknown> = {}) {
  manifest = {
    id: "demo",
    name: "Demo",
    version: 2,
    themeId: "ws:brand-light",
    formats: ["16:9"],
    scenes: [{ file: "scenes/01-a.tsx", durationMs: 1000 }],
    ...extra,
  };
}

beforeEach(() => {
  bumpWorkspaceReloadToken();
  themes.clear();
  sidecarWarnings.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadProject parse warnings", () => {
  it("resolves a variant through its base and names each ignored setting by file", async () => {
    themes.set("brand", brand);
    themes.set("brand-light", {
      version: 3,
      id: "brand-light",
      name: "Brand light",
      extends: "ws:brand",
      colors: { background: "#ffffff" },
      chartColors: "nope",
    });
    sidecarWarnings.push('[sceneDoc] demo/scenes/01-a.json: invalid "camera", dropped');
    setProject({ typography: { chart: 7 } });
    const loaded = await loadProject("ws:demo");
    expect(loaded.theme.colors).toEqual({ ...brand.colors, background: "#ffffff" });
    expect(loaded.theme.typography.headline).toEqual({ family: "Inter", weight: 600 });
    expect(loaded.loadWarnings).toEqual([
      'scenes/01-a.json: invalid "camera", dropped',
      `project.json: typography.chart isn't "Family" or "Family@weight"`,
      `themes/brand-light/theme.json: "chartColors" isn't an array, dropped`,
    ]);
    expect(loaded.exportBlockers).toEqual([]);
  });

  it("falls back with a note when a variant's base is missing", async () => {
    themes.set("brand-light", { version: 3, name: "Brand light", extends: "ws:gone" });
    setProject();
    const loaded = await loadProject("ws:demo");
    expect(loaded.theme.id).toBe(defaultTheme.id);
    expect(loaded.loadWarnings).toEqual([
      `themes/brand-light/theme.json: its base theme "ws:gone" can't be found, so the theme can't load`,
    ]);
  });

  it("dedupes and caps the list", async () => {
    themes.set("brand-light", brand);
    for (let i = 0; i < 60; i++) sidecarWarnings.push(`[sceneDoc] x: warning ${i % 50}`);
    setProject();
    const loaded = await loadProject("ws:demo");
    expect(loaded.loadWarnings).toHaveLength(40);
    expect(loaded.loadWarnings?.[39]).toBe("and 11 more settings were ignored");
    expect(loaded.exportBlockers).toEqual([]);
  });
});
