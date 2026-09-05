import { beforeEach, describe, expect, it, vi } from "vitest";
import { useClockStore } from "./clock";
import { setExporting } from "./exportState";

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
}));

beforeEach(() => {
  useClockStore.getState().setCurrentMs(1500);
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
