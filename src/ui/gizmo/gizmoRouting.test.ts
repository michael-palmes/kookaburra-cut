import { describe, expect, it } from "vitest";
import {
  cameraOverrideHeld,
  gizmoLayerClass,
  pointerNdc,
  type RouteInput,
  routeLayerPointer,
  routePointer,
} from "./gizmoRouting";
import type { ModifierState } from "./modifierKeys";

const route = (input: Partial<RouteInput>) =>
  routePointer({
    cameraArmed: false,
    overHandle: false,
    overrideHeld: false,
    gizmoLatched: false,
    cameraLatched: false,
    ...input,
  });

const mods = (held: Partial<ModifierState>): ModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...held,
});

const RECT = { left: 100, top: 50, width: 400, height: 200 };

describe("routePointer", () => {
  it("gives a camera drag in flight the pointer whatever else is true", () => {
    expect(route({ cameraLatched: true, gizmoLatched: true, overHandle: true })).toBe("camera");
  });

  it("gives a gizmo drag in flight the pointer once no camera drag runs", () => {
    expect(route({ gizmoLatched: true, cameraArmed: true, overHandle: false })).toBe("gizmo");
  });

  it("leaves the canvas owning the pointer when no tool is armed", () => {
    expect(route({ cameraArmed: false, overrideHeld: true, overHandle: false })).toBe("gizmo");
  });

  it("gives an armed tool the pointer while an override modifier is held, even over a handle", () => {
    expect(route({ cameraArmed: true, overrideHeld: true, overHandle: true })).toBe("camera");
  });

  it("yields to a handle under the pointer", () => {
    expect(route({ cameraArmed: true, overHandle: true })).toBe("gizmo");
  });

  it("keeps empty-area drags on the armed tool", () => {
    expect(route({ cameraArmed: true, overHandle: false })).toBe("camera");
  });

  it("lets a latch beat both hover and modifiers", () => {
    // A camera drag started on empty space keeps the pointer when it passes over a handle.
    expect(route({ cameraLatched: true, cameraArmed: true, overHandle: true })).toBe("camera");
    // A modifier pressed mid-drag never yanks an in-flight handle drag away.
    expect(route({ gizmoLatched: true, cameraArmed: true, overrideHeld: true })).toBe("gizmo");
  });
});

describe("routeLayerPointer", () => {
  it("hands the pointer to a same-domain 3D handle under it, so the layer above the canvas stands down", () => {
    expect(routeLayerPointer({ overSceneHandle: true, layerDragging: false })).toBe("scene-gizmo");
  });

  it("keeps every other pixel on the layer, so a box away from the handles still selects", () => {
    expect(routeLayerPointer({ overSceneHandle: false, layerDragging: false })).toBe("layer");
  });

  it("never changes owner mid-drag: a handle sliding under a live 2D drag cannot steal it", () => {
    expect(routeLayerPointer({ overSceneHandle: true, layerDragging: true })).toBe("layer");
  });
});

describe("cameraOverrideHeld", () => {
  it("is true for each of meta, ctrl and alt alone", () => {
    expect(cameraOverrideHeld(mods({ metaKey: true }))).toBe(true);
    expect(cameraOverrideHeld(mods({ ctrlKey: true }))).toBe(true);
    expect(cameraOverrideHeld(mods({ altKey: true }))).toBe(true);
  });

  it("ignores shift (the 2D rotate snap) and nothing held", () => {
    expect(cameraOverrideHeld(mods({ shiftKey: true }))).toBe(false);
    expect(cameraOverrideHeld(mods({}))).toBe(false);
  });
});

describe("pointerNdc", () => {
  it("maps the rect centre to the origin", () => {
    expect(pointerNdc(300, 150, RECT)).toEqual({ x: 0, y: 0 });
  });

  it("maps the corners to the NDC corners (y up)", () => {
    expect(pointerNdc(100, 50, RECT)).toEqual({ x: -1, y: 1 });
    expect(pointerNdc(500, 250, RECT)).toEqual({ x: 1, y: -1 });
  });

  it("returns null outside the rect", () => {
    expect(pointerNdc(99, 150, RECT)).toBeNull();
    expect(pointerNdc(300, 251, RECT)).toBeNull();
  });

  it("returns null for a degenerate rect rather than NaN", () => {
    expect(pointerNdc(100, 50, { left: 100, top: 50, width: 0, height: 200 })).toBeNull();
    expect(pointerNdc(100, 50, { left: 100, top: 50, width: 400, height: 0 })).toBeNull();
  });
});

describe("gizmoLayerClass", () => {
  it("builds the layer, override and host classes", () => {
    expect(gizmoLayerClass(false)).toBe("gizmo-layer");
    expect(gizmoLayerClass(true)).toBe("gizmo-layer camera-override");
    expect(gizmoLayerClass(false, "text-gizmo-layer")).toBe("gizmo-layer text-gizmo-layer");
    expect(gizmoLayerClass(true, "text-gizmo-layer")).toBe(
      "gizmo-layer camera-override text-gizmo-layer",
    );
  });

  it("adds the 3D-gizmo stand-down on its own and alongside the override", () => {
    expect(gizmoLayerClass(false, undefined, true)).toBe("gizmo-layer scene-gizmo-yield");
    expect(gizmoLayerClass(false, "dragging-rotate", false)).toBe("gizmo-layer dragging-rotate");
    expect(gizmoLayerClass(true, "dragging-rotate", true)).toBe(
      "gizmo-layer camera-override scene-gizmo-yield dragging-rotate",
    );
  });
});
