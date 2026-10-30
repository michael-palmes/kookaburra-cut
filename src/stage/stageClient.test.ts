import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGE_PROTOCOL_VERSION, type WindowNotice } from "../engine/stageProtocol";
import { StageClient } from "./stageClient";

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
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
