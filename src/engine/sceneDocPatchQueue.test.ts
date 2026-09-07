import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedProject } from "./project";
import type { SceneDoc } from "./sceneDocSchema";

const mocks = vi.hoisted(() => ({
  pushHistory: vi.fn(),
  writeSceneDoc: vi.fn(async (_slug: string, _file: string, _doc: SceneDoc) => {}),
}));

vi.mock("./history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./history")>();
  return { ...actual, pushHistory: mocks.pushHistory };
});

vi.mock("./sceneDoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sceneDoc")>();
  return { ...actual, writeSceneDoc: mocks.writeSceneDoc };
});

import { commitSceneDocPatch, settleSceneDocPatches } from "./sceneDocPatchQueue";

let fileCounter = 0;

/** A fresh scene file per test keeps every test on its own queue. */
function projectWith(doc: SceneDoc | undefined, id = "ws:demo"): LoadedProject {
  fileCounter += 1;
  return {
    id,
    sceneFiles: [`scenes/${String(fileCounter).padStart(2, "0")}-scene.tsx`],
    sceneDocs: [doc],
    slots: [],
  } as unknown as LoadedProject;
}

const written = () => mocks.writeSceneDoc.mock.calls.map((call) => call[2]);

/** Holds every write until released; `releaseAll(n)` lets n writes through one macrotask at a time, since a queued commit only issues its write once the one ahead has landed. */
function holdWrites() {
  const release: Array<() => void> = [];
  mocks.writeSceneDoc.mockImplementation(
    () => new Promise<void>((resolve) => release.push(resolve)),
  );
  return {
    releaseAll: async (expected: number) => {
      let released = 0;
      while (released < expected) {
        if (release.length) {
          release.shift()?.();
          released += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await settleSceneDocPatches();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeSceneDoc.mockImplementation(async () => {});
});

describe("commitSceneDocPatch", () => {
  it("applies a patch to the latest document, publishes by file and project id, and records one entry", async () => {
    const onDocChanged = vi.fn();
    const project = projectWith({ version: 1, name: "before" });
    const result = await commitSceneDocPatch(
      { project, sceneIndex: 0, label: "rename", onDocChanged },
      (next) => {
        next.name = "after";
      },
    );
    expect(result?.doc).toEqual({ version: 1, name: "after" });
    expect(mocks.writeSceneDoc).toHaveBeenCalledWith("demo", project.sceneFiles[0], {
      version: 1,
      name: "after",
    });
    expect(onDocChanged).toHaveBeenCalledWith(
      0,
      { version: 1, name: "after" },
      project.sceneFiles[0],
      "ws:demo",
    );
    expect(mocks.pushHistory).toHaveBeenCalledTimes(1);
    expect(mocks.pushHistory.mock.calls[0][0]).toEqual({
      label: "rename",
      changes: [
        {
          kind: "sceneDoc",
          slug: "demo",
          file: project.sceneFiles[0],
          sceneIndex: 0,
          before: { version: 1, name: "before" },
          after: { version: 1, name: "after" },
        },
      ],
    });
  });

  it("two writers queued on one scene keep both edits (the second rebases on the first)", async () => {
    const onDocChanged = vi.fn();
    const project = projectWith({ version: 1 });
    const writes = holdWrites();
    const first = commitSceneDocPatch(
      { project, sceneIndex: 0, label: "device animation", onDocChanged },
      (next) => {
        next.deviceTrack = { keys: [], segments: [] } as unknown as SceneDoc["deviceTrack"];
      },
    );
    const second = commitSceneDocPatch(
      { project, sceneIndex: 0, label: "divider animation", onDocChanged },
      (next) => {
        next.compare = { value: 0.25 };
      },
    );
    await writes.releaseAll(2);
    await Promise.all([first, second]);
    expect(written()).toHaveLength(2);
    expect(written()[1]).toEqual({
      version: 1,
      deviceTrack: { keys: [], segments: [] },
      compare: { value: 0.25 },
    });
    const entries = mocks.pushHistory.mock.calls.map((call) => call[0]);
    expect(entries.map((entry) => entry.label)).toEqual(["device animation", "divider animation"]);
    expect(entries[1].changes[0].before).toEqual(entries[0].changes[0].after);
  });

  it("starts a doc-less scene from a minimal document with a null undo before", async () => {
    const project = projectWith(undefined);
    const result = await commitSceneDocPatch(
      { project, sceneIndex: 0, label: "camera edit", onDocChanged: vi.fn() },
      (next) => {
        next.cameraMode = "rig";
      },
    );
    expect(result?.doc).toEqual({ version: 1, cameraMode: "rig" });
    expect(result?.change).toMatchObject({
      before: null,
      after: { version: 1, cameraMode: "rig" },
    });
  });

  it("an aborted patch writes nothing and resolves null", async () => {
    const onDocChanged = vi.fn();
    const result = await commitSceneDocPatch(
      { project: projectWith({ version: 1 }), sceneIndex: 0, label: "noop", onDocChanged },
      () => false,
    );
    expect(result).toBeNull();
    expect(mocks.writeSceneDoc).not.toHaveBeenCalled();
    expect(onDocChanged).not.toHaveBeenCalled();
    expect(mocks.pushHistory).not.toHaveBeenCalled();
  });

  it("label false records nothing and hands the change back for a compound entry", async () => {
    const result = await commitSceneDocPatch(
      { project: projectWith({ version: 1 }), sceneIndex: 0, label: false, onDocChanged: vi.fn() },
      (next) => {
        next.name = "batched";
      },
    );
    expect(mocks.pushHistory).not.toHaveBeenCalled();
    expect(result?.change).toMatchObject({
      kind: "sceneDoc",
      after: { version: 1, name: "batched" },
    });
  });

  it("a drag baseline is the undo before while the write applies to the latest document", async () => {
    const baseline: SceneDoc = { version: 1, name: "drag start" };
    const project = projectWith({ version: 1, name: "latest", compare: { value: 0.4 } });
    const result = await commitSceneDocPatch(
      { project, sceneIndex: 0, label: "move", onDocChanged: vi.fn(), baseline },
      (next) => {
        next.name = "dropped";
      },
    );
    expect(result?.doc).toEqual({ version: 1, name: "dropped", compare: { value: 0.4 } });
    expect(result?.change.before).toEqual(baseline);
  });

  it("a replacement document returned by the patch is what lands", async () => {
    const result = await commitSceneDocPatch(
      {
        project: projectWith({ version: 1, name: "old" }),
        sceneIndex: 0,
        label: "swap",
        onDocChanged: vi.fn(),
      },
      () => ({ version: 1, name: "replacement" }) as SceneDoc,
    );
    expect(result?.doc).toEqual({ version: 1, name: "replacement" });
    expect(written()[0]).toEqual({ version: 1, name: "replacement" });
  });

  it("a rejected write propagates to the caller and leaves the queue usable", async () => {
    const project = projectWith({ version: 1 });
    mocks.writeSceneDoc.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      commitSceneDocPatch(
        { project, sceneIndex: 0, label: "first", onDocChanged: vi.fn() },
        (next) => {
          next.name = "lost";
        },
      ),
    ).rejects.toThrow("disk full");
    const result = await commitSceneDocPatch(
      { project, sceneIndex: 0, label: "second", onDocChanged: vi.fn() },
      (next) => {
        next.name = "kept";
      },
    );
    expect(result?.doc).toEqual({ version: 1, name: "kept" });
    expect(mocks.pushHistory).toHaveBeenCalledTimes(1);
  });

  it("refuses a project this build cannot write", async () => {
    const result = await commitSceneDocPatch(
      {
        project: projectWith({ version: 1 }, "showcase-tour"),
        sceneIndex: 0,
        label: "x",
        onDocChanged: vi.fn(),
      },
      (next) => {
        next.name = "never";
      },
    );
    expect(result).toBeNull();
    expect(mocks.writeSceneDoc).not.toHaveBeenCalled();
  });

  it("an idle queue adopts the caller's newer document (a reload or an undo replay)", async () => {
    const project = projectWith({ version: 1, name: "first" });
    await commitSceneDocPatch(
      { project, sceneIndex: 0, label: "a", onDocChanged: vi.fn() },
      (next) => {
        next.compare = { value: 0.5 };
      },
    );
    const reloaded = {
      ...project,
      sceneDocs: [{ version: 1, name: "external edit" }],
    } as LoadedProject;
    const result = await commitSceneDocPatch(
      { project: reloaded, sceneIndex: 0, label: "b", onDocChanged: vi.fn() },
      (next) => {
        next.chart = { kind: "bar" } as unknown as SceneDoc["chart"];
      },
    );
    expect(result?.doc).toEqual({ version: 1, name: "external edit", chart: { kind: "bar" } });
  });

  it("flags a themeId change for the replay's reload", async () => {
    const result = await commitSceneDocPatch(
      {
        project: projectWith({ version: 1 }),
        sceneIndex: 0,
        label: "theme",
        onDocChanged: vi.fn(),
      },
      (next) => {
        next.themeId = "paper";
      },
    );
    expect(result?.change).toMatchObject({ reload: true });
  });
});
