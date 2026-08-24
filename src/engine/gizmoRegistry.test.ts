import { Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, PlaneGeometry } from "three";
import { afterEach, describe, expect, it } from "vitest";
import { type CanvasHandle, canvasHandle } from "./exportBridge";
import {
  type GizmoPickerHandle,
  gizmoHandleAt,
  gizmoPickerHandles,
  hasGizmoPickers,
  hideGizmoHandles,
  registerGizmoPicker,
  subscribeGizmoPickers,
  unregisterGizmoPicker,
} from "./gizmoRegistry";

const handle = (itemId: string): GizmoPickerHandle => ({
  domain: "objects",
  itemId,
  sceneIndex: 0,
  pickers: () => [],
});

/** A 2x2 quad at the origin, filling the middle of the test camera's view. */
function quad(): Mesh {
  const mesh = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial());
  mesh.updateMatrixWorld();
  return mesh;
}

function stageCamera(): CanvasHandle {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return { camera } as unknown as CanvasHandle;
}

afterEach(() => {
  canvasHandle.current = null;
});

describe("subscribeGizmoPickers", () => {
  it("fires on register and unregister, so a parked pointer's hover truth can be re-tested", () => {
    const seen: number[] = [];
    const off = subscribeGizmoPickers(() => seen.push(gizmoPickerHandles().length));
    registerGizmoPicker("k1", handle("o1"));
    registerGizmoPicker("k1", handle("o1"));
    unregisterGizmoPicker("k1");
    off();
    expect(seen).toEqual([1, 1, 0]);
  });

  it("stays quiet for an unregister that removes nothing, and after unsubscribing", () => {
    let fired = 0;
    const off = subscribeGizmoPickers(() => {
      fired += 1;
    });
    unregisterGizmoPicker("gone");
    expect(fired).toBe(0);
    off();
    registerGizmoPicker("k2", handle("o2"));
    unregisterGizmoPicker("k2");
    expect(fired).toBe(0);
  });
});

describe("hasGizmoPickers", () => {
  it("answers per domain, so a 2D layer can skip the raycast when its own family has no gizmo", () => {
    expect(hasGizmoPickers()).toBe(false);
    registerGizmoPicker("k5", { ...handle("o5"), domain: "media" });
    expect([hasGizmoPickers(), hasGizmoPickers("media"), hasGizmoPickers("text")]).toEqual([
      true,
      true,
      false,
    ]);
    unregisterGizmoPicker("k5");
    expect(hasGizmoPickers("media")).toBe(false);
  });
});

describe("gizmoHandleAt", () => {
  it("returns only a handle of the asked-for domain, so a 2D layer never yields to another family", () => {
    canvasHandle.current = stageCamera();
    const media = quad();
    const text = quad();
    registerGizmoPicker("k6", { ...handle("m1"), domain: "media", pickers: () => [media] });
    registerGizmoPicker("k7", { ...handle("t1"), domain: "text", pickers: () => [text] });
    expect(gizmoHandleAt(0, 0, "media")?.itemId).toBe("m1");
    expect(gizmoHandleAt(0, 0, "text")?.itemId).toBe("t1");
    expect(gizmoHandleAt(0, 0)).not.toBeNull();
    expect(gizmoHandleAt(0, 0, "devices")).toBeNull();
    // Off the geometry nothing is claimed, so a box away from the handles still takes the press.
    expect(gizmoHandleAt(0.99, 0.99, "media")).toBeNull();
    unregisterGizmoPicker("k6");
    unregisterGizmoPicker("k7");
  });

  it("finds nothing without a live stage camera", () => {
    const media = quad();
    registerGizmoPicker("k8", { ...handle("m2"), domain: "media", pickers: () => [media] });
    expect(gizmoHandleAt(0, 0, "media")).toBeNull();
    unregisterGizmoPicker("k8");
  });
});

describe("hideGizmoHandles", () => {
  it("drops every mounted control for a capture frame and gives back what each one had", () => {
    const attached = new Object3D();
    const detached = new Object3D();
    detached.visible = false;
    registerGizmoPicker("k3", { ...handle("o3"), root: () => attached });
    registerGizmoPicker("k4", { ...handle("o4"), root: () => detached });
    const restore = hideGizmoHandles();
    expect([attached.visible, detached.visible]).toEqual([false, false]);
    restore();
    expect([attached.visible, detached.visible]).toEqual([true, false]);
    unregisterGizmoPicker("k3");
    unregisterGizmoPicker("k4");
  });
});
