import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportAutoRunError } from "../engine/autorun";
import { useObjectEditStore } from "../engine/objectEditStore";
import type { LoadedProject } from "../engine/project";
import { STAGE_PROTOCOL_VERSION, type WindowNotice } from "../engine/stageProtocol";
import { initialDeckState } from "../present/presentStateMachine";
import { usePresentStore } from "../present/presentStore";
import { useEditorStore } from "../store/editorStore";
import { useUiStore } from "../store/uiStore";
import { StageClient, stageWorkerUrl, toStageProject } from "./stageClient";

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("../engine/project", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../engine/project")>()),
  // Every scope resolves here, as a bundled template's does once the resource root is known.
  projectFolderPath: (id: string) => `/x/${id}`,
}));
vi.mock("../engine/autorun", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../engine/autorun")>()),
  reportAutoRunError: vi.fn(),
}));

/** The worker as the window sees it: what was posted, whether it was terminated, and a way to answer. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly posted: { msg: WindowNotice | { type: string; id?: number }; transfer: unknown[] }[] =
    [];
  terminated = false;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: never, transfer: unknown[] = []) {
    this.posted.push({ msg, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
  last() {
    return this.posted.at(-1)?.msg as { type: string; id?: number };
  }
}

/** A canvas whose control transfers once, as the browser's does. */
function fakeCanvas() {
  const offscreen = { offscreen: Math.random() };
  let transfers = 0;
  const canvas = {
    style: {},
    transferControlToOffscreen() {
      if (transfers++) throw new Error("InvalidStateError: the canvas was already transferred");
      return offscreen;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, offscreen };
}

const size = { width: 640, height: 360, dpr: 1 };
const READY = { type: "ready", version: STAGE_PROTOCOL_VERSION, gl: "fake" };
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: Error) => e.message,
  );

describe("stageWorkerUrl", () => {
  it("starts a built worker from a blob, which inherits the window's policy", async () => {
    let script: Blob | undefined;
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          script = blob;
          return "blob:tauri://localhost/bootstrap";
        },
      }),
    );
    vi.stubGlobal("location", { href: "tauri://localhost/index.html" });
    expect(stageWorkerUrl(false)).toBe("blob:tauri://localhost/bootstrap");
    expect(await script?.text()).toMatch(/^import "tauri:\/\/localhost\/.*stageWorker.*";$/);
    expect(stageWorkerUrl(true)).toContain("stageWorker");
    vi.unstubAllGlobals();
  });
});

describe("toStageProject", () => {
  const root = (id: string) =>
    toStageProject({ id, scenes: [], sceneFiles: [] } as unknown as LoadedProject).root;

  it("names the folder of anything the workspace holds", () => {
    expect(root("ws:alpha")).toBe("/x/ws:alpha");
    expect(root("ws-template:launch")).toBe("/x/ws-template:launch");
    expect(root("ws-preset:hero")).toBe("/x/ws-preset:hero");
  });

  it("names no folder for a bundled item, which loads from the app's origin", () => {
    expect(root("showcase-tour")).toBeNull();
    expect(root("template:launch")).toBeNull();
    expect(root("preset:hero")).toBeNull();
  });
});

describe("StageClient boot", () => {
  const clients: StageClient[] = [];
  const start = (canvas = fakeCanvas().canvas) => {
    const client = new StageClient(canvas, "editor", size, "demand");
    clients.push(client);
    return { client, worker: FakeWorker.instances.at(-1) as FakeWorker };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accepts a ready that arrives after the window and serves again", async () => {
    const { client, worker } = start();
    const changes: string[] = [];
    client.subscribeBoot(() => changes.push(client.boot().status));
    const ready = outcome(client.ready);
    const queued = outcome(client.configure(size, "demand"));
    // A fire-and-forget request, as StageView's resize path sends: its rejection must not escape to the window.
    void client.configure(size, "demand");
    expect(client.boot()).toEqual({ status: "starting" });

    await vi.advanceTimersByTimeAsync(90_000);
    expect(client.boot()).toMatchObject({ status: "failed" });
    expect(await ready).toMatch(/did not report ready within 90s/);
    expect(await queued).toMatch(/did not report ready within 90s/);

    worker.emit(READY);
    expect(client.boot()).toEqual({ status: "ready", late: true });
    expect(changes).toEqual(["failed", "ready"]);
    const again = client.configure(size, "demand");
    const sent = worker.last();
    expect(sent.type).toBe("configure");
    worker.emit({ type: "reply", id: sent.id, ok: true, value: undefined });
    await expect(again).resolves.toBeUndefined();
  });

  it("keeps a worker that reported fatal failed, ready or not", async () => {
    const { client, worker } = start();
    const ready = outcome(client.ready);
    worker.emit({ type: "fatal", text: "server import failed" });
    expect(await ready).toBe("stage worker: server import failed");
    worker.emit(READY);
    expect(client.boot()).toMatchObject({ status: "failed" });
    await expect(client.configure(size, "demand")).rejects.toThrow("server import failed");
  });

  it("fails an autorun when the worker's reach refuses a file, and on nothing else it logs", () => {
    const { worker } = start();
    vi.mocked(reportAutoRunError).mockClear();
    worker.emit({ type: "log", level: "warn", text: "THREE.Clock: deprecated" });
    expect(reportAutoRunError).not.toHaveBeenCalled();
    worker.emit({ type: "log", level: "warn", text: "reach refused asset://localhost/%2Fa.png" });
    expect(reportAutoRunError).toHaveBeenCalledWith(
      "stage reach refused asset://localhost/%2Fa.png",
    );
  });

  it("retries with a fresh worker, a fresh canvas and a fresh window", async () => {
    const first = fakeCanvas();
    const { client, worker } = start(first.canvas);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(client.boot()).toMatchObject({ status: "failed" });
    expect(worker.posted[0].transfer).toEqual([first.offscreen]);

    client.dispose();
    expect(worker.terminated).toBe(true);
    const second = fakeCanvas();
    const retry = start(second.canvas);
    expect(retry.worker).not.toBe(worker);
    expect(retry.worker.posted[0].msg).toMatchObject({ type: "init", role: "editor" });
    expect(retry.worker.posted[0].transfer).toEqual([second.offscreen]);

    await vi.advanceTimersByTimeAsync(89_000);
    expect(retry.client.boot()).toEqual({ status: "starting" });
    retry.worker.emit(READY);
    expect(retry.client.boot()).toEqual({ status: "ready", late: false });
    await expect(retry.client.ready).resolves.toBeUndefined();
    expect(worker.terminated && !retry.worker.terminated).toBe(true);
  });
});

describe("StageClient store mirror", () => {
  const clients: StageClient[] = [];
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    useEditorStore.setState({ projectId: "ws:allowed" });
    useUiStore.setState({ audioMuted: false });
    usePresentStore.setState({ websiteFocused: false, deck: initialDeckState() });
    useObjectEditStore.setState({
      selected: { sceneIndex: 1, objectId: "cube" },
      pendingCommit: null,
    });
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose();
    vi.unstubAllGlobals();
  });
  const worker = () => {
    clients.push(new StageClient(fakeCanvas().canvas, "editor", size, "demand"));
    return FakeWorker.instances.at(-1) as FakeWorker;
  };
  const placement = { position: [0, 0, 0] };

  it("never lets the worker pick a project, drive the chrome or hold Present's focus", () => {
    const w = worker();
    w.emit({ type: "store", name: "editor", patch: { projectId: "ws:other" } });
    w.emit({ type: "store", name: "ui", patch: { audioMuted: true } });
    w.emit({ type: "store", name: "presentDeck", patch: { websiteFocused: true } });
    expect(useEditorStore.getState().projectId).toBe("ws:allowed");
    expect(useUiStore.getState().audioMuted).toBe(false);
    expect(usePresentStore.getState().websiteFocused).toBe(false);
  });

  it("takes a gizmo's commit only for the item the inspector has selected", () => {
    const w = worker();
    const elsewhere = { sceneIndex: 2, objectId: "cube", placement };
    w.emit({ type: "store", name: "objectEdit", patch: { pendingCommit: elsewhere } });
    expect(useObjectEditStore.getState().pendingCommit).toBeNull();
    const attached = { sceneIndex: 1, objectId: "cube", placement };
    w.emit({ type: "store", name: "objectEdit", patch: { pendingCommit: attached } });
    expect(useObjectEditStore.getState().pendingCommit).toEqual(attached);
    w.emit({ type: "store", name: "objectEdit", patch: { selected: null } });
    expect(useObjectEditStore.getState().selected).toBeNull();
  });
});
