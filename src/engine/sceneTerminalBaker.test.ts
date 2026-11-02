import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedProject } from "./project";
import type { SceneDoc } from "./sceneDocSchema";

const mocks = vi.hoisted(() => ({
  bake: vi.fn(async (_id: string, stem: string) => `assets/terminal-${stem}.png`),
  commit: vi.fn(),
}));
vi.mock("./sceneTerminalBake", () => ({ bakeTerminalSnapshot: mocks.bake }));
vi.mock("./sceneDocPatchQueue", () => ({ commitSceneDocPatch: mocks.commit }));
vi.mock("./sceneTerminalTheme", () => ({
  resolveTerminalColours: (theme: string) => ({ theme }),
}));

const { reconcileTerminalBakes, settleTerminalBakes } = await import("./sceneTerminalBaker");

const onDocChanged = vi.fn();
let nextId = 0;

/** A fresh project id per test: the baker's memory of what is on disk is per project. */
function project(id: string, terminal: NonNullable<SceneDoc["terminal"]>): LoadedProject {
  return {
    id,
    sceneFiles: ["scenes/01-demo.tsx"],
    sceneDocs: [{ version: 1, terminal }],
    sceneThemes: [{}],
    theme: {},
  } as unknown as LoadedProject;
}

async function reconcile(p: LoadedProject) {
  reconcileTerminalBakes(p, onDocChanged);
  await settleTerminalBakes();
}

/** What the sidecar holds after the queued write the baker asked for. */
function landed(terminal: NonNullable<SceneDoc["terminal"]>) {
  const patch = mocks.commit.mock.lastCall?.[1] as (next: SceneDoc) => unknown;
  const next = { version: 1, terminal: structuredClone(terminal) } as SceneDoc;
  const result = patch(next);
  return { result, terminal: next.terminal };
}

describe("reconcileTerminalBakes", () => {
  let id: string;
  beforeEach(() => {
    id = `ws:baker-${nextId++}`;
    mocks.bake.mockClear();
    mocks.commit.mockReset();
    mocks.commit.mockResolvedValue(null);
  });

  it("never bakes outside a workspace project", async () => {
    await reconcile(project("showcase-tour", { transcript: "$ ls" }));
    expect(mocks.bake).not.toHaveBeenCalled();
  });

  it("leaves a settled snapshot's PNG alone at first sight", async () => {
    await reconcile(project(id, { snapshot: { grid: [[["$ ls"]]], src: "assets/t.png" } }));
    expect(mocks.bake).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("lays out, bakes and lands a new transcript with no history entry", async () => {
    await reconcile(project(id, { cols: 20, rows: 4, transcript: "$ ls\n" }));
    expect(mocks.bake).toHaveBeenCalledTimes(1);
    expect(mocks.commit.mock.lastCall?.[0]).toMatchObject({ label: false });
    expect(landed({ transcript: "$ ls\n" }).terminal?.snapshot).toEqual({
      grid: [[["$ ls", null, null, 0]]],
      cursor: { col: 0, row: 1 },
      transcript: "$ ls\n",
      src: "assets/terminal-01-demo.png",
    });
  });

  it("stands aside for a transcript edited while the bake ran", async () => {
    await reconcile(project(id, { transcript: "old" }));
    const { result } = landed({ transcript: "newer" });
    expect(result).toBe(false);
  });

  it("does not bake again once the landed snapshot comes back", async () => {
    const terminal = { cols: 20, rows: 4, transcript: "$ ls" };
    await reconcile(project(id, terminal));
    const after = landed(terminal).terminal;
    mocks.bake.mockClear();
    mocks.commit.mockClear();
    await reconcile(project(id, after ?? {}));
    expect(mocks.bake).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("re-bakes the pixels alone when an undo restores an older snapshot", async () => {
    const snapshot = (word: string) => ({
      grid: [[[word, null, null, 0]]] as never,
      cursor: { col: 0, row: 1 },
      src: "assets/terminal-01-demo.png",
      transcript: word,
    });
    await reconcile(project(id, { transcript: "b", snapshot: snapshot("b") }));
    await reconcile(project(id, { transcript: "a", snapshot: snapshot("a") }));
    expect(mocks.bake).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("re-bakes the pixels alone for a theme or font change on a captured grid", async () => {
    const snapshot = { grid: [[["$ ls"]]] as never, src: "assets/terminal-01-demo.png" };
    await reconcile(project(id, { snapshot }));
    await reconcile(project(id, { theme: "phosphor", snapshot }));
    expect(mocks.bake).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("lands the src of a grid that never had one", async () => {
    await reconcile(project(id, { snapshot: { grid: [[["$ ls"]]] as never } }));
    expect(mocks.bake).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
  });

  it("keeps going past a failed bake and tries again on the next change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.bake.mockRejectedValueOnce(new Error("disk full"));
    await reconcile(project(id, { transcript: "$ ls" }));
    expect(mocks.commit).not.toHaveBeenCalled();
    await reconcile(project(id, { transcript: "$ ls" }));
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
