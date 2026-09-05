import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertPresetScene } from "./presetInsert";
import { copySceneToProject } from "./projectEdit";
import { ensureProjectTrusted } from "./projectTrust";

vi.mock("./projectEdit", () => ({ copySceneToProject: vi.fn() }));
vi.mock("./projectTrust", () => ({ ensureProjectTrusted: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("insertPresetScene", () => {
  it("commits the placement in one copy and trusts the actual native index", async () => {
    const copied = {
      file: "scenes/04-title.tsx",
      docFile: "scenes/04-title.json",
      sceneId: "title-2",
      durationMs: 4000,
      index: 2,
    };
    vi.mocked(copySceneToProject).mockResolvedValue(copied);
    await expect(
      insertPresetScene({
        destSlug: "launch",
        presetProjectId: "ws-preset:title",
        position: 20,
      }),
    ).resolves.toEqual(copied);
    expect(ensureProjectTrusted).toHaveBeenCalledExactlyOnceWith("ws-preset:title", "title");
    expect(copySceneToProject).toHaveBeenCalledExactlyOnceWith("ws-preset:title", 0, "launch", 20);
  });

  it("waits for workspace source consent before copying anything", async () => {
    let allow!: () => void;
    vi.mocked(ensureProjectTrusted).mockReturnValue(
      new Promise<void>((resolve) => {
        allow = resolve;
      }),
    );
    const pending = insertPresetScene({
      destSlug: "launch",
      presetProjectId: "ws-preset:title",
      position: 0,
    });

    expect(ensureProjectTrusted).toHaveBeenCalledExactlyOnceWith("ws-preset:title", "title");
    expect(copySceneToProject).not.toHaveBeenCalled();
    allow();
    await pending;
    expect(copySceneToProject).toHaveBeenCalledExactlyOnceWith("ws-preset:title", 0, "launch", 0);
  });

  it("leaves the destination untouched when workspace source consent is declined", async () => {
    const denied = new Error("Preset trust declined");
    vi.mocked(ensureProjectTrusted).mockRejectedValue(denied);

    await expect(
      insertPresetScene({
        destSlug: "launch",
        presetProjectId: "ws-preset:title",
        position: 0,
      }),
    ).rejects.toBe(denied);

    expect(copySceneToProject).not.toHaveBeenCalled();
  });

  it("inserts bundled presets without requesting workspace consent", async () => {
    await insertPresetScene({
      destSlug: "launch",
      presetProjectId: "preset:title",
      position: 0,
    });

    expect(ensureProjectTrusted).not.toHaveBeenCalled();
    expect(copySceneToProject).toHaveBeenCalledExactlyOnceWith("preset:title", 0, "launch", 0);
  });

  it("surfaces a native failure without another mutation", async () => {
    vi.mocked(copySceneToProject).mockRejectedValue(new Error("Preset needs one scene"));
    await expect(
      insertPresetScene({
        destSlug: "launch",
        presetProjectId: "preset:title",
        position: 0,
      }),
    ).rejects.toThrow("Preset needs one scene");
    expect(copySceneToProject).toHaveBeenCalledTimes(1);
  });
});
