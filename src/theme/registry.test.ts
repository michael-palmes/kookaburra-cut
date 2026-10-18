import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  builtinThemes,
  defaultTheme,
  isWorkspaceThemeId,
  lineupThemes,
  memoThemeReader,
  resolveTheme,
  resolveThemeReport,
  THEME_LINEUP,
} from "./registry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

function workspaceDoc() {
  return {
    version: 2,
    id: "document-id",
    name: "Workspace Theme",
    colors: { background: "#000000", text: "#ffffff", accent: "#ff0000", muted: "#888888" },
    typography: { headline: "Inter", body: "Inter", scale: 1.25 },
    motion: {
      durations: { fast: 200, base: 500, slow: 900 },
      easings: { standard: "outQuad", emphasized: "outExpo" },
    },
  };
}

describe("theme registry", () => {
  it("resolves all bundled ids and keeps the visible lineup compatible", async () => {
    expect(Object.keys(builtinThemes)).toHaveLength(36);
    expect(lineupThemes().map(({ id }) => id)).toEqual(THEME_LINEUP);
    for (const id of Object.keys(builtinThemes))
      expect(await resolveTheme(id)).toBe(builtinThemes[id]);
  });

  it("keeps missing and unknown ids on the caller's fallback", async () => {
    const fallback = builtinThemes["kookaburra-paper"] ?? defaultTheme;
    expect(await resolveTheme(undefined, fallback)).toBe(fallback);
    expect(await resolveTheme("unknown-theme", fallback)).toBe(fallback);
  });

  it("keeps workspace folder identity and degrades read failures", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(workspaceDoc()));
    expect(isWorkspaceThemeId("ws:personal")).toBe(true);
    expect(await resolveTheme("ws:personal")).toMatchObject({
      id: "ws:personal",
      name: "Workspace Theme",
    });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("unavailable"));
    expect(await resolveTheme("ws:missing")).toBe(defaultTheme);
  });
});

describe("resolveThemeReport", () => {
  const docs: Record<string, unknown> = {};
  beforeEach(() => {
    for (const key of Object.keys(docs)) delete docs[key];
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const slug = (args as { slug?: string } | undefined)?.slug ?? "";
      if (command !== "read_theme" || !(slug in docs)) throw new Error(`no ${slug}`);
      return JSON.stringify(docs[slug]);
    });
  });

  it("merges a workspace chain down to a bundled base", async () => {
    docs.brand = { version: 3, id: "brand", name: "Brand", extends: "kookaburra-paper" };
    docs.night = {
      version: 3,
      id: "night",
      name: "Night",
      extends: "ws:brand",
      colors: { accent: "#ff00aa" },
      chartColors: "nope",
    };
    const paper = builtinThemes["kookaburra-paper"];
    const report = await resolveThemeReport("ws:night");
    expect(report.theme.id).toBe("ws:night");
    expect(report.theme.name).toBe("Night");
    expect(report.theme.colors).toEqual({ ...paper?.colors, accent: "#ff00aa" });
    expect(report.theme.typography).toEqual(paper?.typography);
    expect(report.warnings).toEqual([`[theme] ws:night: "chartColors" isn't an array, dropped`]);
  });

  it("falls back on a loop or a missing base, with the reason", async () => {
    const fallback = builtinThemes["kookaburra-paper"] ?? defaultTheme;
    docs.a = { version: 3, id: "a", extends: "ws:b" };
    docs.b = { version: 3, id: "b", extends: "ws:a" };
    const loop = await resolveThemeReport("ws:a", fallback);
    expect(loop.theme).toBe(fallback);
    expect(loop.warnings[0]).toContain("loops back");
    docs.c = { version: 3, id: "c", extends: "ws:gone" };
    const gone = await resolveThemeReport("ws:c");
    expect(gone.theme).toBe(defaultTheme);
    expect(gone.warnings[0]).toContain('"ws:gone" can\'t be found');
  });

  it("notes an unknown bundled id and an unreadable workspace theme", async () => {
    expect((await resolveThemeReport("kookaburra-nope")).warnings[0]).toContain("isn't a theme");
    expect((await resolveThemeReport("ws:absent")).warnings[0]).toContain("can't be read");
  });
});

describe("memoThemeReader", () => {
  it("reads each theme once per load, chain links and repeat scenes alike", async () => {
    const base = { ...workspaceDoc(), id: "base" };
    const variant = { version: 3, id: "variant", extends: "ws:base" };
    vi.mocked(invoke).mockImplementation(async (_cmd, args) =>
      JSON.stringify((args as { slug: string }).slug === "base" ? base : variant),
    );
    const read = memoThemeReader();
    const first = await resolveThemeReport("ws:variant", defaultTheme, read);
    const second = await resolveThemeReport("ws:variant", defaultTheme, read);
    expect(first.theme.id).toBe("ws:variant");
    expect(second.theme.colors.accent).toBe("#ff0000");
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
  });
});
