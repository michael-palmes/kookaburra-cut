import { renderToStaticMarkup } from "react-dom/server";
import { Group, PerspectiveCamera } from "three";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { CAMERA, FORMATS } from "../engine/format";
import { registerGizmoTarget, unregisterGizmoTarget } from "../engine/gizmoTargetRegistry";
import { bindHistory, peekUndo, takeUndo } from "../engine/history";
import { useLayeredScreenshotEditStore } from "../engine/layeredScreenshotEditStore";
import type { LoadedProject } from "../engine/project";
import { writeSceneDoc } from "../engine/sceneDoc";
import type { SceneDoc, SceneDocLayeredScreenshot } from "../engine/sceneDocSchema";
import { defaultLayeredScreenshotPose } from "../engine/sceneLayeredScreenshot";
import { useEditorStore } from "../store/editorStore";
import type { Gizmo2DGesture, Gizmo2DProps } from "./gizmo/Gizmo2D";
import { LayeredScreenshotGizmo } from "./LayeredScreenshotGizmo";

const host = vi.hoisted(() => ({ props: null as Gizmo2DProps | null, camera: vi.fn() }));
vi.mock("react", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const useSyncExternalStore = (_subscribe: unknown, snapshot: () => unknown) => snapshot();
  return { ...react, useSyncExternalStore, default: { ...react, useSyncExternalStore } };
});
vi.mock("./gizmo/Gizmo2D", () => ({
  Gizmo2D: (props: Gizmo2DProps) => {
    host.props = props;
    return null;
  },
}));
vi.mock("../engine/gizmoRegistry", async () => ({
  ...(await vi.importActual<typeof import("../engine/gizmoRegistry")>("../engine/gizmoRegistry")),
  stageCamera: host.camera,
}));
vi.mock("../engine/sceneDoc", async () => ({
  ...(await vi.importActual<typeof import("../engine/sceneDoc")>("../engine/sceneDoc")),
  writeSceneDoc: vi.fn().mockResolvedValue(undefined),
}));

const rect = { left: 100, top: 50, width: 800, height: 450 };
const sceneFile = "scenes/01-stack.tsx";
const pose = defaultLayeredScreenshotPose();
const block: SceneDocLayeredScreenshot = {
  layers: [
    {
      id: "l1",
      visible: true,
      z: 0,
      items: [{ id: "i1", kind: "screen", media: "image", src: "assets/screen.jpg", attach: null }],
    },
  ],
  pose,
  animation: { keys: [{ id: "k1", tMs: 0, pose }], segments: [] },
};
const doc: SceneDoc = {
  version: 1,
  layeredScreenshot: block,
  animatedTrack: "layeredScreenshot",
  text: { title: "Keep this" },
};
const project = {
  id: "ws:screenshot-gizmo",
  sceneDocs: [doc],
  sceneFiles: [sceneFile],
  sceneFrames: [undefined],
} as LoadedProject;
const changed = vi.fn();
const move = (dxPx: number): Gizmo2DGesture => ({
  kind: "move",
  id: "layeredScreenshot",
  rect,
  dxPx,
  dyPx: -45,
});

beforeEach(() => {
  vi.clearAllMocks();
  useLayeredScreenshotEditStore.getState().reset();
  useLayeredScreenshotEditStore.getState().selectStack({ sceneIndex: 0 });
  useEditorStore.setState({ format: FORMATS["16:9"], playing: true });
  bindHistory(null);
  bindHistory(project.id);
  const camera = new PerspectiveCamera(CAMERA.fov, 16 / 9, 0.1, 100);
  camera.position.set(...CAMERA.position);
  camera.updateMatrixWorld();
  host.camera.mockReturnValue(camera);
  const node = new Group();
  registerGizmoTarget("test-stack", {
    domain: "layeredScreenshot",
    itemId: "layeredScreenshot",
    sceneIndex: 0,
    node: () => node,
    localRect: () => null,
    localPoints: () => [
      [-1, -1, 0],
      [1, 1, 0],
    ],
  });
  renderToStaticMarkup(
    <LayeredScreenshotGizmo project={project} sceneIndex={0} onDocChanged={changed} />,
  );
});
afterEach(() => {
  unregisterGizmoTarget("test-stack");
  useLayeredScreenshotEditStore.getState().reset();
  bindHistory(null);
});

describe("Screenshot stack gestures", () => {
  it("previews in the shared draft, then saves once with the original undo baseline", async () => {
    const gizmo = host.props;
    assert(gizmo);
    gizmo.onGesture(move(40));
    gizmo.onGesture(move(80));
    expect(writeSceneDoc).not.toHaveBeenCalled();
    expect(peekUndo()).toBeNull();
    expect(useEditorStore.getState().playing).toBe(false);
    expect(useLayeredScreenshotEditStore.getState().draft?.block?.placement?.position).toEqual([
      0.2, 0.2,
    ]);
    gizmo.onGestureEnd(move(80));
    await vi.waitFor(() => expect(peekUndo()).not.toBeNull());
    expect(writeSceneDoc).toHaveBeenCalledTimes(1);
    const written = vi.mocked(writeSceneDoc).mock.calls[0][2];
    expect(written.layeredScreenshot?.placement?.position).toEqual([0.2, 0.2]);
    expect(written.layeredScreenshot?.animation).toEqual(block.animation);
    expect(written.text).toEqual(doc.text);
    expect(changed).toHaveBeenCalledWith(0, written, sceneFile, project.id);
    expect(takeUndo()?.changes[0]).toMatchObject({ before: doc, after: written });
    expect(takeUndo()).toBeNull();
  });

  it.each([
    [
      {
        kind: "resize",
        id: "layeredScreenshot",
        rect,
        factor: 0.6,
        fixedPx: [0, 0],
        diagPx: [1, 1],
      },
      { size: 0.6 },
    ],
    [{ kind: "rotate", id: "layeredScreenshot", rect, deg0: 12, deg: 42 }, { rotationDeg: 30 }],
  ] as const)("saves a %j gesture without editing animation keys", async (gesture, expected) => {
    const gizmo = host.props;
    assert(gizmo);
    gizmo.onGesture(gesture);
    gizmo.onGestureEnd(gesture);
    await vi.waitFor(() => expect(peekUndo()).not.toBeNull());
    const written = vi.mocked(writeSceneDoc).mock.calls[0][2];
    expect(written.layeredScreenshot?.placement).toMatchObject(expected);
    expect(written.layeredScreenshot?.pose).toEqual(block.pose);
    expect(written.layeredScreenshot?.animation).toEqual(block.animation);
  });

  it("selects without saving when a press does not move", () => {
    const gizmo = host.props;
    assert(gizmo);
    gizmo.onSelect(null);
    expect(useLayeredScreenshotEditStore.getState().selectedStack).toBeNull();
    gizmo.onSelect("layeredScreenshot");
    expect(useLayeredScreenshotEditStore.getState().selectedStack).toEqual({ sceneIndex: 0 });
    gizmo.onGestureEnd(null);
    expect(writeSceneDoc).not.toHaveBeenCalled();
    expect(peekUndo()).toBeNull();
  });
});
