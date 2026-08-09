import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  builtinThemes,
  defaultTheme,
  isWorkspaceThemeId,
  lineupThemes,
  resolveTheme,
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
