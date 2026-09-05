import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertPresetScene } from "./presetInsert";
import { copySceneToProject } from "./projectEdit";

vi.mock("./projectEdit", () => ({ copySceneToProject: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

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
    expect(copySceneToProject).toHaveBeenCalledExactlyOnceWith("ws-preset:title", 0, "launch", 20);
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
