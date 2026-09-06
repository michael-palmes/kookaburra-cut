import { Group, PerspectiveCamera, Vector3 } from "three";
import { assert, describe, expect, it } from "vitest";
import { projectWorldPoint } from "./gizmo2dProject";
import { screenshotStackFrame, screenshotStackPlacementWrite } from "./layeredScreenshotGizmoMath";

const rect = { left: 120, top: 80, width: 800, height: 450 };
const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 100);
camera.position.z = 8;
camera.updateMatrixWorld();
const corners = [-1, 1].flatMap((x) =>
  [-1, 1].flatMap((y) => [0, 1.5].map((z): [number, number, number] => [x * 2, y, z])),
);

describe("screenshot stack gizmo", () => {
  it("encloses every projected layer corner after roll and scale", () => {
    const node = new Group();
    node.position.set(0.7, -0.3, 0);
    node.rotation.z = -Math.PI / 6;
    node.scale.setScalar(0.6);
    const frame = screenshotStackFrame(node, corners, camera, rect);
    assert(frame);
    expect(frame.deg).toBeCloseTo(30);
    expect(frame.pivot[0]).toBeGreaterThan(rect.left + rect.width / 2);
    const angle = (frame.deg * Math.PI) / 180;
    for (const point of corners) {
      const [x, y] = projectWorldPoint(
        camera,
        rect,
        new Vector3(...point).applyMatrix4(node.matrixWorld),
      );
      const dx = x - frame.cx;
      const dy = y - frame.cy;
      expect(Math.abs(Math.cos(angle) * dx + Math.sin(angle) * dy)).toBeLessThanOrEqual(
        frame.w / 2 + 1e-8,
      );
      expect(Math.abs(-Math.sin(angle) * dx + Math.cos(angle) * dy)).toBeLessThanOrEqual(
        frame.h / 2 + 1e-8,
      );
    }
  });

  it("includes depth and follows a changed camera and cutout viewport", () => {
    const node = new Group();
    const flat = screenshotStackFrame(
      node,
      corners.filter((p) => p[2] === 0),
      camera,
      rect,
    );
    const deep = screenshotStackFrame(node, corners, camera, rect);
    assert(flat && deep);
    expect(deep.w).toBeGreaterThan(flat.w);
    expect(deep.h).toBeGreaterThan(flat.h);
    const movedCamera = camera.clone();
    movedCamera.position.x = 1;
    movedCamera.updateMatrixWorld();
    const moved = screenshotStackFrame(node, corners, movedCamera, {
      ...rect,
      width: 400,
      height: 225,
    });
    assert(moved);
    expect(moved.w).toBeLessThan(deep.w);
    expect(moved.pivot[0]).toBeLessThan(rect.left + 200);
    expect(screenshotStackFrame(node, [], camera, rect)).toBeNull();
  });

  it("rounds and clamps drag writes to the inspector range, wrapping full turns", () => {
    expect(
      screenshotStackPlacementWrite({ position: [0.1234, -4], size: 12, rotationDeg: 390.12 }),
    ).toEqual({ position: [0.12, -1], size: 3, rotationDeg: 30.1 });
    expect(
      screenshotStackPlacementWrite({ position: [0, 0], size: 0.001, rotationDeg: -390 }),
    ).toEqual({ position: [0, 0], size: 0.05, rotationDeg: -30 });
  });
});
