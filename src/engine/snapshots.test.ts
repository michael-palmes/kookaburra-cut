import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClockStore } from "./clock";
import { canvasCommittedClockMs, canvasCommittedProject, canvasHandle } from "./exportBridge";
import { setExporting } from "./exportState";
import { canCaptureSnapshot, captureSnapshot } from "./snapshots";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./exportBridge", () => ({
  canvasHandle: { current: {} },
  canvasCommittedClockMs: vi.fn(() => 0),
  canvasCommittedProject: vi.fn(() => null),
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setExporting(false);
});

describe("snapshot destinations", () => {
  it("keeps presets on the independent render queue in every build", () => {
    for (const id of ["ws:demo", "ws-template:demo"]) {
      expect(canCaptureSnapshot(id)).toBe(true);
    }
    for (const id of ["demo", "template:demo", "unknown:demo", "preset:demo", "ws-preset:demo"]) {
      expect(canCaptureSnapshot(id)).toBe(false);
    }
  });

  function prepareCapture(beforeEncoded?: () => void) {
    vi.useFakeTimers();
    const project = { id: "ws-template:demo", totalMs: 2000 } as import("./project").LoadedProject;
    vi.mocked(canvasCommittedProject).mockReturnValue(project);
    vi.mocked(canvasCommittedClockMs).mockImplementation(() => useClockStore.getState().currentMs);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    canvasHandle.current = {
      advance: vi.fn(),
      scene: {},
      gl: { domElement: { width: 1280, height: 720 } },
    } as unknown as NonNullable<typeof canvasHandle.current>;
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
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

  it("publishes a template poster with its exact scoped identity and native metadata", async () => {
    const { project, bytes } = prepareCapture();
    vi.mocked(invoke).mockResolvedValue({
      path: "/workspace/templates/demo/poster.png",
      mtimeMs: 42,
    });
    const saved = vi.fn();
    const result = captureSnapshot(project, saved);
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    expect(invoke).toHaveBeenCalledWith("write_snapshot", bytes, {
      headers: { "x-kookaburra-slug": "ws-template:demo" },
    });
    expect(saved).toHaveBeenCalledWith({
      projectId: "ws-template:demo",
      path: "/workspace/templates/demo/poster.png",
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
