import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadProject, rememberWorkspaceLibraryPath } from "./project";
import { ensureProjectTrusted } from "./projectTrust";
import { compileSceneModule } from "./sceneCompiler";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./projectTrust", () => ({ ensureProjectTrusted: vi.fn() }));
vi.mock("./sceneCompiler", () => ({ compileSceneModule: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(
    JSON.stringify({
      name: "Imported content",
      scenes: [{ file: "scenes/01-demo.tsx", durationMs: 2000 }],
    }),
  );
  vi.mocked(ensureProjectTrusted).mockRejectedValue(new Error("Trust declined"));
});

describe("workspace library trust", () => {
  it("passes background trust refusal through before any scene compiles or writes", async () => {
    rememberWorkspaceLibraryPath("ws-preset:demo", "/workspace/presets/demo");
    await expect(loadProject("ws-preset:demo", { trustMode: "stored-only" })).rejects.toThrow(
      "Trust declined",
    );
    expect(ensureProjectTrusted).toHaveBeenCalledWith(
      "ws-preset:demo",
      "Imported content",
      "stored-only",
    );
    expect(compileSceneModule).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each(["ws-template:demo", "ws-preset:demo"])(
    "requires consent before compiling or writing %s",
    async (id) => {
      rememberWorkspaceLibraryPath(id, `/workspace/${id}`);
      await expect(loadProject(id)).rejects.toThrow("Trust declined");
      expect(ensureProjectTrusted).toHaveBeenCalledWith(id, "Imported content");
      expect(compileSceneModule).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith("read_project_manifest", { slug: id });
    },
  );
});
