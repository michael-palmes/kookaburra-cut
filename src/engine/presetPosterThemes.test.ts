import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import themeDoc from "../theme/builtin/kookaburra-default.json";
import { defaultTheme } from "../theme/registry";
import { resolveSavedPosterTheme } from "./presetPosterThemes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("saved poster themes", () => {
  it("reads the edited bundled document instead of cached eager tokens", async () => {
    vi.mocked(invoke).mockResolvedValue(
      JSON.stringify({ ...themeDoc, colors: { ...themeDoc.colors, accent: "#123456" } }),
    );
    const theme = await resolveSavedPosterTheme(themeDoc.id, undefined, true);
    expect(invoke).toHaveBeenCalledWith("read_builtin_theme", { id: themeDoc.id });
    expect(theme.colors.accent).toBe("#123456");
    expect(defaultTheme.colors.accent).not.toBe("#123456");
  });

  it("refuses invalid saved data without publishing the old bundled theme", async () => {
    vi.mocked(invoke).mockResolvedValue("not JSON");
    await expect(resolveSavedPosterTheme(themeDoc.id, undefined, true)).rejects.toThrow();
  });

  it("keeps packaged bundled themes on their shipped registry", async () => {
    expect(await resolveSavedPosterTheme(themeDoc.id, undefined, false)).toBe(defaultTheme);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads the saved default when the project omits its theme id", async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify(themeDoc));
    await resolveSavedPosterTheme(undefined, undefined, true);
    expect(invoke).toHaveBeenCalledWith("read_builtin_theme", { id: themeDoc.id });
  });
});
