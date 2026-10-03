import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClockStore } from "./clock";
import {
  canvasCommittedClockMs,
  canvasCommittedProject,
  canvasContextLosses,
  canvasHandle,
} from "./exportBridge";
import { setExporting } from "./exportState";
import {
  canCaptureSnapshot,
  captureFrameAt,
  captureSnapshot,
  withBorrowedClock,
} from "./snapshots";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./exportBridge", () => ({
  canvasHandle: { current: {} },
  canvasCommittedClockMs: vi.fn(() => 0),
  canvasCommittedProject: vi.fn(() => null),
  canvasContextLosses: vi.fn(() => 0),
  setCapturingPreview: vi.fn(),
}));
vi.mock("./exporter", () => ({ awaitTextSync: vi.fn(async () => {}) }));
vi.mock("./gizmoRegistry", () => ({ hideGizmoHandles: vi.fn(() => () => {}) }));
vi.mock("./project", () => ({
  isWorkspaceBackedProjectId: (id: string) => /^(ws|ws-template|ws-preset):/.test(id),
  nativeProjectSlug: (id: string) => (id.startsWith("ws:") ? id.slice(3) : id),
  parseProjectId: (id: string) => ({
    scope: id.startsWith("ws:") ? "workspace" : id.split(":")[0],
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", globalThis);
  setExporting(false);
  useClockStore.getState().setCurrentMs(1500);
  vi.mocked(canvasCommittedProject).mockReturnValue(null);
  vi.mocked(canvasContextLosses).mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setExporting(false);
});

describe("snapshot destinations", () => {
  it("keeps presets on the independent render queue in every build", () => {
    for (const id of ["ws:demo"]) {
      expect(canCaptureSnapshot(id)).toBe(true);
    }
    for (const id of [
      "demo",
      "template:demo",
      "ws-template:demo",
      "unknown:demo",
      "preset:demo",
      "ws-preset:demo",
    ]) {
      expect(canCaptureSnapshot(id)).toBe(false);
    }
  });

  /** A drawn frame: every pixel opaque, as a scene's background clear leaves it. */
  const drawn = (buffer: Uint8Array) => {
    for (let i = 3; i < buffer.length; i += 4) buffer[i] = 255;
  };

  function prepareCapture(
    beforeEncoded?: () => void,
    gpu: { read?: (buffer: Uint8Array) => void; lost?: boolean } = {},
  ) {
    vi.useFakeTimers();
    const project = { id: "ws:demo", totalMs: 2000 } as import("./project").LoadedProject;
    vi.mocked(canvasCommittedProject).mockReturnValue(project);
    vi.mocked(canvasCommittedClockMs).mockImplementation(() => useClockStore.getState().currentMs);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    canvasHandle.current = {
      advance: vi.fn(),
      scene: {},
      gl: {
        getContext: () => ({
          drawingBufferWidth: 64,
          drawingBufferHeight: 36,
          isContextLost: () => gpu.lost ?? false,
          readPixels: (...args: unknown[]) => (gpu.read ?? drawn)(args[6] as Uint8Array),
        }),
      },
    } as unknown as NonNullable<typeof canvasHandle.current>;
    vi.stubGlobal("ImageData", class {});
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ putImageData: vi.fn() }),
        toBlob: (ready: (blob: { arrayBuffer: () => Promise<ArrayBufferLike> }) => void) =>
          ready({
            arrayBuffer: async () => {
              beforeEncoded?.();
              return bytes.buffer;
            },
          }),
      }),
    });
    return { project, bytes };
  }

  it("publishes a project snapshot with its native identity and metadata", async () => {
    const { project, bytes } = prepareCapture();
    vi.mocked(invoke).mockResolvedValue({
      path: "/workspace/demo/.kookaburra/snapshot.png",
      mtimeMs: 42,
    });
    const saved = vi.fn();
    const result = captureSnapshot(project, saved);
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    expect(invoke).toHaveBeenCalledWith("write_snapshot", bytes, {
      headers: { "x-kookaburra-slug": "demo" },
    });
    expect(saved).toHaveBeenCalledWith({
      projectId: "ws:demo",
      path: "/workspace/demo/.kookaburra/snapshot.png",
      mtimeMs: 42,
    });
    expect(useClockStore.getState().currentMs).toBe(1500);
  });

  it("does not publish a frame after navigating away during capture", async () => {
    const { project } = prepareCapture();
    const saved = vi.fn();
    const result = captureSnapshot(project, saved);
    vi.mocked(canvasCommittedProject).mockReturnValue(null);
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it("does not publish a pending frame when export starts during encoding", async () => {
    const { project } = prepareCapture(() => setExporting(true));
    const result = captureSnapshot(project);
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never encodes the all-zero buffer a timed-out readPixels leaves (the black chart cards)", async () => {
    const { project } = prepareCapture(undefined, { read: () => {} });
    const result = captureSnapshot(project);
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fails a batch capture loudly instead of returning a blank frame", async () => {
    prepareCapture(undefined, { read: () => {} });
    const result = withBorrowedClock(() => captureFrameAt(500, 32, "jpeg")).catch(String);
    await vi.runAllTimersAsync();
    expect(await result).toMatch(/preview capture 64x36\): readPixels returned an all-zero frame/);
  });

  it("refuses a frame read from a lost context", async () => {
    prepareCapture(undefined, { lost: true });
    const result = withBorrowedClock(() => captureFrameAt(500, 32, "jpeg")).catch(String);
    await vi.runAllTimersAsync();
    expect(await result).toMatch(/WebGL context was lost/);
  });

  it("refuses a frame rendered after a context loss and restore inside the borrow", async () => {
    prepareCapture(undefined, {
      read: (buffer) => {
        drawn(buffer);
        vi.mocked(canvasContextLosses).mockReturnValue(1);
      },
    });
    const result = withBorrowedClock(() => captureFrameAt(500, 32, "jpeg")).catch(String);
    await vi.runAllTimersAsync();
    expect(await result).toMatch(/WebGL context was lost/);
  });

  it("does not publish another project's poster after navigation during encoding", async () => {
    const { project } = prepareCapture(() =>
      vi.mocked(canvasCommittedProject).mockReturnValue(null),
    );
    const result = captureSnapshot(project);
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("withBorrowedClock", () => {
  it("does not seek or save a library poster after its project changed", async () => {
    const { captureSnapshot } = await import("./snapshots");
    const { invoke } = await import("@tauri-apps/api/core");
    const project = { id: "ws-preset:demo", totalMs: 2000 } as import("./project").LoadedProject;
    expect(await captureSnapshot(project)).toBe(false);
    expect(useClockStore.getState().currentMs).toBe(1500);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("gives the scrub position back when its own last seek is still current", async () => {
    const { noteBorrowedSeek, withBorrowedClock } = await import("./snapshots");
    await withBorrowedClock(async () => {
      useClockStore.getState().setCurrentMs(500);
      noteBorrowedSeek(500);
    });
    expect(useClockStore.getState().currentMs).toBe(1500);
  });

  it("leaves the clock alone when something else moved it after the last seek", async () => {
    const { noteBorrowedSeek, withBorrowedClock } = await import("./snapshots");
    await withBorrowedClock(async () => {
      useClockStore.getState().setCurrentMs(500);
      noteBorrowedSeek(500);
      // The post-add focus seek (or a user scrub) lands mid-capture.
      useClockStore.getState().setCurrentMs(9000);
    });
    expect(useClockStore.getState().currentMs).toBe(9000);
  });

  it("leaves the clock alone when the borrowed run never sought", async () => {
    const { withBorrowedClock } = await import("./snapshots");
    await withBorrowedClock(async () => {
      useClockStore.getState().setCurrentMs(9000);
    });
    expect(useClockStore.getState().currentMs).toBe(9000);
  });

  it("never writes the clock back while an export holds it", async () => {
    const { noteBorrowedSeek, withBorrowedClock } = await import("./snapshots");
    await withBorrowedClock(async () => {
      useClockStore.getState().setCurrentMs(500);
      noteBorrowedSeek(500);
      setExporting(true);
    });
    expect(useClockStore.getState().currentMs).toBe(500);
    setExporting(false);
  });

  it("declines re-entry while a capture is in flight", async () => {
    const { withBorrowedClock } = await import("./snapshots");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withBorrowedClock(async () => {
      await gate;
      return "first";
    });
    expect(await withBorrowedClock(async () => "second")).toBeNull();
    release();
    expect(await first).toBe("first");
  });
});
