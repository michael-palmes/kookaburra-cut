import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedProject } from "../engine/project";
import { defaultOrbitPose } from "../engine/sceneCamera";
import { settleSceneDocPatches } from "../engine/sceneDocPatchQueue";
import type { SceneDoc } from "../engine/sceneDocSchema";

// The drag-commit writers all land through commitSceneDocPatch now; these pin the bytes each one writes, the four-argument host patch, and the lost-update case the queue exists for.

const mocks = vi.hoisted(() => ({
  pushHistory: vi.fn(),
  writeSceneDoc: vi.fn(async (_slug: string, _file: string, _doc: SceneDoc) => {}),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback<T>(fn: T) {
      return fn;
    },
    useEffect() {},
    useState<T>(initial: T) {
      return [initial, () => {}] as const;
    },
  };
});

vi.mock("../engine/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/history")>();
  return { ...actual, pushHistory: mocks.pushHistory };
});

vi.mock("../engine/sceneDoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/sceneDoc")>();
  return { ...actual, writeSceneDoc: mocks.writeSceneDoc };
});

vi.mock("../engine/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/format")>();
  return { ...actual, useFormat: () => actual.computeFormat(actual.FORMATS["16:9"]) };
});

vi.mock("../engine/stageRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/stageRegistry")>();
  return { ...actual, useSceneStageFloorY: () => undefined };
});

vi.mock("../engine/layeredScreenshotEditStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/layeredScreenshotEditStore")>();
  return { ...actual, useLayeredScreenshotDraft: () => null };
});

import { useCameraDoc } from "./cameraDoc";
import { useChartTrackDoc } from "./chartTrackDoc";
import { useCompareTrackDoc } from "./compareTrackDoc";
import { useDeviceTrackDoc } from "./deviceTrackDoc";
import { useGizmoDocWrite } from "./gizmo/gizmoDocWrite";
import { emptyLayeredScreenshot, useLayeredScreenshotDoc } from "./layeredScreenshotDoc";
import { useLightingTrackDoc } from "./lightingTrackDoc";

const FILE = "scenes/01-scene.tsx";

function projectWith(doc: SceneDoc | undefined): LoadedProject {
  return {
    id: "ws:demo",
    sceneFiles: [FILE],
    sceneDocs: [doc],
    slots: [{ startMs: 0, endMs: 3000, durationMs: 3000 }],
    cameraTrack: [],
  } as unknown as LoadedProject;
}

const lastWritten = () => mocks.writeSceneDoc.mock.calls.at(-1)?.[2];
const lastEntry = () => mocks.pushHistory.mock.calls.at(-1)?.[0];

const track = { keys: [{ id: "k1", tMs: 0, pose: {} }], segments: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeSceneDoc.mockImplementation(async () => {});
});

describe("direct sidecar writers", () => {
  it("device track: writes the track block and patches the host by file and project id", async () => {
    const onDocChanged = vi.fn();
    const project = projectWith({ version: 1, devices: [] });
    await useDeviceTrackDoc(project, 0, onDocChanged).commit(track as never);
    expect(lastWritten()).toEqual({ version: 1, devices: [], deviceTrack: track });
    expect(onDocChanged).toHaveBeenCalledWith(0, lastWritten(), FILE, "ws:demo");
    expect(lastEntry()).toMatchObject({
      label: "device animation",
      changes: [
        { kind: "sceneDoc", slug: "demo", file: FILE, before: { version: 1, devices: [] } },
      ],
    });
  });

  it("device track: an empty track deletes the block", async () => {
    const project = projectWith({ version: 1, deviceTrack: track as never });
    await useDeviceTrackDoc(project, 0, vi.fn()).commit({ keys: [], segments: [] });
    expect(lastWritten()).toEqual({ version: 1 });
  });

  it("chart track: writes into the existing chart block", async () => {
    const chart = { kind: "bar", series: [] } as unknown as NonNullable<SceneDoc["chart"]>;
    const project = projectWith({ version: 1, chart });
    await useChartTrackDoc(project, 0, vi.fn()).commit(track as never);
    expect(lastWritten()).toEqual({ version: 1, chart: { ...chart, track } });
    expect(lastEntry()?.label).toBe("chart animation");
  });

  it("compare track: materialises a minimal document for a doc-less scene", async () => {
    const onDocChanged = vi.fn();
    await useCompareTrackDoc(projectWith(undefined), 0, onDocChanged).commit(track as never);
    expect(lastWritten()).toEqual({ version: 1, compare: { track } });
    expect(onDocChanged).toHaveBeenCalledWith(0, lastWritten(), FILE, "ws:demo");
    expect(lastEntry()?.changes[0]).toMatchObject({ before: null });
  });

  it("lighting track: the scene target merges into lighting, the after target into compare.b", async () => {
    const project = projectWith({ version: 1, lighting: { ambient: 0.4 } });
    await useLightingTrackDoc(project, 0, "scene", vi.fn()).commit(track as never);
    expect(lastWritten()).toEqual({ version: 1, lighting: { ambient: 0.4, ...track } });
    expect(lastEntry()?.label).toBe("lighting animation");

    await useLightingTrackDoc(project, 0, "compareB", vi.fn()).commit(track as never);
    expect(lastWritten()).toEqual({
      version: 1,
      lighting: { ambient: 0.4 },
      compare: { b: { lighting: track } },
    });
    expect(lastEntry()?.label).toBe("comparison lighting animation");
  });

  it("camera: writes the orbit block and omits the empty rig and mode", async () => {
    const onDocChanged = vi.fn();
    const camera = { keys: [{ id: "k1", tMs: 0, pose: defaultOrbitPose() }], segments: [] };
    await useCameraDoc(projectWith({ version: 1 }), 0, onDocChanged).commit(camera);
    expect(lastWritten()).toEqual({ version: 1, camera });
    expect(onDocChanged).toHaveBeenCalledWith(0, lastWritten(), FILE, "ws:demo");
    expect(lastEntry()?.label).toBe("camera edit");
  });

  it("gizmo: the drag baseline is the undo before while the write keeps a neighbour's edit", async () => {
    const base: SceneDoc = { version: 1, name: "start" };
    const project = projectWith({ version: 1, name: "start", compare: { value: 0.3 } });
    const onDocChanged = vi.fn();
    const gizmo = useGizmoDocWrite(project, 0, onDocChanged);
    gizmo.preview(base, (next) => {
      next.name = "dragging";
    });
    expect(onDocChanged).toHaveBeenLastCalledWith(
      0,
      { version: 1, name: "dragging" },
      FILE,
      "ws:demo",
    );
    await gizmo.commit(
      base,
      (next) => {
        next.name = "dropped";
      },
      "move",
    );
    expect(lastWritten()).toEqual({ version: 1, name: "dropped", compare: { value: 0.3 } });
    expect(lastEntry()).toMatchObject({
      label: "move",
      changes: [{ before: base, after: { version: 1, name: "dropped", compare: { value: 0.3 } } }],
    });
  });

  it("layered screenshot: writes the block", async () => {
    const block = emptyLayeredScreenshot();
    await useLayeredScreenshotDoc(projectWith({ version: 1 }), 0, vi.fn()).commit(block);
    expect(lastWritten()).toEqual({ version: 1, layeredScreenshot: block });
    expect(lastEntry()?.label).toBe("layered screenshot edit");
  });

  it("two writers on one scene keep both edits", async () => {
    const release: Array<() => void> = [];
    mocks.writeSceneDoc.mockImplementation(
      () => new Promise<void>((resolve) => release.push(resolve)),
    );
    const project = projectWith({ version: 1 });
    const device = useDeviceTrackDoc(project, 0, vi.fn()).commit(track as never);
    const divider = useCompareTrackDoc(project, 0, vi.fn()).commit(track as never);
    let released = 0;
    while (released < 2) {
      if (release.length) {
        release.shift()?.();
        released += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await settleSceneDocPatches();
    await Promise.all([device, divider]);
    expect(mocks.writeSceneDoc).toHaveBeenCalledTimes(2);
    expect(lastWritten()).toEqual({ version: 1, deviceTrack: track, compare: { track } });
  });
});
